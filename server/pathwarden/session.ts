import type { Peer } from 'crossws'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '#server/database'
import { pathwardenRuns, pathwardenState } from '#server/database/schema'
import { auth } from '#server/utils/auth'
import { pathwardenLevels, recordPathwardenAmbientStory } from '#server/utils/pathwarden'
import { pathwardenBoostEffects } from '#shared/utils/gamelogic/pathwarden'
import { PathwardenWorld } from '#server/pathwarden/world'
import type { PathwardenEntity } from '#server/pathwarden/world'
import {
    pathwardenMetricCommand,
    pathwardenMetricConnection,
    pathwardenMetricDisconnection,
    pathwardenMetricPacket,
    pathwardenMetricTick
} from '#server/pathwarden/metrics'
import {
    decodePacket,
    encodeCommandAck,
    encodeGameplayEvent,
    encodeEntityDelta,
    encodeEntitySnapshot,
    encodeChoiceOffer,
    encodeHelloAck,
    encodeMapStateDelta,
    encodeMapSnapshotChunks,
    encodeProtocolError,
    encodeWorldSnapshot,
    PathwardenPacketKind,
    type PathwardenEntityState,
    type PathwardenInputCommand,
    type PathwardenGameplayEvent,
    type PathwardenWorldSnapshot
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
    commandWindowStartedAt: number
    commandsInWindow: number
    lastEntities: Map<number, PathwardenEntityState>
    lastClaimedRoomIds: Set<string>
    lastRevealedCells: Set<string>
}

const sessions = new Map<string, ActiveSession>()
const MAX_COMMANDS_PER_SECOND = 120

export function hasPathwardenSessionForUser(userId: string) {
    return [...sessions.values()].some(session => session.userId === userId)
}

function send(session: ActiveSession, payload: ArrayBuffer) {
    try {
        session.peer.send(payload)
        pathwardenMetricPacket('out', payload.byteLength)
    } catch {
        if (sessions.get(session.runId) === session) {
            session.world.stop()
            session.lastPersistedTick = -1
            persistWorld(session, session.world.getSnapshot().tick, true)
            sessions.delete(session.runId)
            pathwardenMetricDisconnection()
        }
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
    const state = await db.query.pathwardenState.findFirst({
        where: (table, operators) => operators.eq(table.userId, userId)
    })
    if (!state) throw createError({ statusCode: 409, statusMessage: 'Pathwarden progression state is unavailable' })
    const levels = pathwardenLevels(state)
    const world = new PathwardenWorld({
        runId: run.id,
        revision: run.revision,
        realm: run.realm,
        seed: Number(run.seed) >>> 0,
        mapPlan: run.mapPlan,
        gameState: run.gameState ?? null,
        boosts: pathwardenBoostEffects(levels, state.runSurgedSnapshot === true)
    })
    return {
        peer,
        userId,
        runId,
        nextPacketSequence: 1,
        mapPlan: run.mapPlan,
        world,
        lastPersistedTick: -1,
        persistPromise: null,
        commandWindowStartedAt: Date.now(),
        commandsInWindow: 0,
        lastEntities: new Map(),
        lastClaimedRoomIds: new Set(),
        lastRevealedCells: new Set()
    }
}

function entityState(entity: PathwardenEntity): PathwardenEntityState {
    return {
        id: entity.id,
        type: entity.data.type,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        v1: entity.v1,
        v2: entity.v2,
        v3: entity.v3,
        components: entity.data.components
    }
}

function entityChanged(left: PathwardenEntityState, right: PathwardenEntityState) {
    return JSON.stringify(left) !== JSON.stringify(right)
}

function mapState(snapshot: PathwardenWorldSnapshot) {
    return {
        claimedRoomIds: new Set(snapshot.claimedRoomIds),
        revealedCells: new Set(snapshot.revealedCells.map(cell => `${cell.col}:${cell.row}`))
    }
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

export async function flushPathwardenSessionForUser(userId: string) {
    const active = [...sessions.values()].find(session => session.userId === userId)
    if (!active) return
    active.lastPersistedTick = -1
    persistWorld(active, active.world.getSnapshot().tick, true)
    if (active.persistPromise) await active.persistPromise
}

function handleCommand(session: ActiveSession, command: PathwardenInputCommand, inputSequence: number) {
    if (inputSequence <= session.world.lastAppliedInput) {
        pathwardenMetricCommand(true)
        send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, true))
        return
    }
    const now = Date.now()
    if (now - session.commandWindowStartedAt >= 1000) {
        session.commandWindowStartedAt = now
        session.commandsInWindow = 0
    }
    if (session.commandsInWindow >= MAX_COMMANDS_PER_SECOND) {
        pathwardenMetricCommand(false)
        send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, false, 'Pathwarden command rate limit exceeded'))
        return
    }
    session.commandsInWindow++
    if (!session.world.canApply(command)) {
        pathwardenMetricCommand(false)
        const reason = 'Command is not valid in the current Pathwarden state'
        send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, false, reason))
        return
    }
    if (!session.world.enqueue(inputSequence, command)) {
        pathwardenMetricCommand(false)
        send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, false, 'Pathwarden command queue is full'))
        return
    }
    pathwardenMetricCommand(true)
    send(session, encodeCommandAck(inputSequence, session.world.getSnapshot().tick, true))
}

