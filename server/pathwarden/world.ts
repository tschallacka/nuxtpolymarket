import type { PathwardenGameState, PathwardenMapPlan, PathwardenSavedRelic, PathwardenSavedRelicEffects } from '#shared/types/pathwarden-save'
import {
    PATHWARDEN_AMBIENT_FAMILIES,
    PATHWARDEN_DEFENSE_BLUEPRINTS,
    pathwardenRelicDefinition,
    pathwardenRelicEffectComponents,
    pathwardenRelicEffectsFromComponents,
    pathwardenRelicEffects,
    pathwardenRelicOfferIds,
    pathwardenTowerPurchaseCost
} from '#shared/utils/gamelogic/pathwarden'
import type {
    PathwardenInputCommand,
    PathwardenPhase,
    PathwardenWorldSnapshot,
    PathwardenGameplayEvent
} from '#shared/pathwarden/protocol'
import { PathwardenGameplayEventType } from '#shared/pathwarden/protocol'
import { hashPathwardenState, recordPathwardenReplay } from '#server/pathwarden/replay'

export interface PathwardenWorldSource {
    runId: string
    revision: number
    realm: number
    seed: number
    mapPlan: PathwardenMapPlan
    gameState: PathwardenGameState | null
    boosts?: PathwardenWorldBoosts
}

export interface PathwardenWorldBoosts {
    startingLives: number
    startingAether: number
    damageMultiplier: number
    rangeMultiplier: number
    rateMultiplier: number
    bountyMultiplier: number
    arcanistLevel: number
}

export interface PathwardenEntityData {
    type: number
    components?: Record<string, number | string | boolean>
}

export interface PathwardenEntity {
    id: number
    data: PathwardenEntityData
    x: number
    y: number
    z: number
    v1: number
    v2: number
    v3: number
}

interface QueuedCommand {
    inputSequence: number
    command: PathwardenInputCommand
}

const TICK_MS = 50

function initialPhase(state: PathwardenGameState | null): PathwardenPhase {
    const phase = state?.phase
    return phase && ['planning', 'wave', 'checkpoint', 'path', 'upgrade', 'cashout', 'victory', 'defeat'].includes(phase)
        ? phase as PathwardenPhase
        : 'planning'
}

function deterministicUnit(seed: number, tick: number, index: number) {
    let value = (seed ^ Math.imul(tick + 1, 0x45d9f3b) ^ Math.imul(index + 1, 0x27d4eb2d)) >>> 0
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0
    return ((value ^ (value >>> 13)) >>> 0) / 0x100000000
}

export class PathwardenWorld {
    private readonly commands: QueuedCommand[] = []
    private readonly entities = new Map<number, PathwardenEntity>()
    private readonly mapPlan: PathwardenMapPlan
    private readonly boosts: PathwardenWorldBoosts
    private readonly runId: string
    private readonly claimedRooms = new Set<string>()
    private readonly revealed = new Set<string>()
    private readonly reservedRoads = new Set<string>()
    private readonly state: PathwardenWorldSnapshot
    private timer: ReturnType<typeof setInterval> | null = null
    private lastInputSequence = 0
    private nextEntityId = 1
    private nextEventId = 1
    private readonly events: PathwardenGameplayEvent[] = []
    private selectedTower = 'bolt'
    private towerPurchases: Record<string, number> = {}
    private waveStartingLives = 20
    private streak = 0
    private flawlessWaves = 0
    private spawnRemaining = 0
    private spawnCooldown = 0
    private ambientCooldown = 0
    private nextAmbientStoryId = 1
    private nextRelicInstanceId = 1
    private maxLives = 20
    private globalRelicEffects: PathwardenSavedRelicEffects = pathwardenRelicEffects('', 0)
    private globalRelics: Record<string, { level: number, power: number, effects: PathwardenSavedRelicEffects, color?: string }> = {}
    private choiceKind: 'checkpoint' | 'relic' | 'path' | null = null
    private choiceRevision = 0
    private choices: number[] = []
    private choiceKeys: string[] = []
    private batching = false
    private dirty = false
    private onChange: (snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[]) => void = () => {}
    private onAmbientStoryComplete: (storyId: number) => void = () => {}
    private onTickMetrics: (durationMs: number, entityCount: number, pendingCommands: number) => void = () => {}

