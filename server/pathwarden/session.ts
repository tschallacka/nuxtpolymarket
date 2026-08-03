import type { Peer } from 'crossws'
import { db } from '#server/database'
import { pathwardenRuns } from '#server/database/schema'
import { auth } from '#server/utils/auth'
import {
    decodePacket,
    encodeCommandAck,
    encodeHelloAck,
    encodeProtocolError,
    encodeWorldSnapshot,
    PathwardenPacketKind,
    type PathwardenInputCommand,
    type PathwardenWorldSnapshot
} from '#shared/pathwarden/protocol'

interface ActiveSession {
    peer: Peer
    userId: string
    runId: string
    nextPacketSequence: number
    lastInputSequence: number
    tick: number
    snapshot: PathwardenWorldSnapshot
}

const sessions = new Map<string, ActiveSession>()

function send(session: ActiveSession, payload: ArrayBuffer) {
    try {
        session.peer.send(payload)
    } catch {
        sessions.delete(session.runId)
    }
}

function parseRunId(peer: Peer) {
    const url = new URL(peer.request?.url ?? 'http://localhost')
    return url.searchParams.get('runId') ?? ''
}

async function authenticate(peer: Peer) {
    const headers = new Headers(peer.request?.headers as HeadersInit | undefined)
    const session = await auth.api.getSession({ headers })
    if (!session?.user?.id) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    return session.user.id
}

async function createSession(peer: Peer): Promise<ActiveSession | null> {
    const userId = await authenticate(peer)
    const runId = parseRunId(peer)
    if (!runId) throw createError({ statusCode: 400, statusMessage: 'Pathwarden runId is required' })
    const run = await db.query.pathwardenRuns.findFirst({
        where: (table, operators) => operators.and(operators.eq(table.id, runId), operators.eq(table.userId, userId))
    })
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Pathwarden run not found' })
    const snapshot: PathwardenWorldSnapshot = {
        runId: run.id,
        revision: run.revision,
        realm: run.realm,
        seed: Number(run.seed) >>> 0,
        tick: 0,
        phase: 'planning',
        wave: 0,
        lives: 20,
        aether: 0,
        score: 0,
        paused: false,
        entityCount: 0
    }
    return { peer, userId, runId, nextPacketSequence: 1, lastInputSequence: 0, tick: 0, snapshot }
}

function handleCommand(session: ActiveSession, command: PathwardenInputCommand, inputSequence: number) {
    if (inputSequence <= session.lastInputSequence) return
    session.lastInputSequence = inputSequence
    if (command.type === 'pause') session.snapshot = { ...session.snapshot, paused: command.value }
    if (command.type === 'start-wave' && session.snapshot.phase === 'planning') session.snapshot = { ...session.snapshot, phase: 'wave', wave: Math.max(1, session.snapshot.wave + 1) }
    if (command.type === 'select-tower') return
    if (command.type === 'place-tower') {
        send(session, encodeCommandAck(inputSequence, session.tick, false, 'Placement authority is not enabled in this migration slice'))
        return
    }
    send(session, encodeCommandAck(inputSequence, session.tick, true))
}

export async function openPathwardenSession(peer: Peer) {
    const session = await createSession(peer)
    if (!session) return
    const previous = sessions.get(session.runId)
    previous?.peer.close(4009, 'Replaced by a newer Pathwarden session')
    sessions.set(session.runId, session)
    send(session, encodeHelloAck({ sequence: session.nextPacketSequence++ }))
    send(session, encodeWorldSnapshot(session.snapshot, { sequence: session.nextPacketSequence++ }))
}

export function handlePathwardenMessage(peer: Peer, message: { arrayBuffer(): ArrayBuffer | SharedArrayBuffer }) {
    const session = [...sessions.values()].find(candidate => candidate.peer === peer)
    if (!session) return
    try {
        const packet = decodePacket(message.arrayBuffer())
        if (packet.header.kind !== PathwardenPacketKind.InputCommand) return
        const payload = packet.payload as { inputSequence: number, command: PathwardenInputCommand } | null
        if (!payload) throw new Error('Invalid Pathwarden input')
        handleCommand(session, payload.command, payload.inputSequence)
    } catch (error) {
        send(session, encodeProtocolError(error instanceof Error ? error.message : 'Invalid Pathwarden packet'))
    }
}

export function closePathwardenSession(peer: Peer) {
    for (const [runId, session] of sessions) {
        if (session.peer === peer) sessions.delete(runId)
    }
}
