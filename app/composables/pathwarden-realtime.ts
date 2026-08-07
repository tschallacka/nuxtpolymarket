import {
    decodePacket,
    decodeCompound,
    encodeHello,
    encodeInputCommand,
    PathwardenPacketKind,
    type PathwardenInputCommand,
    type PathwardenWorldSnapshot,
    type PathwardenEntityState,
    type PathwardenGameplayEvent
} from '#shared/pathwarden/protocol'
import {
    getPathwardenDebugLog,
    pathwardenPacketMetadata,
    type PathwardenDebugQuery,
    type PathwardenDebugQueryResult
} from '#shared/pathwarden/debug-log'
import type { PathwardenMapPlan } from '#shared/types/pathwarden-save'
import { predictPathwardenSnapshot } from '#shared/pathwarden/prediction'

export type PathwardenRealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface PathwardenPredictionState {
    snapshot: PathwardenWorldSnapshot | null
    pendingInputs: number
    lastAcknowledgedInput: number
    corrections: number
    predictionAgeMs: number
}

export function usePathwardenRealtime() {
    const debugLog = import.meta.dev ? getPathwardenDebugLog('client') : null
    const status = ref<PathwardenRealtimeStatus>('disconnected')
    const snapshot = ref<PathwardenWorldSnapshot | null>(null)
    const mapPlan = ref<PathwardenMapPlan | null>(null)
    const entities = ref<PathwardenEntityState[]>([])
    const events = ref<PathwardenGameplayEvent[]>([])
    const receivedEventIds = new Set<number>()
    const choiceOffer = ref<{ kind: 'checkpoint' | 'relic' | 'path', choices: number[], choiceKeys?: string[], offerRevision: number } | null>(null)
    const mapChunks = new Map<number, Uint8Array>()
    let expectedMapChunks = 0
    const predictedSnapshot = ref<PathwardenWorldSnapshot | null>(null)
    const lastError = ref<string | null>(null)
    const lastAcknowledgedInput = ref(0)
    const corrections = ref(0)
    const roundTripLatencyMs = ref(0)
    const maxTickGap = ref(0)
    const staleSnapshots = ref(0)
    const predictionAgeMs = ref(0)
    const pending = new Map<number, PathwardenInputCommand>()
    const sentAt = new Map<number, number>()
    let socket: WebSocket | null = null
    let nextInputSequence = 1
    let activeRunId: string | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let intentionalClose = false
    let lastResyncAt = 0
    let awaitingInitialSnapshot = true

    function recordDebug(event: string, fields: Record<string, unknown> = {}) {
        debugLog?.record(event, fields)
    }

    function requestResync(reason: string) {
        const now = Date.now()
        if (!socket || socket.readyState !== WebSocket.OPEN || now - lastResyncAt < 5000) return
        lastResyncAt = now
        lastError.value = `Pathwarden state resync requested: ${reason}`
        socket.close(4008, 'Pathwarden state resync')
    }

    function reconcile(serverSnapshot: PathwardenWorldSnapshot) {
        predictedSnapshot.value = predictPathwardenSnapshot(serverSnapshot, pending.values())
        updatePredictionAge()
    }

    function updatePredictionAge() {
        const oldest = [...sentAt.values()].sort((left, right) => left - right)[0]
        predictionAgeMs.value = oldest === undefined ? 0 : Math.max(0, Date.now() - oldest)
    }

    async function handlePacket(event: MessageEvent) {
        try {
            // Node-based Nuxt development transport may expose binary frames
            // as Blob objects, while the production adapter gives us an
            // ArrayBuffer. Normalize both before decoding the compact packet.
            const payload = event.data instanceof Blob
                ? await event.data.arrayBuffer()
                : event.data as ArrayBuffer
            if (!(payload instanceof ArrayBuffer)) return
            const bytes = new Uint8Array(payload)
            // The Nuxt development websocket adapter can expose its six-byte
            // frame prefix to the browser as well as to the server handler.
            const payloadOffset = bytes[0] === 0x50 ? 0 : bytes[6] === 0x50 ? 6 : 0
            const normalizedBytes = new Uint8Array(bytes.byteLength - payloadOffset)
            normalizedBytes.set(bytes.subarray(payloadOffset))
            const normalizedPayload = normalizedBytes.buffer
            if (normalizedPayload instanceof ArrayBuffer) {
                recordDebug('packet.received', {
                    direction: 'in',
                    ...pathwardenPacketMetadata(normalizedPayload)
                })
            }
            if (new Uint8Array(normalizedPayload)[0] !== 0x50) return
            const packet = decodePacket(normalizedPayload)
            status.value = 'connected'
            if (lastError.value === 'Invalid Pathwarden packet magic') lastError.value = null
            recordDebug('packet.decoded', {
                direction: 'in',
                packetKind: pathwardenPacketMetadata(normalizedPayload).packetKind,
                packetKindCode: packet.header.kind,
                packetSequence: packet.header.sequence,
                tick: packet.header.tick,
                acknowledgedInput: packet.header.acknowledgedInput
            })
            if (packet.header.kind === PathwardenPacketKind.FullSnapshot) {
                const decoded = packet.payload as PathwardenWorldSnapshot
                const next = packet.header.flags & 1
                    ? {
                        ...decoded,
                        claimedRoomIds: snapshot.value?.claimedRoomIds ?? [],
                        revealedCells: snapshot.value?.revealedCells ?? []
                    }
                    : decoded
                const wasDifferent = snapshot.value && (snapshot.value.tick > next.tick || snapshot.value.phase !== next.phase || snapshot.value.wave !== next.wave)
                if (wasDifferent) corrections.value += 1
                if (awaitingInitialSnapshot) {
                    awaitingInitialSnapshot = false
                } else if (snapshot.value) {
                    const tickGap = next.tick - snapshot.value.tick
                    if (tickGap < 0) {
                        staleSnapshots.value += 1
                        if (staleSnapshots.value >= 3) requestResync('stale snapshots')
                        return
                    } else {
                        maxTickGap.value = Math.max(maxTickGap.value, tickGap)
                        if (tickGap > 100) requestResync('client fell behind')
                    }
                }
                snapshot.value = next
                const expectedChoiceKind = next.phase === 'checkpoint'
                    ? 'checkpoint'
                    : next.phase === 'path'
                        ? 'path'
                        : next.phase === 'upgrade' ? 'relic' : null
                if (!expectedChoiceKind || choiceOffer.value?.kind !== expectedChoiceKind) choiceOffer.value = null
                lastAcknowledgedInput.value = Math.max(lastAcknowledgedInput.value, packet.header.acknowledgedInput)
                nextInputSequence = Math.max(nextInputSequence, packet.header.acknowledgedInput + 1)
                for (const inputSequence of pending.keys()) {
                    if (inputSequence <= packet.header.acknowledgedInput) {
                        pending.delete(inputSequence)
                        const startedAt = sentAt.get(inputSequence)
                        if (startedAt !== undefined) {
                            roundTripLatencyMs.value = Math.round((roundTripLatencyMs.value * 3 + (Date.now() - startedAt)) / 4)
                            sentAt.delete(inputSequence)
                        }
                    }
                }
                updatePredictionAge()
                reconcile(next)
                return
            }
            if (packet.header.kind === PathwardenPacketKind.EntitySnapshot) {
                entities.value = packet.payload as PathwardenEntityState[]
                return
            }
            if (packet.header.kind === PathwardenPacketKind.GameplayEvent) {
                const event = packet.payload as PathwardenGameplayEvent
                if (receivedEventIds.has(event.id)) return
                receivedEventIds.add(event.id)
                if (receivedEventIds.size > 2048) {
                    const oldest = receivedEventIds.values().next().value
                    if (oldest !== undefined) receivedEventIds.delete(oldest)
                }
                events.value = [...events.value, event].slice(-64)
                return
            }
            if (packet.header.kind === PathwardenPacketKind.EntityDelta) {
                const delta = packet.payload as { upserts: PathwardenEntityState[], removed: number[] }
                const next = new Map(entities.value.map(entity => [entity.id, entity]))
                for (const id of delta.removed) next.delete(id)
                for (const entity of delta.upserts) next.set(entity.id, entity)
                entities.value = [...next.values()]
                return
            }
            if (packet.header.kind === PathwardenPacketKind.MapStateDelta) {
                const delta = packet.payload as { claimedRoomIds: string[], revealedCells: Array<{ col: number, row: number }> }
                if (snapshot.value) {
                    const claimedRoomIds = [...new Set([...snapshot.value.claimedRoomIds, ...delta.claimedRoomIds])]
                    const revealed = new Map(snapshot.value.revealedCells.map(cell => [`${cell.col}:${cell.row}`, cell]))
                    for (const cell of delta.revealedCells) revealed.set(`${cell.col}:${cell.row}`, cell)
                    snapshot.value = { ...snapshot.value, claimedRoomIds, revealedCells: [...revealed.values()] }
                    reconcile(snapshot.value)
                }
                return
            }
            if (packet.header.kind === PathwardenPacketKind.ChoiceOffer) {
                choiceOffer.value = packet.payload as { kind: 'checkpoint' | 'relic' | 'path', choices: number[], offerRevision: number }
                return
            }
            if (packet.header.kind === PathwardenPacketKind.MapSnapshot) {
                mapPlan.value = packet.payload as PathwardenMapPlan
                return
            }
            if (packet.header.kind === PathwardenPacketKind.MapSnapshotChunk) {
                const chunk = packet.payload as { chunkIndex: number, chunkCount: number, bytes: Uint8Array }
                expectedMapChunks = chunk.chunkCount
                mapChunks.set(chunk.chunkIndex, chunk.bytes)
                if (mapChunks.size === expectedMapChunks) {
                    const bytes = new Uint8Array([...Array.from(mapChunks.keys()).sort((a, b) => a - b)].reduce((total, index) => total + mapChunks.get(index)!.byteLength, 0))
                    let offset = 0
                    for (let index = 0; index < expectedMapChunks; index++) {
                        const part = mapChunks.get(index)!
                        bytes.set(part, offset)
                        offset += part.byteLength
                    }
                    mapPlan.value = decodeCompound(bytes) as PathwardenMapPlan
                    mapChunks.clear()
                    expectedMapChunks = 0
                }
                return
            }
            if (packet.header.kind === PathwardenPacketKind.CommandAck || packet.header.kind === PathwardenPacketKind.CommandReject) {
                const payload = packet.payload as { inputSequence?: number, accepted?: boolean, reason?: string } | null
                const inputSequence = payload?.inputSequence ?? packet.header.acknowledgedInput
                pending.delete(inputSequence)
                const startedAt = sentAt.get(inputSequence)
                if (startedAt !== undefined) {
                    roundTripLatencyMs.value = Math.round((roundTripLatencyMs.value * 3 + (Date.now() - startedAt)) / 4)
                    sentAt.delete(inputSequence)
                }
                lastAcknowledgedInput.value = Math.max(lastAcknowledgedInput.value, inputSequence)
                nextInputSequence = Math.max(nextInputSequence, inputSequence + 1)
                updatePredictionAge()
                if (payload?.accepted) lastError.value = null
                else if (payload?.reason) lastError.value = payload.reason
                recordDebug(payload?.accepted ? 'command.acknowledged' : 'command.rejected', {
                    inputSequence,
                    accepted: payload?.accepted ?? false,
                    reason: payload?.reason
                })
                if (snapshot.value) reconcile(snapshot.value)
                return
            }
            if (packet.header.kind === PathwardenPacketKind.ProtocolError) {
                lastError.value = String((packet.payload as { message?: string } | null)?.message ?? 'Pathwarden protocol error')
                status.value = 'error'
            }
        } catch (error) {
            lastError.value = error instanceof Error ? error.message : 'Invalid Pathwarden packet'
            status.value = 'error'
            recordDebug('packet.decode_error', { error: lastError.value })
        }
    }

    function close() {
        intentionalClose = true
        activeRunId = null
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = null
        socket?.close(1000, 'Pathwarden view closed')
        socket = null
        status.value = 'disconnected'
        pending.clear()
        sentAt.clear()
        updatePredictionAge()
        awaitingInitialSnapshot = true
        snapshot.value = null
        mapPlan.value = null
        entities.value = []
        events.value = []
        receivedEventIds.clear()
        choiceOffer.value = null
        mapChunks.clear()
        expectedMapChunks = 0
        predictedSnapshot.value = null
    }

    function connect(runId: string) {
        if (!import.meta.client || !runId) return
        if (activeRunId === runId && (socket || reconnectTimer)) return
        close()
        activeRunId = runId
        intentionalClose = false
        const open = () => {
            if (!activeRunId || activeRunId !== runId) return
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            socket = new WebSocket(`${protocol}//${window.location.host}/api/pathwarden/ws?runId=${encodeURIComponent(runId)}`)
            socket.binaryType = 'arraybuffer'
            status.value = 'connecting'
            lastError.value = null
            recordDebug('socket.connecting', { runId })
            socket.onopen = () => {
                status.value = 'connected'
                awaitingInitialSnapshot = true
                recordDebug('socket.open', { runId })
                const hello = encodeHello()
                recordDebug('packet.sent', { direction: 'out', ...pathwardenPacketMetadata(hello) })
                socket?.send(hello)
                for (const [inputSequence, command] of pending) {
                    sentAt.set(inputSequence, Date.now())
                    const payload = encodeInputCommand(inputSequence, command, snapshot.value?.tick ?? 0)
                    recordDebug('command.sent', {
                        inputSequence,
                        commandType: command.type,
                        command,
                        ...pathwardenPacketMetadata(payload)
                    })
                    socket?.send(payload)
                }
            }
            socket.onmessage = handlePacket
            socket.onerror = () => {
                status.value = 'error'
                lastError.value = 'Pathwarden gameplay connection failed'
                recordDebug('socket.error', { runId, error: lastError.value })
            }
            socket.onclose = event => {
                socket = null
                recordDebug('socket.close', { runId, intentional: intentionalClose, code: event.code, reason: event.reason })
                if (!intentionalClose && activeRunId === runId) {
                    lastError.value = `Pathwarden socket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`
                    awaitingInitialSnapshot = true
                    status.value = 'connecting'
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null
                        open()
                    }, 1000)
                } else if (status.value !== 'error') {
                    status.value = 'disconnected'
                }
            }
        }
        open()
    }

    function send(command: PathwardenInputCommand) {
        const inputSequence = nextInputSequence++
        pending.set(inputSequence, command)
        sentAt.set(inputSequence, Date.now())
        updatePredictionAge()
        if (predictedSnapshot.value) reconcile(predictedSnapshot.value)
        if (socket?.readyState === WebSocket.OPEN) {
            const payload = encodeInputCommand(inputSequence, command, snapshot.value?.tick ?? 0)
            recordDebug('command.sent', {
                inputSequence,
                commandType: command.type,
                command,
                ...pathwardenPacketMetadata(payload)
            })
            socket.send(payload)
        } else {
            recordDebug('command.queued_offline', { inputSequence, commandType: command.type, command })
        }
        return inputSequence
    }

    async function queryDebugLog(options: PathwardenDebugQuery = {}, side: 'both' | 'client' | 'server' = 'both') {
        const empty: PathwardenDebugQueryResult = {
            entries: [],
            total: 0,
            returned: 0,
            nextBefore: null,
            nextAfter: null
        }
        const client = side === 'server' ? empty : debugLog?.query(options) ?? empty
        const server = side === 'client'
            ? empty
            : await $fetch<PathwardenDebugQueryResult>('/api/pathwarden/debug-log', {
                query: {
                    filter: options.filter,
                    select: options.select,
                    limit: options.limit,
                    before: options.before,
                    after: options.after,
                    saved: options.saved
                }
            })
        return { client, server }
    }

    function scrollDebugLog(options: PathwardenDebugQuery = {}, side: 'both' | 'client' | 'server' = 'both') {
        return queryDebugLog(options, side)
    }

    async function saveDebugLog(name: string, options: PathwardenDebugQuery = {}, side: 'both' | 'client' | 'server' = 'both') {
        const client = side === 'server' ? null : debugLog?.save(name, options) ?? null
        const server = side === 'client'
            ? null
            : await $fetch('/api/pathwarden/debug-log', {
                method: 'POST',
                body: { action: 'save', name, ...options }
            })
        return { client, server }
    }

    async function listSavedDebugLog(side: 'both' | 'client' | 'server' = 'both') {
        const client = side === 'server' ? [] : debugLog?.listSaved() ?? []
        const server = side === 'client'
            ? []
            : (await $fetch<{ savedSegments: unknown[] }>('/api/pathwarden/debug-log', {
                method: 'POST',
                body: { action: 'list' }
            })).savedSegments
        return { client, server }
    }

    async function deleteSavedDebugLog(name: string, side: 'both' | 'client' | 'server' = 'both') {
        const client = side === 'server' ? false : debugLog?.deleteSaved(name) ?? false
        const server = side === 'client'
            ? false
            : (await $fetch<{ deleted: boolean }>('/api/pathwarden/debug-log', {
                method: 'POST',
                body: { action: 'delete', name }
            })).deleted
        return { client, server }
    }

    function clearSavedDebugLog() {
        debugLog?.clearSaved()
    }

    async function clearDebugLog() {
        debugLog?.clear()
        if (import.meta.dev) await $fetch('/api/pathwarden/debug-log', { method: 'DELETE' })
    }

    if (import.meta.dev) {
        const globals = globalThis as typeof globalThis & {
            __POLYNUX_PATHWARDEN_DEBUG__?: Record<string, unknown>
        }
        globals.__POLYNUX_PATHWARDEN_DEBUG__ = {
            query: queryDebugLog,
            scroll: scrollDebugLog,
            save: saveDebugLog,
            listSaved: listSavedDebugLog,
            deleteSaved: deleteSavedDebugLog,
            clear: clearDebugLog
        }
    }

    return {
        status: readonly(status),
        snapshot: readonly(snapshot),
        mapPlan: readonly(mapPlan),
        entities: readonly(entities),
        events: readonly(events),
        choiceOffer: readonly(choiceOffer),
        predictedSnapshot: readonly(predictedSnapshot),
        lastError: readonly(lastError),
        pendingInputs: computed(() => pending.size),
        lastAcknowledgedInput: readonly(lastAcknowledgedInput),
        corrections: readonly(corrections),
        roundTripLatencyMs: readonly(roundTripLatencyMs),
        maxTickGap: readonly(maxTickGap),
        staleSnapshots: readonly(staleSnapshots),
        predictionAgeMs: readonly(predictionAgeMs),
        connect,
        send,
        queryDebugLog,
        scrollDebugLog,
        saveDebugLog,
        listSavedDebugLog,
        deleteSavedDebugLog,
        clearSavedDebugLog,
        clearDebugLog,
        close
    }
}