    constructor(source: PathwardenWorldSource) {
        this.runId = source.runId
        this.mapPlan = source.mapPlan
        this.boosts = source.boosts ?? {
            startingLives: 20,
            startingAether: 205,
            damageMultiplier: 1,
            rangeMultiplier: 1,
            rateMultiplier: 1,
            bountyMultiplier: 1,
            arcanistLevel: 0
        }
        const claimed = new Set(source.gameState?.claimedRoomIds ?? [])
        this.claimedRooms.add(this.mapPlan.castleRoomId)
        for (const roomId of claimed) this.claimedRooms.add(roomId)
        const castle = this.mapPlan.rooms.find(room => room.id === this.mapPlan.castleRoomId)
        for (const room of this.mapPlan.rooms) {
            if (room.id === this.mapPlan.castleRoomId || claimed.has(room.id)) {
                for (const cell of [...room.revealCells, ...room.roadCells]) {
                    for (let colOffset = -2; colOffset <= 2; colOffset++) {
                        for (let rowOffset = -2; rowOffset <= 2; rowOffset++) {
                            const col = cell.col + colOffset
                            const row = cell.row + rowOffset
                            if (col >= 0 && row >= 0 && col < this.mapPlan.size.cols && row < this.mapPlan.size.rows) {
                                this.revealed.add(this.cellKey(col, row))
                            }
                        }
                    }
                }
                for (const cell of room.roadCells) this.reservedRoads.add(this.cellKey(cell.col, cell.row))
            }
        }
        if (castle) for (const cell of castle.roadCells) this.reservedRoads.add(this.cellKey(cell.col, cell.row))
        this.state = {
            runId: source.runId,
            revision: source.revision,
            realm: source.realm,
            seed: source.seed >>> 0,
            tick: 0,
            phase: initialPhase(source.gameState),
            wave: Math.max(0, source.gameState?.wave ?? 0),
            lives: Math.max(0, source.gameState?.lives ?? this.boosts.startingLives),
            aether: Math.max(0, source.gameState?.aether ?? this.boosts.startingAether),
            score: Math.max(0, source.gameState?.score ?? 0),
            streak: Math.max(0, source.gameState?.streak ?? 0),
            flawlessWaves: Math.max(0, source.gameState?.flawlessWaves ?? 0),
            relicPower: Math.max(0, Number(source.gameState?.globalRelics?.server?.power ?? 0)),
            paused: source.gameState?.paused === true,
            entityCount: 0,
            claimedRoomIds: [...this.claimedRooms],
            revealedCells: [...this.revealed].map(key => {
                const [col = 0, row = 0] = key.split(':').map(Number)
                return { col, row }
            })
        }
        this.maxLives = Math.max(this.boosts.startingLives, Number(source.gameState?.maxLives ?? this.boosts.startingLives))
        for (const [family, relic] of Object.entries(source.gameState?.globalRelics ?? {})) {
            if (family === 'server') continue
            const effects = relic.effects ?? pathwardenRelicEffects(family, Number(relic.power ?? 0))
            this.globalRelics[family] = { level: Number(relic.level ?? 0), power: Number(relic.power ?? 0), effects, color: relic.color }
            this.addEffects(this.globalRelicEffects, effects)
        }
        this.refreshGlobalRelicPower()
        this.lastInputSequence = Math.max(0, Math.floor(source.gameState?.lastInputSequence ?? 0))
        this.towerPurchases = { ...(source.gameState?.towerPurchases ?? {}) }
        this.selectedTower = source.gameState?.selectedTower ?? 'bolt'
        this.waveStartingLives = Math.max(0, source.gameState?.lives ?? this.state.lives)
        this.streak = this.state.streak
        this.flawlessWaves = this.state.flawlessWaves
        this.spawnRemaining = Math.max(0, Math.floor(source.gameState?.spawnLeft ?? 0))
        this.spawnCooldown = Math.max(0, Math.floor(source.gameState?.spawnTimer ?? 0))
        this.ambientCooldown = Math.max(0, Math.floor(source.gameState?.ambientCooldown ?? (900 + (source.seed % 4501))))
        this.nextAmbientStoryId = Math.max(1, Math.min(250, Math.floor(source.gameState?.nextAmbientStoryId ?? 1)))
        const savedChoiceKind = source.gameState?.choiceKind
        const savedChoiceKeys = source.gameState?.choiceKeys
        if (savedChoiceKind && Array.isArray(savedChoiceKeys) && savedChoiceKeys.length > 0) {
            this.choiceKind = savedChoiceKind
            this.choices = Array.isArray(source.gameState?.choiceChoices)
                ? source.gameState.choiceChoices.map(choice => Math.floor(choice))
                : savedChoiceKeys.map((_, index) => index)
            this.choiceKeys = [...savedChoiceKeys]
            this.choiceRevision = Math.max(1, Math.floor(source.gameState?.choiceRevision ?? 1))
        } else if (this.state.phase === 'checkpoint') {
            this.choiceKind = 'checkpoint'
            this.choices = [0, 1, 2]
            this.choiceKeys = ['cashout', 'continue', 'bonus']
            this.choiceRevision = 1
        } else if (this.state.phase === 'path') {
            this.openNextChoice()
        } else if (this.state.phase === 'upgrade') {
            this.openRelicChoice()
        }
        for (const tower of source.gameState?.towers ?? []) {
            this.spawnEntity({ type: 1, components: {
                towerType: tower.type,
                col: tower.col,
                row: tower.row,
                invested: tower.invested,
                cooldown: tower.cooldown,
                level: tower.level,
                targeting: tower.targeting,
                relicFamily: tower.relicFamily ?? '',
                relicId: tower.relicId ?? '',
                relicStacks: tower.relicStacks,
                relicPower: tower.relicPower
            } }, tower.col, tower.row, 0, 0, 0, 0, tower.id)
        }
        for (const enemy of source.gameState?.enemies ?? []) {
            const exitKey = enemy.exitKey || 'castle-main'
            const position = this.routePosition(enemy.progress, this.enemyRouteForKey(exitKey))
            this.spawnEntity({ type: 2, components: {
                enemyType: enemy.type,
                exitKey,
                progress: enemy.progress,
                hp: enemy.hp,
                maxHp: enemy.maxHp,
                reward: enemy.reward
            } }, position.col, position.row, 0, 0, 0, 0, enemy.id)
        }
        for (const projectile of source.gameState?.projectiles ?? []) {
            this.spawnEntity({ type: 3, components: {
                towerType: projectile.type,
                targetId: projectile.targetId,
                damage: projectile.damage,
                progress: projectile.age,
                splash: projectile.splash,
                slow: projectile.slow,
                burnDamage: projectile.burnDamage ?? 0,
                burnDuration: projectile.burnDuration ?? 0,
                speed: projectile.speed,
                duration: projectile.duration
            } }, projectile.x, projectile.y, 0, 0, 0, 0, projectile.id)
        }
        for (const relic of source.gameState?.relicInventory ?? []) this.spawnRelic(relic)
        const savedAmbient = source.gameState?.ambientActor
        if (savedAmbient && Number.isFinite(savedAmbient.storyId)) this.spawnEntity({ type: 4, components: {
            storyId: Math.max(1, Math.min(250, Math.floor(savedAmbient.storyId))),
            progress: Math.max(0, Math.min(1, Number(savedAmbient.progress) || 0)),
            duration: Math.max(1, Math.floor(Number(savedAmbient.duration) || 1800)),
            family: String(savedAmbient.family ?? 'Market day'),
            kind: String(savedAmbient.kind ?? 'market'),
            variant: Math.max(1, Math.min(10, Math.floor(Number(savedAmbient.variant) || 1)))
        } }, Number(savedAmbient.col) || 0, Number(savedAmbient.row) || 0)
    }

    setChangeHandler(handler: (snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[], events: PathwardenGameplayEvent[]) => void) {
        this.onChange = snapshot => {
            const events = this.events.splice(0)
            handler(snapshot, this.getEntities(), events)
        }
    }

    setAmbientStoryHandler(handler: (storyId: number) => void) {
        this.onAmbientStoryComplete = handler
    }

    setTickMetricsHandler(handler: (durationMs: number, entityCount: number, pendingCommands: number) => void) {
        this.onTickMetrics = handler
    }

    start() {
        if (this.timer) return
        this.timer = setInterval(() => this.advance(), TICK_MS)
    }

    stop() {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = null
    }

    enqueue(inputSequence: number, command: PathwardenInputCommand) {
        if (this.commands.length >= 256) return false
        if (!Number.isSafeInteger(inputSequence) || inputSequence <= this.lastInputSequence || !this.canApply(command)) return false
        this.commands.push({ inputSequence, command })
        return true
    }

    get pendingCommandCount() {
        return this.commands.length
    }

    canApply(command: PathwardenInputCommand) {
        if (command.type === 'place-tower') return this.validatePlacement(command).allowed
        if (command.type === 'upgrade-tower') return this.validateTower(command.id, 'upgrade')
        if (command.type === 'fuse-tower') return this.validateFuse(command.sourceId, command.targetId)
        if (command.type === 'salvage-tower') return this.validateTower(command.id, 'salvage')
        if (command.type === 'move-tower') return this.validateMove(command)
        if (command.type === 'set-targeting') return this.validateTargeting(command)
        if (command.type === 'continue-checkpoint') return this.state.phase === 'checkpoint'
        if (command.type === 'claim-path') return this.state.phase === 'path' && this.choiceKind === 'path' && command.offerRevision === this.choiceRevision && this.choices.includes(command.choice)
        if (command.type === 'sell-relic') return this.state.phase !== 'wave' && this.state.phase !== 'checkpoint' && this.entities.get(command.instanceId)?.data.type === 5
        if (command.type === 'bind-relic') return this.validateRelicBinding(command)
        if (command.type === 'rebind-relic') return this.validateRelicRebinding(command)
        if (command.type === 'pause') return !['victory', 'defeat', 'cashout'].includes(this.state.phase)
        if (command.type === 'start-wave') return this.state.phase === 'planning' && this.state.wave < 12
        if (command.type === 'checkpoint-choice') return this.choiceKind === 'checkpoint' && command.offerRevision === this.choiceRevision && this.choices.includes(command.choice)
        if (command.type === 'relic-choice') return this.choiceKind === 'relic' && command.offerRevision === this.choiceRevision && this.choices.includes(command.choice)
        return command.type === 'select-tower' && PATHWARDEN_DEFENSE_BLUEPRINTS.some(defense => defense.id === command.tower)
    }

