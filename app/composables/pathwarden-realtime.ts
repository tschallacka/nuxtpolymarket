import {
    decodePacket,
    decodeCompound,
    encodeHello,
    encodeInputCommand,
    PathwardenPacketKind,
    type PathwardenInputCommand,
    type PathwardenWorldSnapshot
} from '#shared/pathwarden/protocol'
import type { PathwardenMapPlan } from '#shared/types/pathwarden-save'
import type { PathwardenEntityState } from '#shared/pathwarden/protocol'

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
    const choiceOffer = ref<{ kind: 'checkpoint' | 'relic', choices: number[] } | null>(null)
    const mapChunks = new Map<number, Uint8Array>()
    let expectedMapChunks = 0
    const predictedSnapshot = ref<PathwardenWorldSnapshot | null>(null)
    const lastError = ref<string | null>(null)
    const lastAcknowledgedInput = ref(0)
    const corrections = ref(0)
    const pending = new Map<number, PathwardenInputCommand>()
    let socket: WebSocket | null = null
    let nextInputSequence = 1
    let activeRunId: string | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let intentionalClose = false

    function reconcile(serverSnapshot: PathwardenWorldSnapshot) {
        let next = { ...serverSnapshot }
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
                const next = packet.payload as PathwardenWorldSnapshot
                const wasDifferent = snapshot.value && (snapshot.value.tick > next.tick || snapshot.value.phase !== next.phase || snapshot.value.wave !== next.wave)
                if (wasDifferent) corrections.value += 1
                snapshot.value = next
                lastAcknowledgedInput.value = Math.max(lastAcknowledgedInput.value, packet.header.acknowledgedInput)
                for (const inputSequence of pending.keys()) {
                    if (inputSequence <= packet.header.acknowledgedInput) pending.delete(inputSequence)
                }
                reconcile(next)
                return
            }
            if (packet.header.kind === PathwardenPacketKind.EntitySnapshot) {
                entities.value = packet.payload as PathwardenEntityState[]
                return
            }
            if (packet.header.kind === PathwardenPacketKind.ChoiceOffer) {
                choiceOffer.value = packet.payload as { kind: 'checkpoint' | 'relic', choices: number[] }
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
        snapshot.value = null
        mapPlan.value = null
        entities.value = []
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
        if (predictedSnapshot.value) reconcile(predictedSnapshot.value)
        if (socket?.readyState === WebSocket.OPEN) socket.send(encodeInputCommand(inputSequence, command, snapshot.value?.tick ?? 0))
        return inputSequence
    }

    return {
        status: readonly(status),
        snapshot: readonly(snapshot),
        mapPlan: readonly(mapPlan),
        entities: readonly(entities),
        choiceOffer: readonly(choiceOffer),
        predictedSnapshot: readonly(predictedSnapshot),
        lastError: readonly(lastError),
        pendingInputs: computed(() => pending.size),
        lastAcknowledgedInput: readonly(lastAcknowledgedInput),
        corrections: readonly(corrections),
        connect,
        send,
        close
    }
}