export async function openPathwardenSession(peer: Peer) {
    const session = await createSession(peer)
    if (!session) return
    const previous = sessions.get(session.runId)
    pathwardenMetricConnection(Boolean(previous))
    previous?.peer.close(4009, 'Replaced by a newer Pathwarden session')
    if (previous) {
        previous.world.stop()
        previous.lastPersistedTick = -1
        persistWorld(previous, previous.world.getSnapshot().tick, true)
        pathwardenMetricDisconnection()
    }
    session.world.setChangeHandler((snapshot, entities, events: PathwardenGameplayEvent[]) => {
        const nextEntities = entities.map(entityState)
        const upserts = nextEntities.filter(entity => {
            const previous = session.lastEntities.get(entity.id)
            return !previous || entityChanged(previous, entity)
        })
        const nextIds = new Set(nextEntities.map(entity => entity.id))
        const removed = [...session.lastEntities.keys()].filter(id => !nextIds.has(id))
        session.lastEntities = new Map(nextEntities.map(entity => [entity.id, entity]))
        const nextMap = mapState(snapshot)
        const claimedRoomIds = [...nextMap.claimedRoomIds].filter(roomId => !session.lastClaimedRoomIds.has(roomId))
        const revealedCells = [...nextMap.revealedCells]
            .filter(key => !session.lastRevealedCells.has(key))
            .map(key => {
                const [col = 0, row = 0] = key.split(':').map(Number)
                return { col, row }
            })
        session.lastClaimedRoomIds = nextMap.claimedRoomIds
        session.lastRevealedCells = nextMap.revealedCells
        if (claimedRoomIds.length || revealedCells.length) {
            send(session, encodeMapStateDelta({ claimedRoomIds, revealedCells }, { sequence: session.nextPacketSequence++, tick: snapshot.tick, acknowledgedInput: session.world.lastAppliedInput }))
        }
        if (upserts.length || removed.length) {
            send(session, encodeEntityDelta({ upserts, removed }, { sequence: session.nextPacketSequence++, tick: snapshot.tick, acknowledgedInput: session.world.lastAppliedInput }))
        }
        for (const event of events) {
            send(session, encodeGameplayEvent(event, { sequence: session.nextPacketSequence++, tick: snapshot.tick, acknowledgedInput: session.world.lastAppliedInput }))
        }
        send(session, encodeWorldSnapshot(snapshot, { sequence: session.nextPacketSequence++, acknowledgedInput: session.world.lastAppliedInput }, false))
        const offer = session.world.getChoiceOffer()
        if (offer) send(session, encodeChoiceOffer(offer.kind, offer.choices, { sequence: session.nextPacketSequence++, tick: snapshot.tick }, offer.offerRevision, offer.choiceKeys))
        persistWorld(session, snapshot.tick, snapshot.phase === 'victory' || snapshot.phase === 'defeat' || snapshot.phase === 'cashout')
    })
    session.world.setAmbientStoryHandler(storyId => {
        void db.transaction(tx => recordPathwardenAmbientStory(tx, session.userId, storyId)).catch(() => {})
    })
    session.world.setTickMetricsHandler(pathwardenMetricTick)
    sessions.set(session.runId, session)
    send(session, encodeHelloAck({ sequence: session.nextPacketSequence++ }))
    for (const packet of encodeMapSnapshotChunks(session.mapPlan, session.nextPacketSequence)) {
        send(session, packet)
        session.nextPacketSequence++
    }
    const initialEntities = session.world.getEntities().map(entityState)
    session.lastEntities = new Map(initialEntities.map(entity => [entity.id, entity]))
    const initialMap = mapState(session.world.getSnapshot())
    session.lastClaimedRoomIds = initialMap.claimedRoomIds
    session.lastRevealedCells = initialMap.revealedCells
    send(session, encodeEntitySnapshot(initialEntities, { sequence: session.nextPacketSequence++, tick: session.world.getSnapshot().tick }))
    send(session, encodeWorldSnapshot(session.world.getSnapshot(), { sequence: session.nextPacketSequence++ }))
    const offer = session.world.getChoiceOffer()
    if (offer) send(session, encodeChoiceOffer(offer.kind, offer.choices, { sequence: session.nextPacketSequence++, tick: session.world.getSnapshot().tick }, offer.offerRevision, offer.choiceKeys))
    session.world.start()
}

export function handlePathwardenMessage(peer: Peer, message: { arrayBuffer(): ArrayBuffer | SharedArrayBuffer }) {
    const session = [...sessions.values()].find(candidate => candidate.peer === peer)
    if (!session) return
    try {
        const rawPayload = message.arrayBuffer()
        const packet = decodePacket(rawPayload)
        pathwardenMetricPacket('in', rawPayload.byteLength)
        if (packet.header.kind !== PathwardenPacketKind.InputCommand) return
        const input = packet.payload as { inputSequence: number, command: PathwardenInputCommand } | null
        if (!input) throw new Error('Invalid Pathwarden input')
        handleCommand(session, input.command, input.inputSequence)
    } catch (error) {
        send(session, encodeProtocolError(error instanceof Error ? error.message : 'Invalid Pathwarden packet'))
    }
}

export function closePathwardenSession(peer: Peer) {
    for (const [runId, session] of sessions) {
        if (session.peer === peer) {
            session.world.stop()
            session.lastPersistedTick = -1
            persistWorld(session, session.world.getSnapshot().tick, true)
            pathwardenMetricDisconnection()
            void session.persistPromise
            sessions.delete(runId)
        }
    }
}