    getChoiceOffer() {
        return this.choiceKind
            ? { kind: this.choiceKind, choices: [...this.choices], choiceKeys: [...this.choiceKeys], offerRevision: this.choiceRevision }
            : null
    }

    getSnapshot() {
        return {
            ...this.state,
            maxLives: this.maxLives,
            globalRelics: Object.entries(this.globalRelics).map(([family, relic]) => ({ family, level: relic.level, power: relic.power })),
            claimedRoomIds: [...this.claimedRooms],
            revealedCells: [...this.revealed].map(key => {
                const [col = 0, row = 0] = key.split(':').map(Number)
                return { col, row }
            })
        }
    }

    spawnEntity(data: PathwardenEntityData, x: number, y: number, z = 0, v1 = 0, v2 = 0, v3 = 0, entityId?: number) {
        if (!Number.isInteger(data.type) || data.type < 0 || data.type > 255) throw new Error('Invalid Pathwarden entity type')
        const id = entityId ?? this.nextEntityId++
        if (!Number.isSafeInteger(id) || id < 1 || this.entities.has(id)) throw new Error('Invalid or duplicate Pathwarden entity id')
        this.nextEntityId = Math.max(this.nextEntityId, id + 1)
        const entity: PathwardenEntity = {
            id,
            data: { type: data.type, components: data.components ? { ...data.components } : undefined },
            x,
            y,
            z,
            v1,
            v2,
            v3
        }
        this.entities.set(entity.id, entity)
        this.state.entityCount = this.entities.size
        this.notifyChange()
        return entity.id
    }

    updateEntity(id: number, patch: Partial<Omit<PathwardenEntity, 'id' | 'data'>> & { data?: PathwardenEntityData }) {
        const entity = this.entities.get(id)
        if (!entity) return false
        Object.assign(entity, patch)
        if (patch.data) entity.data = { ...patch.data, components: patch.data.components ? { ...patch.data.components } : undefined }
        this.notifyChange()
        return true
    }

    removeEntity(id: number) {
        const removed = this.entities.delete(id)
        if (removed) {
            this.state.entityCount = this.entities.size
            this.notifyChange()
        }
        return removed
    }

    getEntities() {
        return [...this.entities.values()].map(entity => ({
            ...entity,
            data: { ...entity.data, components: entity.data.components ? { ...entity.data.components } : undefined }
        }))
    }

    exportGameState(): PathwardenGameState {
        const entities = this.getEntities()
        const ambient = entities.find(entity => entity.data.type === 4)
        const ambientComponents = ambient?.data.components
        return {
            phase: this.state.phase,
            paused: this.state.paused,
            wave: this.state.wave,
            lives: this.state.lives,
            maxLives: this.maxLives,
            aether: this.state.aether,
            score: this.state.score,
            streak: this.streak,
            flawlessWaves: this.flawlessWaves,
            spawnLeft: this.spawnRemaining,
            spawnTotal: this.spawnRemaining,
            spawnTimer: this.spawnCooldown,
            combatRandomState: this.state.seed,
            path: this.mapPlan.rooms.find(room => room.id === this.mapPlan.castleRoomId)?.roadCells ?? [],
            claimedRoomIds: [...this.claimedRooms],
            activeRoomIds: [...this.claimedRooms],
            selectedTower: this.selectedTower,
            towerPurchases: { ...this.towerPurchases },
            relicRanks: {},
            globalRelics: {
                server: { level: Math.round(this.state.relicPower * 10), power: this.state.relicPower },
                ...this.globalRelics
            },
            relicInventory: entities.filter(entity => entity.data.type === 5).map(entity => this.relicFromEntity(entity)),
            ashPiles: [],
            interest: 0,
            canSellRelics: false,
            towers: entities.filter(entity => entity.data.type === 1).map(entity => ({
                id: entity.id,
                type: String(entity.data.components?.towerType ?? 'bolt'),
                col: Number(entity.data.components?.col ?? entity.x),
                row: Number(entity.data.components?.row ?? entity.y),
                invested: Number(entity.data.components?.invested ?? 0),
                cooldown: Number(entity.data.components?.cooldown ?? 0),
                angle: 0,
                level: Number(entity.data.components?.level ?? 1),
                merges: 0,
                targeting: (String(entity.data.components?.targeting ?? 'first') as 'first' | 'strong' | 'fast'),
                relicFamily: entity.data.components?.relicFamily ? String(entity.data.components.relicFamily) : undefined,
                relicId: entity.data.components?.relicId ? String(entity.data.components.relicId) : undefined,
                relicStacks: Number(entity.data.components?.relicStacks ?? 0),
                relicPower: Number(entity.data.components?.relicPower ?? 0),
                relicShots: 0
            })),
            enemies: entities.filter(entity => entity.data.type === 2).map(entity => ({
                ...(() => {
                    const exitKey = String(entity.data.components?.exitKey ?? 'castle-main')
                    return { route: this.enemyRouteForKey(exitKey), exitKey }
                })(),
                id: entity.id,
                type: String(entity.data.components?.enemyType ?? 'raider'),
                progress: Number(entity.data.components?.progress ?? 0),
                hp: Number(entity.data.components?.hp ?? 1),
                maxHp: Number(entity.data.components?.maxHp ?? 1),
                speed: 1,
                reward: Number(entity.data.components?.reward ?? 0),
                slow: 0,
                slowTimer: 0,
                healTimer: 0,
                attackTimer: 0,
                dotDamage: 0,
                dotTimer: 0,
                dotTick: 0
            })),
            projectiles: entities.filter(entity => entity.data.type === 3).map(entity => ({
                id: entity.id,
                type: String(entity.data.components?.towerType ?? 'bolt'),
                targetId: Number(entity.data.components?.targetId ?? 0),
                relicPower: Number(entity.data.components?.relicPower ?? 0),
                echo: false,
                x: entity.x,
                y: entity.y,
                damage: Number(entity.data.components?.damage ?? 1),
                speed: Number(entity.data.components?.speed ?? 1),
                splash: Number(entity.data.components?.splash ?? 0),
                splashFactor: 0,
                slow: Number(entity.data.components?.slow ?? 0),
                burnDamage: Number(entity.data.components?.burnDamage ?? 0),
                burnDuration: Number(entity.data.components?.burnDuration ?? 0),
                color: 'primary',
                size: 4,
                trail: [],
                origin: { col: entity.x, row: entity.y },
                age: Number(entity.data.components?.progress ?? 0),
                duration: Number(entity.data.components?.duration ?? 1),
                arcHeight: 0
            })),
            towerId: this.nextEntityId,
            enemyId: this.nextEntityId,
            relicInstanceId: this.nextRelicInstanceId,
            lastInputSequence: this.lastInputSequence,
            choiceKind: this.choiceKind ?? undefined,
            choiceChoices: this.choiceKind ? [...this.choices] : undefined,
            choiceKeys: this.choiceKind ? [...this.choiceKeys] : undefined,
            choiceRevision: this.choiceKind ? this.choiceRevision : undefined,
            ambientActor: ambient && ambientComponents
                ? {
                    storyId: Number(ambientComponents.storyId ?? 1),
                    progress: Number(ambientComponents.progress ?? 0),
                    duration: Number(ambientComponents.duration ?? 1800),
                    family: String(ambientComponents.family ?? 'Market day'),
                    kind: String(ambientComponents.kind ?? 'market'),
                    variant: Number(ambientComponents.variant ?? 1),
                    col: ambient.x,
                    row: ambient.y
                }
                : undefined,
            ambientCooldown: this.ambientCooldown,
            nextAmbientStoryId: this.nextAmbientStoryId
        }
    }

