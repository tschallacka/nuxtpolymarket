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
import type { PathwardenMapPlan } from '#shared/types/pathwarden-save'

export type PathwardenRealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface PathwardenPredictionState {
    snapshot: PathwardenWorldSnapshot | null
    pendingInputs: number
    lastAcknowledgedInput: number
    corrections: number
}

export function usePathwardenRealtime() {
    const status = ref<PathwardenRealtimeStatus>('disconnected')
    const snapshot = ref<PathwardenWorldSnapshot | null>(null)
    const mapPlan = ref<PathwardenMapPlan | null>(null)
    const entities = ref<PathwardenEntityState[]>([])
    const events = ref<PathwardenGameplayEvent[]>([])
    const receivedEventIds = new Set<number>()
    const choiceOffer = ref<{ kind: 'checkpoint' | 'relic' | 'path', choices: number[], offerRevision: number } | null>(null)
    const mapChunks = new Map<number, Uint8Array>()
    let expectedMapChunks = 0
    const predictedSnapshot = ref<PathwardenWorldSnapshot | null>(null)
    const lastError = ref<string | null>(null)
    const lastAcknowledgedInput = ref(0)
    const corrections = ref(0)
    const roundTripLatencyMs = ref(0)
    const maxTickGap = ref(0)
    const staleSnapshots = ref(0)
    const pending = new Map<number, PathwardenInputCommand>()
    const sentAt = new Map<number, number>()
    let socket: WebSocket | null = null
    let nextInputSequence = 1
    let activeRunId: string | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let intentionalClose = false

    function reconcile(serverSnapshot: PathwardenWorldSnapshot) {
        const next = { ...serverSnapshot }
        for (const command of pending.values()) {
            if (command.type === 'pause' && !next.paused && command.value) next.paused = true
            if (command.type === 'pause' && next.paused && !command.value) next.paused = false
            if (command.type === 'start-wave' && next.phase === 'planning') {
                next.phase = 'wave'
                next.wave = Math.min(12, next.wave + 1)
            }
        }
        predictedSnapshot.value = next
    }

    function handlePacket(event: MessageEvent) {
        try {
            const packet = decodePacket(event.data as ArrayBuffer)
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
                if (snapshot.value) {
                    const tickGap = next.tick - snapshot.value.tick
                    if (tickGap < 0) staleSnapshots.value += 1
                    else maxTickGap.value = Math.max(maxTickGap.value, tickGap)
                }
                snapshot.value = next
                const expectedChoiceKind = next.phase === 'checkpoint'
                    ? 'checkpoint'
                    : next.phase === 'path'
                        ? 'path'
                        : next.phase === 'upgrade' ? 'relic' : null
                if (!expectedChoiceKind || choiceOffer.value?.kind !== expectedChoiceKind) choiceOffer.value = null
                lastAcknowledgedInput.value = Math.max(lastAcknowledgedInput.value, packet.header.acknowledgedInput)
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
                if (!payload?.accepted && payload?.reason) lastError.value = payload.reason
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
            socket.onopen = () => {
                status.value = 'connected'
                socket?.send(encodeHello())
                for (const [inputSequence, command] of pending) {
                    sentAt.set(inputSequence, Date.now())
                    socket?.send(encodeInputCommand(inputSequence, command, snapshot.value?.tick ?? 0))
                }
            }
            socket.onmessage = handlePacket
            socket.onerror = () => {
                status.value = 'error'
                lastError.value = 'Pathwarden gameplay connection failed'
            }
            socket.onclose = () => {
                socket = null
                if (!intentionalClose && activeRunId === runId) {
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
        if (predictedSnapshot.value) reconcile(predictedSnapshot.value)
        if (socket?.readyState === WebSocket.OPEN) socket.send(encodeInputCommand(inputSequence, command, snapshot.value?.tick ?? 0))
        return inputSequence
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
        connect,
        send,
        close
    }
}
