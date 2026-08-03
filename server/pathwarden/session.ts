import type { Peer } from 'crossws'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '#server/database'
import { pathwardenRuns } from '#server/database/schema'
import { auth } from '#server/utils/auth'
import { PathwardenWorld } from '#server/pathwarden/world'
import {
    decodePacket,
    encodeCommandAck,
    encodeEntitySnapshot,
    encodeChoiceOffer,
    encodeHelloAck,
    encodeMapSnapshotChunks,
    encodeProtocolError,
    encodeWorldSnapshot,
    PathwardenPacketKind,
    type PathwardenInputCommand
} from '#shared/pathwarden/protocol'

interface ActiveSession {
    peer: Peer
    userId: string
    runId: string
    nextPacketSequence: number
    mapPlan: unknown
    world: PathwardenWorld
    lastPersistedTick: number
    persistPromise: Promise<void> | null
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
    const world = new PathwardenWorld({
        runId: run.id,
        revision: run.revision,
        realm: run.realm,
        seed: Number(run.seed) >>> 0,
        mapPlan: run.mapPlan,
        gameState: run.gameState ?? null
    })
    return { peer, userId, runId, nextPacketSequence: 1, mapPlan: run.mapPlan, world, lastPersistedTick: -1, persistPromise: null }
}

function persistWorld(session: ActiveSession, tick: number, terminal: boolean) {
    if (!terminal && (tick < 1 || tick % 20 !== 0)) return
    if (tick <= session.lastPersistedTick) return
    session.lastPersistedTick = tick
    session.persistPromise = (session.persistPromise ?? Promise.resolve()).then(async () => {
        await db.update(pathwardenRuns)
            .set({
                gameState: session.world.exportGameState(),
                revision: sql`${pathwardenRuns.revision} + 1`,
                updatedAt: new Date()
            })
            .where(and(eq(pathwardenRuns.id, session.runId), eq(pathwardenRuns.userId, session.userId)))
    }).catch(() => {})
}

function handleCommand(session: ActiveSession, command: PathwardenInputCommand, inputSequence: number) {
    if (!session.world.canApply(command)) {
        const reason = command.type === 'place-tower'
            ? 'Placement authority is not enabled in this migration slice'
            : 'Command is not valid in the current Pathwarden phase'
        send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, false, reason))
        return
    }
    if (!session.world.enqueue(inputSequence, command)) return
    send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, true))
}

export async function openPathwardenSession(peer: Peer) {
    const session = await createSession(peer)
    if (!session) return
    const previous = sessions.get(session.runId)
    previous?.peer.close(4009, 'Replaced by a newer Pathwarden session')
    previous?.world.stop()
    session.world.setChangeHandler((snapshot, entities) => {
        send(session, encodeEntitySnapshot(entities.map(entity => ({
            id: entity.id,
            type: entity.data.type,
            x: entity.x,
            y: entity.y,
            z: entity.z,
            v1: entity.v1,
            v2: entity.v2,
            v3: entity.v3,
            components: entity.data.components
        })), { sequence: session.nextPacketSequence++, tick: snapshot.tick, acknowledgedInput: session.world.lastAppliedInput }))
        send(session, encodeWorldSnapshot(snapshot, { sequence: session.nextPacketSequence++, acknowledgedInput: session.world.lastAppliedInput }))
        const offer = session.world.getChoiceOffer()
        if (offer) send(session, encodeChoiceOffer(offer.kind, offer.choices, { sequence: session.nextPacketSequence++, tick: snapshot.tick }))
        persistWorld(session, snapshot.tick, snapshot.phase === 'victory' || snapshot.phase === 'defeat' || snapshot.phase === 'cashout')
    })
    sessions.set(session.runId, session)
    send(session, encodeHelloAck({ sequence: session.nextPacketSequence++ }))
    for (const packet of encodeMapSnapshotChunks(session.mapPlan, session.nextPacketSequence)) {
        send(session, packet)
        session.nextPacketSequence++
    }
    send(session, encodeEntitySnapshot(session.world.getEntities().map(entity => ({
        id: entity.id,
        type: entity.data.type,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        v1: entity.v1,
        v2: entity.v2,
        v3: entity.v3,
        components: entity.data.components
    })), { sequence: session.nextPacketSequence++, tick: session.world.getSnapshot().tick }))
    send(session, encodeWorldSnapshot(session.world.getSnapshot(), { sequence: session.nextPacketSequence++ }))
    const offer = session.world.getChoiceOffer()
    if (offer) send(session, encodeChoiceOffer(offer.kind, offer.choices, { sequence: session.nextPacketSequence++, tick: session.world.getSnapshot().tick }))
    session.world.start()
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
        if (session.peer === peer) {
            session.world.stop()
            sessions.delete(runId)
        }
    }
}