    get lastAppliedInput() {
        return this.lastInputSequence
    }

    private advance() {
        const startedAt = Date.now()
        this.state.tick += 1
        this.batching = true
        const commands = this.commands.splice(0)
        const replayCommands: Array<{ inputSequence: number, command: PathwardenInputCommand, accepted: boolean }> = []
        let changed = commands.length > 0
        for (const queued of commands) {
            if (queued.inputSequence <= this.lastInputSequence) continue
            this.lastInputSequence = queued.inputSequence
            const accepted = this.canApply(queued.command)
            if (accepted) changed = this.apply(queued.command) || changed
            replayCommands.push({ inputSequence: queued.inputSequence, command: queued.command, accepted })
        }
        this.simulateWave()
        this.simulateAmbient()
        this.batching = false
        const stateHash = hashPathwardenState(this.getSnapshot(), this.getEntities())
        const tickEvents = this.events.map(event => ({ id: event.id, type: event.type }))
        recordPathwardenReplay(this.runId, {
            tick: this.state.tick,
            events: tickEvents,
            stateHash
        })
        for (const replayCommand of replayCommands) recordPathwardenReplay(this.runId, {
            tick: this.state.tick,
            ...replayCommand,
            stateHash
        })
        if (changed || this.dirty || this.state.tick % 10 === 0) this.notifyChange()
        else this.dirty = false
        this.onTickMetrics(Math.max(0, Date.now() - startedAt), this.entities.size, this.commands.length)
    }

    private notifyChange() {
        if (this.batching) {
            this.dirty = true
            return
        }
        this.dirty = false
        this.onChange(this.getSnapshot(), this.getEntities())
    }

    private emitGameplayEvent(type: PathwardenGameplayEventType, entityId: number, x: number, y: number) {
        if (this.events.length >= 256) return
        this.events.push({ id: this.nextEventId++, type, entityId, x, y, z: 0, v1: 0, v2: 0, v3: 0 })
    }

    private apply(command: PathwardenInputCommand) {
        if (command.type === 'pause') {
            if (this.state.phase === 'victory' || this.state.phase === 'defeat' || this.state.phase === 'cashout') return false
            if (this.state.paused === command.value) return false
            this.state.paused = command.value
            return true
        }
        if (command.type === 'start-wave') {
            if (this.state.phase !== 'planning') return false
            this.state.phase = 'wave'
            this.state.wave = Math.min(12, this.state.wave + 1)
            this.waveStartingLives = this.state.lives
            this.spawnRemaining = 7 + this.state.wave * 3 + Math.max(0, this.state.wave - 1)
            this.spawnCooldown = 0
            return true
        }
        if (command.type === 'select-tower') {
            this.selectedTower = command.tower
            return true
        }
        if (command.type === 'upgrade-tower') {
            const tower = this.entities.get(command.id)!
            const components = tower.data.components ?? {}
            const level = Number(components.level ?? 1)
            const cost = 40 * level
            this.state.aether -= cost
            this.updateEntity(command.id, { data: { type: 1, components: { ...components, level: level + 1, invested: Number(components.invested ?? 0) + cost } } })
            return true
        }
        if (command.type === 'fuse-tower') {
            const source = this.entities.get(command.sourceId)!
            const target = this.entities.get(command.targetId)!
            const sourceComponents = source.data.components ?? {}
            const targetComponents = target.data.components ?? {}
            this.removeEntity(source.id)
            this.updateEntity(target.id, { data: { type: 1, components: {
                ...targetComponents,
                level: Number(targetComponents.level ?? 1) + 1,
                invested: Number(targetComponents.invested ?? 0) + Number(sourceComponents.invested ?? 0)
            } } })
            return true
        }
        if (command.type === 'salvage-tower') {
            const tower = this.entities.get(command.id)!
            const components = tower.data.components ?? {}
            this.state.aether += Math.floor(Number(components.invested ?? 0) * 0.5)
            this.removeEntity(command.id)
            return true
        }
        if (command.type === 'move-tower') {
            this.updateEntity(command.id, { x: command.col, y: command.row, data: { type: 1, components: { ...this.entities.get(command.id)!.data.components, col: command.col, row: command.row } } })
            return true
        }
        if (command.type === 'set-targeting') {
            const tower = this.entities.get(command.id)!
            this.updateEntity(command.id, { data: { type: 1, components: { ...tower.data.components, targeting: command.targeting } } })
            return true
        }
        if (command.type === 'continue-checkpoint') {
            if (this.state.wave >= 12) {
                this.state.phase = 'victory'
                return true
            }
            this.openNextChoice()
            return true
        }
        if (command.type === 'claim-path') {
            const roomId = this.pathChoices()[command.choice]
            const room = this.mapPlan.rooms.find(candidate => candidate.id === roomId)
            if (!room) return false
            this.claimedRooms.add(room.id)
            for (const cell of room.roadCells) {
                this.reservedRoads.add(this.cellKey(cell.col, cell.row))
                this.revealed.add(this.cellKey(cell.col, cell.row))
            }
            for (const cell of room.revealCells) this.revealed.add(this.cellKey(cell.col, cell.row))
            this.openRelicChoice()
            return true
        }
        if (command.type === 'sell-relic') {
            const relic = this.entities.get(command.instanceId)!
            this.state.aether += Number(relic.data.components?.sellValue ?? 0)
            this.removeEntity(relic.id)
            return true
        }
        if (command.type === 'bind-relic') {
            const tower = this.entities.get(command.towerId)!
            const relic = this.entities.get(command.instanceId)!
            const relicComponents = relic.data.components ?? {}
            const towerComponents = tower.data.components ?? {}
            this.updateEntity(tower.id, { data: { type: 1, components: {
                ...towerComponents,
                relicFamily: String(relicComponents.family ?? 'fire'),
                relicId: String(relicComponents.relicId ?? `server-relic-${relic.id}`),
                relicPower: Number(towerComponents.relicPower ?? 0) + Number(relicComponents.power ?? 0.5),
                relicStacks: Number(towerComponents.relicStacks ?? 0) + 1
            } } })
            this.removeEntity(relic.id)
            return true
        }
        if (command.type === 'rebind-relic') {
            const tower = this.entities.get(command.towerId)!
            const relic = this.entities.get(command.instanceId)!
            const towerComponents = tower.data.components ?? {}
            const relicComponents = relic.data.components ?? {}
            const oldStacks = Math.max(1, Math.floor(Number(towerComponents.relicStacks ?? 1)))
            const focusBonus = command.focus === 'binding' ? 0.08 : command.focus === 'preservation' ? 0.08 : 0.04
            const preserveChance = Math.min(0.98, 0.35 + this.boosts.arcanistLevel * 0.04 + focusBonus + Math.min(0.25, command.amount * 0.001))
            const preserved = Array.from({ length: oldStacks }, (_, index) => index)
                .filter(index => deterministicUnit(this.state.seed, this.state.tick, tower.id + index) < preserveChance)
            const oldFamily = String(towerComponents.relicFamily ?? 'fire')
            const oldRelicId = String(towerComponents.relicId ?? `server-relic-${tower.id}`)
            const oldPower = Number(towerComponents.relicPower ?? 0) / oldStacks
            for (const index of preserved) this.spawnRelic({
                instanceId: this.nextRelicInstanceId++,
                id: `${oldRelicId}-recovered-${this.state.tick}-${index}`,
                family: oldFamily as PathwardenSavedRelic['family'],
                rarity: 'common',
                name: 'Recovered relic',
                description: 'A relic recovered by the server-authoritative Arcanist ritual.',
                towerSpecific: false,
                iconIndex: 0,
                power: oldPower,
                sellValue: 15,
                color: '#c4b5fd'
            })
            this.state.aether -= Math.max(0, Math.floor(command.amount))
            this.removeEntity(relic.id)
            this.updateEntity(tower.id, { data: { type: 1, components: {
                ...towerComponents,
                relicFamily: String(relicComponents.family ?? 'fire'),
                relicId: String(relicComponents.relicId ?? `server-relic-${relic.id}`),
                relicPower: Number(relicComponents.power ?? 0.5),
                relicStacks: 1
            } } })
            return true
        }
        if (command.type === 'checkpoint-choice' || command.type === 'relic-choice') {
            if (!this.canApply(command)) return false
            if (command.type === 'relic-choice') {
                const relicId = this.choiceKeys[command.choice]
                const definition = relicId ? pathwardenRelicDefinition(relicId) : undefined
                if (!definition) return false
                if (definition.towerSpecific) this.spawnRelic({
                    instanceId: this.nextRelicInstanceId++,
                    id: `${definition.id}-${this.state.tick}`,
                    family: definition.family,
                    rarity: definition.rarity,
                    name: definition.name,
                    description: definition.description,
                    towerSpecific: true,
                    iconIndex: definition.iconIndex,
                    power: definition.power,
                    sellValue: definition.sellValue,
                    color: definition.color,
                    effects: definition.effects
                })
                else {
                    const current = this.globalRelics[definition.family]
                    this.globalRelics[definition.family] = {
                        level: (current?.level ?? 0) + 1,
                        power: (current?.power ?? 0) + definition.power,
                        effects: current ? this.addEffects(current.effects, definition.effects) : { ...definition.effects },
                        color: definition.color
                    }
                    this.addEffects(this.globalRelicEffects, definition.effects)
                    this.refreshGlobalRelicPower()
                    if (definition.family === 'heart') {
                        const hearts = Math.max(1, Math.round(3 * definition.power))
                        this.maxLives += hearts
                        this.state.lives = Math.min(this.maxLives, this.state.lives + hearts)
                    }
                }
            }
            this.choiceKind = null
            this.choices = []
            this.choiceKeys = []
            this.state.phase = command.type === 'relic-choice' ? 'planning' : 'planning'
            return true
        }
        const placement = this.validatePlacement(command)
        if (!placement.allowed) return false
        const defense = PATHWARDEN_DEFENSE_BLUEPRINTS.find(candidate => candidate.id === this.selectedTower)!
        const cost = placement.cost ?? 0
        this.state.aether -= cost
        this.spawnEntity({
            type: 1,
            components: {
                towerType: this.selectedTower,
                col: command.col,
                row: command.row,
                invested: cost,
                targeting: 'first'
            }
        }, command.col, command.row)
        this.towerPurchases[this.selectedTower] = Math.max(0, Math.floor(this.towerPurchases[this.selectedTower] ?? 0)) + 1
        return Boolean(defense)
    }

    private simulateWave() {
        if (this.state.phase !== 'wave' || this.state.paused) return
        if (this.spawnRemaining > 0) {
            if (this.spawnCooldown > 0) this.spawnCooldown--
            else {
                this.spawnEnemy()
                this.spawnRemaining--
                this.spawnCooldown = 5
            }
        }
        const enemies = this.getEntities().filter(entity => entity.data.type === 2)
        for (const enemy of enemies) {
            const components = enemy.data.components ?? {}
            const dotTimer = Math.max(0, Number(components.dotTimer ?? 0) - 1)
            const dotDamage = Math.max(0, Number(components.dotDamage ?? 0))
            const dotHp = Number(components.hp ?? 1) - (dotTimer > 0 ? dotDamage : 0)
            if (dotTimer > 0 && dotHp <= 0) {
                this.removeEntity(enemy.id)
                this.emitGameplayEvent(PathwardenGameplayEventType.EnemyDefeated, enemy.id, enemy.x, enemy.y)
                this.awardEnemyDefeat(components)
                continue
            }
            const slowTimer = Math.max(0, Number(components.slowTimer ?? 0) - 1)
            const slow = slowTimer > 0 ? Math.max(0, Number(components.slow ?? 0)) : 0
            const enemyType = String(components.enemyType ?? 'raider')
            const healTimer = Math.max(0, Number(components.healTimer ?? 44) - 1)
            if (enemyType === 'shaman' && healTimer === 0) {
                for (const ally of this.getEntities().filter(candidate => candidate.data.type === 2 && candidate.id !== enemy.id)) {
                    const allyComponents = ally.data.components ?? {}
                    const maxHp = Number(allyComponents.maxHp ?? 1)
                    const hp = Math.min(maxHp, Number(allyComponents.hp ?? maxHp) + maxHp * 0.08)
                    this.updateEntity(ally.id, { data: { type: 2, components: { ...allyComponents, hp } } })
                }
            }
            const progress = Number(components.progress ?? 0) + 0.012 * Number(components.speed ?? 1) * (1 - Math.min(0.8, slow))
            if (progress >= 1) {
                this.removeEntity(enemy.id)
                this.emitGameplayEvent(PathwardenGameplayEventType.EnemyLeak, enemy.id, enemy.x, enemy.y)
                this.state.lives = Math.max(0, this.state.lives - Math.max(1, Math.floor(Number(components.leakDamage ?? 1))))
                this.streak = 0
                this.state.streak = 0
                if (this.state.lives === 0) {
                    this.state.phase = 'defeat'
                    this.spawnRemaining = 0
                    return
                }
                continue
            }
            const exitKey = String(components.exitKey ?? 'castle-main')
            const position = this.routePosition(progress, this.enemyRouteForKey(exitKey))
            this.updateEntity(enemy.id, { x: position.col, y: position.row, data: { type: 2, components: { ...components, hp: dotHp, dotTimer, progress, slow, slowTimer, healTimer: enemyType === 'shaman' && healTimer === 0 ? 44 : healTimer } } })
        }
        this.simulateTowers()
        this.simulateProjectiles()
        this.simulateEffects()
        if (this.spawnRemaining === 0 && !this.getEntities().some(entity => entity.data.type === 2)) {
            if (this.state.lives >= this.waveStartingLives) {
                this.flawlessWaves++
                this.streak++
                this.state.flawlessWaves = this.flawlessWaves
                this.state.streak = this.streak
            }
            this.state.aether += 20 + this.state.wave * 4
            this.state.score += 100 * this.state.wave
            this.emitGameplayEvent(PathwardenGameplayEventType.WaveCleared, 0, 0, 0)
            if (this.state.wave % 4 === 0) {
                this.state.phase = 'checkpoint'
                this.choiceKind = 'checkpoint'
                this.choices = [0, 1, 2]
                this.choiceKeys = ['cashout', 'continue', 'bonus']
            } else {
                this.openNextChoice()
            }
        }
    }

    private spawnEnemy() {
        const routes = this.enemyRoutes()
        const routeEntry = routes[Math.max(0, this.spawnRemaining) % Math.max(1, routes.length)] ?? {
            key: 'castle-main',
            route: this.enemyRoute()
        }
        const route = routeEntry.route
        const start = route[route.length - 1] ?? { col: 80, row: 80 }
        const ordinal = Math.max(0, this.spawnRemaining)
        const enemyType = this.state.wave % 4 === 0 && this.spawnRemaining === 1
            ? 'boss'
            : this.state.wave >= 5 && ordinal % 7 === 0
                ? 'shaman'
                : this.state.wave >= 3 && ordinal % 5 === 0
                    ? 'brute'
                    : this.state.wave >= 2 && ordinal % 3 === 0 ? 'runner' : 'raider'
        const profile = {
            raider: { health: 1, speed: 1, reward: 1, leakDamage: 1 },
            runner: { health: 0.7, speed: 1.62, reward: 1.2, leakDamage: 1 },
            brute: { health: 2.5, speed: 0.72, reward: 2.1, leakDamage: 2 },
            shaman: { health: 1.5, speed: 0.88, reward: 2.4, leakDamage: 1 },
            boss: { health: 8.5, speed: 0.58, reward: 9, leakDamage: 5 }
        }[enemyType]
        const hp = (40 + this.state.wave * 12) * profile.health
        this.spawnEntity({
            type: 2,
            components: {
                enemyType,
                exitKey: routeEntry.key,
                progress: 0,
                hp,
                maxHp: hp,
                reward: (2 + this.state.wave) * profile.reward * this.boosts.bountyMultiplier * (1 + this.globalRelicEffects.aetherBonusPct / 100),
                speed: profile.speed,
                leakDamage: profile.leakDamage,
                healTimer: 44
            }
        }, start.col, start.row)
    }

    private simulateTowers() {
        const enemies = this.getEntities().filter(entity => entity.data.type === 2)
        if (!enemies.length) return
        for (const tower of this.getEntities().filter(entity => entity.data.type === 1)) {
            const components = tower.data.components ?? {}
            const defense = PATHWARDEN_DEFENSE_BLUEPRINTS.find(candidate => candidate.id === String(components.towerType ?? 'bolt'))
            if (!defense) continue
            const cooldown = Number(components.cooldown ?? 0)
            if (cooldown > 0) {
                this.updateEntity(tower.id, { data: { type: 1, components: { ...components, cooldown: cooldown - 1 } } })
                continue
            }
            const relicFamily = String(components.relicFamily ?? '')
            const relicPower = Number(components.relicPower ?? 0)
            const relicEffects = this.relicEffects(relicFamily, relicPower)
            const range = Math.max(2, defense.range / 45 * this.boosts.rangeMultiplier * (1 + (this.globalRelicEffects.rangePct + relicEffects.rangePct) / 100))
            const inRange = enemies.filter(enemy => Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= range)
            if (!inRange.length) continue
            const targeting = String(components.targeting ?? 'first')
            const target = [...inRange].sort((left, right) => targeting === 'strong'
                ? Number(right.data.components?.hp ?? 0) - Number(left.data.components?.hp ?? 0)
                : targeting === 'fast'
                    ? Number(right.data.components?.speed ?? 1) - Number(left.data.components?.speed ?? 1)
                    : Number(right.data.components?.progress ?? 0) - Number(left.data.components?.progress ?? 0))[0]!
            const shotCount = Number(components.relicShots ?? 0) + 1
            const nextCooldown = Math.max(1, Math.round(defense.rate * 20 / (this.boosts.rateMultiplier * (1 + (this.globalRelicEffects.attackSpeedPct + relicEffects.attackSpeedPct) / 100))))
            this.updateEntity(tower.id, { data: { type: 1, components: { ...components, cooldown: nextCooldown, relicShots: shotCount } } })
            const projectile = (damageMultiplier = 1) => this.spawnEntity({ type: 3, components: {
                towerType: String(components.towerType ?? 'bolt'),
                sourceId: tower.id,
                targetId: target.id,
                relicFamily,
                relicPower,
                damage: this.towerDamage(String(components.towerType ?? 'bolt'), Number(components.level ?? 1), relicPower, relicFamily) * this.boosts.damageMultiplier * damageMultiplier,
                splash: defense.splash / 45 + relicEffects.impactRadius / 45,
                impactDamagePct: relicEffects.impactDamagePct,
                chainCount: relicEffects.chainCount,
                chainRetentionPct: relicEffects.chainRetentionPct,
                slow: Math.max(defense.slow, relicEffects.slowPct / 100),
                burnDamage: relicEffects.burnPct > 0 ? this.towerDamage(String(components.towerType ?? 'bolt'), Number(components.level ?? 1), relicPower, relicFamily) * this.boosts.damageMultiplier * relicEffects.burnPct / 100 : 0,
                burnDuration: relicEffects.burnDuration * 20,
                aetherBonusPct: relicEffects.aetherBonusPct,
                progress: 0
            } }, tower.x, tower.y, 0, target.x, target.y)
            projectile()
            if (relicEffects.echoEveryShots > 0 && shotCount % Math.max(1, Math.floor(relicEffects.echoEveryShots)) === 0) {
                projectile(Math.max(0, relicEffects.echoPowerPct / 100))
            }
        }
    }

    private simulateProjectiles() {
        for (const projectile of this.getEntities().filter(entity => entity.data.type === 3)) {
            const components = projectile.data.components ?? {}
            const target = this.entities.get(Number(components.targetId))
            if (!target || target.data.type !== 2) {
                this.removeEntity(projectile.id)
                continue
            }
            const progress = Number(components.progress ?? 0) + 0.25
            const nextX = projectile.x + (target.x - projectile.x) * 0.25
            const nextY = projectile.y + (target.y - projectile.y) * 0.25
            if (progress >= 1) {
                this.removeEntity(projectile.id)
                const impactId = this.spawnEntity({ type: 6, components: { kind: 'impact', progress: 0, duration: 8, color: 'primary' } }, target.x, target.y)
                this.emitGameplayEvent(PathwardenGameplayEventType.Impact, impactId, target.x, target.y)
                const splash = Math.max(0, Number(components.splash ?? 0))
                const affected = this.getEntities().filter(candidate => candidate.data.type === 2
                    && Math.hypot(candidate.x - target.x, candidate.y - target.y) <= splash)
                const damageById = new Map<number, number>()
                const baseDamage = Number(components.damage ?? 1)
                const impactMultiplier = 1 + Math.max(0, Number(components.impactDamagePct ?? 0)) / 100
                for (const victim of affected) damageById.set(victim.id, baseDamage * impactMultiplier)
                const chainCount = Math.min(5, Math.max(0, Math.floor(Number(components.chainCount ?? 0))))
                if (chainCount > 0) {
                    const retention = Math.max(0, Math.min(1, Number(components.chainRetentionPct ?? 0) / 100))
                    this.getEntities()
                        .filter(candidate => candidate.data.type === 2 && candidate.id !== target.id && !damageById.has(candidate.id))
                        .sort((left, right) => Math.hypot(left.x - target.x, left.y - target.y) - Math.hypot(right.x - target.x, right.y - target.y))
                        .slice(0, chainCount)
                        .forEach((victim, index) => damageById.set(victim.id, baseDamage * Math.pow(retention, index + 1)))
                }
                for (const victim of this.getEntities().filter(entity => damageById.has(entity.id))) {
                    const victimComponents = victim.data.components ?? {}
                    const pierceBonus = String(components.relicFamily ?? '') === 'pierce'
                        && ['brute', 'boss'].includes(String(victimComponents.enemyType ?? ''))
                        ? 1 + this.relicEffects('pierce', Number(components.relicPower ?? 0)).armorPiercePct / 100
                        : 1
                    const hp = Number(victimComponents.hp ?? 1) - damageById.get(victim.id)! * pierceBonus
                    const slow = Math.max(Number(victimComponents.slow ?? 0), Number(components.slow ?? 0))
                    if (hp <= 0) {
                        this.removeEntity(victim.id)
                        this.emitGameplayEvent(PathwardenGameplayEventType.EnemyDefeated, victim.id, victim.x, victim.y)
                        this.awardEnemyDefeat(victimComponents, Number(components.aetherBonusPct ?? 0))
                    } else {
                        this.updateEntity(victim.id, { data: { type: 2, components: {
                            ...victimComponents,
                            hp,
                            slow,
                            slowTimer: slow > 0 ? 24 : Number(victimComponents.slowTimer ?? 0),
                            dotDamage: Math.max(Number(victimComponents.dotDamage ?? 0), Number(components.burnDamage ?? 0)),
                            dotTimer: Math.max(Number(victimComponents.dotTimer ?? 0), Number(components.burnDuration ?? 0))
                        } } })
                    }
                }
                if (String(components.relicFamily ?? '') === 'leech' && this.state.lives < this.maxLives) {
                    this.state.lives = Math.min(this.maxLives, this.state.lives + this.maxLives * 0.0012 * Number(components.relicPower ?? 0))
                }
            } else {
                this.updateEntity(projectile.id, { x: nextX, y: nextY, data: { type: 3, components: { ...components, progress } } })
            }
        }
    }

    private simulateEffects() {
        for (const effect of this.getEntities().filter(entity => entity.data.type === 6)) {
            const components = effect.data.components ?? {}
            const progress = Number(components.progress ?? 0) + 1
            if (progress >= Number(components.duration ?? 8)) this.removeEntity(effect.id)
            else this.updateEntity(effect.id, { data: { type: 6, components: { ...components, progress } } })
        }
    }

    private simulateAmbient() {
        if (this.state.phase !== 'planning' || this.state.paused) return
        const ambient = this.getEntities().find(entity => entity.data.type === 4)
        if (!ambient) {
            this.ambientCooldown--
            if (this.ambientCooldown > 0) return
            const road = this.mapPlan.rooms.find(room => this.claimedRooms.has(room.id))?.roadCells[0] ?? { col: 0, row: 0 }
            const storyId = this.nextAmbientStoryId
            const family = PATHWARDEN_AMBIENT_FAMILIES[Math.floor((storyId - 1) / 10)]!
            this.spawnEntity({
                type: 4,
                components: {
                    storyId,
                    progress: 0,
                    duration: 1800 + ((storyId * 7919 + this.state.seed) % 4201),
                    family: family.name,
                    kind: family.kind,
                    variant: (storyId - 1) % 10 + 1
                }
            }, road.col, road.row)
            this.nextAmbientStoryId = this.nextAmbientStoryId % 250 + 1
            this.ambientCooldown = 900 + ((this.nextAmbientStoryId * 3571 + this.state.seed) % 4501)
            return
        }
        const components = ambient.data.components ?? {}
        const progress = Number(components.progress ?? 0) + 1 / Number(components.duration ?? 120)
        if (progress >= 1) {
            this.removeEntity(ambient.id)
            this.state.aether += 5
            this.state.score += 5
            const storyId = Number(components.storyId ?? 1)
            this.emitGameplayEvent(PathwardenGameplayEventType.AmbientStoryCompleted, storyId, ambient.x, ambient.y)
            this.onAmbientStoryComplete(storyId)
        } else {
            this.updateEntity(ambient.id, { data: { type: 4, components: { ...components, progress } } })
        }
    }

    private relicEffects(family: string, power: number) {
        return pathwardenRelicEffects(family, power)
    }

    private awardEnemyDefeat(components: Record<string, number | string | boolean>, localAetherBonusPct = 0) {
        this.state.score += 10
        this.state.aether += Math.max(0, Number(components.reward ?? 0)) * (1 + localAetherBonusPct / 100)
        if (this.globalRelicEffects.repairPct > 0 && this.state.lives < this.maxLives) {
            this.state.lives = Math.min(this.maxLives, this.state.lives + this.maxLives * this.globalRelicEffects.repairPct / 100)
        }
    }

    private addEffects(target: PathwardenSavedRelicEffects, source: PathwardenSavedRelicEffects) {
        for (const key of Object.keys(target) as Array<keyof PathwardenSavedRelicEffects>) target[key] += source[key] ?? 0
        return target
    }

    private refreshGlobalRelicPower() {
        this.state.relicPower = Object.values(this.globalRelics).reduce((total, relic) => total + relic.power, 0)
    }

    private towerDamage(type: string, level: number, relicPower = 0, relicFamily = '') {
        const base = PATHWARDEN_DEFENSE_BLUEPRINTS.find(defense => defense.id === type)?.damage ?? 25
        const levelPower = level >= 3 ? 3.35 : level >= 2 ? 1.85 : 1
        const effects = this.relicEffects(relicFamily, relicPower)
        return base * levelPower * (1 + (this.globalRelicEffects.directDamagePct + effects.directDamagePct) / 100)
    }

    private spawnRelic(relic: PathwardenSavedRelic) {
        this.nextRelicInstanceId = Math.max(this.nextRelicInstanceId, relic.instanceId + 1)
        const baseEffects = relic.baseEffects ?? pathwardenRelicEffects(relic.family as never, relic.power)
        const effects = relic.effects ?? baseEffects
        this.spawnEntity({ type: 5, components: {
            instanceId: relic.instanceId,
            relicId: relic.id,
            family: relic.family,
            rarity: relic.rarity,
            name: relic.name,
            description: relic.description,
            towerSpecific: relic.towerSpecific,
            iconIndex: relic.iconIndex,
            power: relic.power,
            sellValue: relic.sellValue,
            color: relic.color ?? '#c4b5fd',
            variationSeed: relic.variationSeed ?? relic.instanceId,
            damageFactor: relic.damageFactor ?? 1,
            ...pathwardenRelicEffectComponents('baseEffect', baseEffects),
            ...pathwardenRelicEffectComponents('effect', effects)
        } }, 0, 0)
    }

    private relicFromEntity(entity: PathwardenEntity): PathwardenSavedRelic {
        const components = entity.data.components ?? {}
        const family = String(components.family ?? 'fire')
        const power = Number(components.power ?? 0.5)
        const fallbackEffects = pathwardenRelicEffects(family as never, power)
        return {
            instanceId: Number(components.instanceId ?? entity.id),
            id: String(components.relicId ?? `server-relic-${entity.id}`),
            family,
            rarity: String(components.rarity ?? 'common'),
            name: String(components.name ?? 'Server Relic'),
            description: String(components.description ?? 'A server-authoritative Pathwarden relic.'),
            towerSpecific: components.towerSpecific === true,
            iconIndex: Number(components.iconIndex ?? 0),
            power,
            sellValue: Number(components.sellValue ?? 15),
            color: String(components.color ?? '#c4b5fd'),
            variationSeed: Number(components.variationSeed ?? 1),
            damageFactor: Number(components.damageFactor ?? 1),
            baseEffects: pathwardenRelicEffectsFromComponents(components, 'baseEffect', fallbackEffects),
            effects: pathwardenRelicEffectsFromComponents(components, 'effect', fallbackEffects)
        }
    }

    private pathChoices() {
        const next = this.mapPlan.connections
            .filter(connection => this.claimedRooms.has(connection.fromRoomId) && !this.claimedRooms.has(connection.toRoomId))
            .map(connection => connection.toRoomId)
        return [...new Set(next)].slice(0, 3)
    }

    private openRelicChoice() {
        this.state.phase = 'upgrade'
        this.choiceKind = 'relic'
        this.choices = [0, 1, 2]
        this.choiceKeys = pathwardenRelicOfferIds(this.state.seed + this.state.tick)
        this.choiceRevision++
    }

    private openNextChoice() {
        const paths = this.pathChoices()
        if (paths.length) {
            this.state.phase = 'path'
            this.choiceKind = 'path'
            this.choices = paths.map((_, index) => index)
            this.choiceKeys = paths
            this.choiceRevision++
        } else this.openRelicChoice()
    }

    private cellKey(col: number, row: number) {
        return `${col}:${row}`
    }

    private validatePlacement(command: Extract<PathwardenInputCommand, { type: 'place-tower' }>) {
        const key = this.cellKey(command.col, command.row)
        const defense = PATHWARDEN_DEFENSE_BLUEPRINTS.find(candidate => candidate.id === this.selectedTower)
        if (this.state.phase !== 'planning') return { allowed: false, reason: 'Towers can only be placed during planning.' }
        if (!defense) return { allowed: false, reason: 'Unknown defense blueprint.' }
        if (!this.revealed.has(key)) return { allowed: false, reason: 'The mist still covers that ground.' }
        if (this.reservedRoads.has(key)) return { allowed: false, reason: 'Defenses cannot be built on the road.' }
        if (this.getEntities().some(entity => entity.data.type === 1 && entity.data.components?.col === command.col && entity.data.components?.row === command.row)) {
            return { allowed: false, reason: 'That ground already holds a defense.' }
        }
        const cost = this.towerCost(defense.id)
        if (this.state.aether < cost) return { allowed: false, reason: 'Not enough Aether.' }
        return { allowed: true, cost }
    }

    private validateTower(id: number, action: 'upgrade' | 'salvage') {
        if (this.state.phase !== 'planning') return false
        const tower = this.entities.get(id)
        if (!tower || tower.data.type !== 1) return false
        if (action === 'upgrade') {
            const level = Number(tower.data.components?.level ?? 1)
            return level < 3 && this.state.aether >= 40 * level
        }
        return true
    }

    private validateFuse(sourceId: number, targetId: number) {
        if (this.state.phase !== 'planning' || sourceId === targetId) return false
        const source = this.entities.get(sourceId)
        const target = this.entities.get(targetId)
        if (!source || !target || source.data.type !== 1 || target.data.type !== 1) return false
        const a = source.data.components ?? {}
        const b = target.data.components ?? {}
        return a.towerType === b.towerType && Number(a.level ?? 1) === Number(b.level ?? 1) && Number(b.level ?? 1) < 3
    }

    private validateMove(command: Extract<PathwardenInputCommand, { type: 'move-tower' }>) {
        if (this.state.phase !== 'planning') return false
        const tower = this.entities.get(command.id)
        if (!tower || tower.data.type !== 1) return false
        const key = this.cellKey(command.col, command.row)
        return this.revealed.has(key)
            && !this.reservedRoads.has(key)
            && !this.getEntities().some(entity => entity.id !== command.id && entity.data.type === 1 && entity.data.components?.col === command.col && entity.data.components?.row === command.row)
    }

    private validateTargeting(command: Extract<PathwardenInputCommand, { type: 'set-targeting' }>) {
        return this.state.phase === 'planning' && this.entities.get(command.id)?.data.type === 1
    }

    private validateRelicBinding(command: Extract<PathwardenInputCommand, { type: 'bind-relic' }>) {
        if (this.state.phase !== 'planning') return false
        return this.entities.get(command.towerId)?.data.type === 1 && this.entities.get(command.instanceId)?.data.type === 5
    }

    private validateRelicRebinding(command: Extract<PathwardenInputCommand, { type: 'rebind-relic' }>) {
        if (this.state.phase !== 'planning' || !Number.isSafeInteger(command.amount) || command.amount < 0 || command.amount > this.state.aether) return false
        const tower = this.entities.get(command.towerId)
        const relic = this.entities.get(command.instanceId)
        return Boolean(tower?.data.type === 1 && tower.data.components?.relicFamily && relic?.data.type === 5)
    }

    private towerCost(towerType: string) {
        const purchases = Math.max(0, Math.floor(this.towerPurchases[towerType] ?? 0))
        return pathwardenTowerPurchaseCost(towerType, purchases)
    }

    private enemyRoutes() {
        type Cell = { col: number, row: number }
        const key = (cell: Cell) => `${cell.col}:${cell.row}`
        const points = new Map<string, Cell>()
        const edges = new Map<string, Set<string>>()
        for (const link of this.mapPlan.roadLinks) {
            if (!this.claimedRooms.has(link.roomId)) continue
            const from = key(link.from)
            const to = key(link.to)
            points.set(from, { ...link.from })
            points.set(to, { ...link.to })
            if (!edges.has(from)) edges.set(from, new Set())
            if (!edges.has(to)) edges.set(to, new Set())
            edges.get(from)!.add(to)
            edges.get(to)!.add(from)
        }
        const origin = this.mapPlan.rooms.find(room => room.id === this.mapPlan.castleRoomId)?.origin ?? { col: 80, row: 80 }
        const originKey = key(origin)
        if (!edges.has(originKey)) return [{ key: 'castle-main', route: [origin, { col: origin.col + 1, row: origin.row + 1 }] }]
        const queue = [originKey]
        const previous = new Map<string, string | null>([[originKey, null]])
        for (let index = 0; index < queue.length; index++) {
            const current = queue[index]!
            for (const next of edges.get(current) ?? []) {
                if (previous.has(next)) continue
                previous.set(next, current)
                queue.push(next)
            }
        }
        const terminals = queue
            .filter(cell => cell !== originKey && (edges.get(cell)?.size ?? 0) <= 1)
            .sort()
        const targets = terminals.length ? terminals : queue.at(-1) ? [queue.at(-1)!] : []
        const routes = targets.map(target => {
            const route: Cell[] = []
            for (let current: string | null = target; current; current = previous.get(current) ?? null) route.push(points.get(current)!)
            route.reverse()
            return { key: target, route }
        }).filter(entry => entry.route.length > 1)
        return routes.length ? routes : [{ key: 'castle-main', route: [origin, { col: origin.col + 1, row: origin.row + 1 }] }]
    }

    private enemyRoute() {
        return this.enemyRoutes()[0]?.route ?? [{ col: 80, row: 80 }, { col: 81, row: 81 }]
    }

    private enemyRouteForKey(key: string) {
        return this.enemyRoutes().find(entry => entry.key === key)?.route ?? this.enemyRoute()
    }

    private routePosition(progress: number, route = this.enemyRoute()) {
        const index = Math.min(route.length - 1, Math.floor((1 - Math.max(0, progress)) * (route.length - 1)))
        return route[index]!
    }
}
