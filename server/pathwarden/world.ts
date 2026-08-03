import type { PathwardenGameState, PathwardenMapPlan, PathwardenSavedRelic } from '#shared/types/pathwarden-save'
import { PATHWARDEN_DEFENSE_BLUEPRINTS } from '#shared/utils/gamelogic/pathwarden'
import type {
    PathwardenInputCommand,
    PathwardenPhase,
    PathwardenWorldSnapshot,
    PathwardenGameplayEvent
} from '#shared/pathwarden/protocol'
import { hashPathwardenState, recordPathwardenReplay } from '#server/pathwarden/replay'

export interface PathwardenWorldSource {
    runId: string
    revision: number
    realm: number
    seed: number
    mapPlan: PathwardenMapPlan
    gameState: PathwardenGameState | null
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

export class PathwardenWorld {
    private readonly commands: QueuedCommand[] = []
    private readonly entities = new Map<number, PathwardenEntity>()
    private readonly mapPlan: PathwardenMapPlan
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
    private choiceKind: 'checkpoint' | 'relic' | 'path' | null = null
    private choiceRevision = 0
    private choices: number[] = []
    private batching = false
    private dirty = false
    private onChange: (snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[]) => void = () => {}
    private onAmbientStoryComplete: (storyId: number) => void = () => {}
    private onTickMetrics: (durationMs: number, entityCount: number, pendingCommands: number) => void = () => {}

    constructor(source: PathwardenWorldSource) {
        this.runId = source.runId
        this.mapPlan = source.mapPlan
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
            lives: Math.max(0, source.gameState?.lives ?? 20),
            aether: Math.max(0, source.gameState?.aether ?? 205),
            score: Math.max(0, source.gameState?.score ?? 0),
            streak: Math.max(0, source.gameState?.streak ?? 0),
            flawlessWaves: Math.max(0, source.gameState?.flawlessWaves ?? 0),
            relicPower: Math.max(0, Number(source.gameState?.globalRelics?.server?.power ?? 0)),
            paused: source.gameState?.paused === true,
            entityCount: 0,
            claimedRoomIds: [...this.claimedRooms],
            revealedCells: []
        }
        this.lastInputSequence = Math.max(0, Math.floor(source.gameState?.lastInputSequence ?? 0))
        this.towerPurchases = { ...(source.gameState?.towerPurchases ?? {}) }
        this.selectedTower = source.gameState?.selectedTower ?? 'bolt'
        this.waveStartingLives = Math.max(0, source.gameState?.lives ?? this.state.lives)
        this.streak = this.state.streak
        this.flawlessWaves = this.state.flawlessWaves
        this.spawnRemaining = Math.max(0, Math.floor(source.gameState?.spawnLeft ?? 0))
        this.spawnCooldown = Math.max(0, Math.floor(source.gameState?.spawnTimer ?? 0))
        this.ambientCooldown = 900 + (source.seed % 4501)
        if (this.state.phase === 'checkpoint') {
            this.choiceKind = 'checkpoint'
            this.choices = [0, 1, 2]
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
            const position = this.routePosition(enemy.progress)
            this.spawnEntity({ type: 2, components: {
                enemyType: enemy.type,
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
        if (command.type === 'pause') return !['victory', 'defeat', 'cashout'].includes(this.state.phase)
        if (command.type === 'start-wave') return this.state.phase === 'planning' && this.state.wave < 12
        if (command.type === 'checkpoint-choice') return this.choiceKind === 'checkpoint' && command.offerRevision === this.choiceRevision && this.choices.includes(command.choice)
        if (command.type === 'relic-choice') return this.choiceKind === 'relic' && command.offerRevision === this.choiceRevision && this.choices.includes(command.choice)
        return command.type === 'select-tower' && PATHWARDEN_DEFENSE_BLUEPRINTS.some(defense => defense.id === command.tower)
    }

    getChoiceOffer() {
        return this.choiceKind ? { kind: this.choiceKind, choices: [...this.choices], offerRevision: this.choiceRevision } : null
    }

    getSnapshot() {
        return {
            ...this.state,
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
        return {
            phase: this.state.phase,
            paused: this.state.paused,
            wave: this.state.wave,
            lives: this.state.lives,
            maxLives: 20,
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
                server: { level: Math.round(this.state.relicPower * 10), power: this.state.relicPower }
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
                id: entity.id,
                type: String(entity.data.components?.enemyType ?? 'raider'),
                route: this.enemyRoute(),
                exitKey: 'castle-main',
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
            lastInputSequence: this.lastInputSequence
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
        if (command.type === 'checkpoint-choice' || command.type === 'relic-choice') {
            if (!this.canApply(command)) return false
            this.state.aether += command.choice * 10
            if (command.type === 'relic-choice') {
                this.state.relicPower = Math.min(5, this.state.relicPower + (command.choice + 1) * 0.1)
                this.spawnRelic({
                    instanceId: this.nextRelicInstanceId++,
                    id: `server-relic-${this.state.tick}-${command.choice}`,
                    family: ['fire', 'frost', 'bounty'][command.choice] ?? 'fire',
                    rarity: 'common',
                    name: ['Flame Arrows', 'Rime Arrows', 'Verdant Bounty'][command.choice] ?? 'Server Relic',
                    description: 'A server-authoritative Pathwarden relic.',
                    towerSpecific: command.choice < 2,
                    iconIndex: command.choice,
                    power: (command.choice + 1) * 0.5,
                    sellValue: 15 + command.choice * 5,
                    color: '#c4b5fd'
                })
            }
            this.choiceKind = null
            this.choices = []
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
                this.state.score += 10
                this.state.aether += Math.max(0, Number(components.reward ?? 0))
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
            const position = this.routePosition(progress)
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
            if (this.state.wave % 4 === 0) {
                this.state.phase = 'checkpoint'
                this.choiceKind = 'checkpoint'
                this.choices = [0, 1, 2]
            } else {
                this.openNextChoice()
            }
        }
    }

    private spawnEnemy() {
        const route = this.enemyRoute()
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
                progress: 0,
                hp,
                maxHp: hp,
                reward: (2 + this.state.wave) * profile.reward,
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
            const range = Math.max(2, defense.range / 45)
            const inRange = enemies.filter(enemy => Math.hypot(enemy.x - tower.x, enemy.y - tower.y) <= range)
            if (!inRange.length) continue
            const targeting = String(components.targeting ?? 'first')
            const target = [...inRange].sort((left, right) => targeting === 'strong'
                ? Number(right.data.components?.hp ?? 0) - Number(left.data.components?.hp ?? 0)
                : targeting === 'fast'
                    ? Number(right.data.components?.speed ?? 1) - Number(left.data.components?.speed ?? 1)
                    : Number(right.data.components?.progress ?? 0) - Number(left.data.components?.progress ?? 0))[0]!
            const relicFamily = String(components.relicFamily ?? '')
            const relicPower = Number(components.relicPower ?? 0)
            const relicEffects = this.relicEffects(relicFamily, relicPower)
            this.updateEntity(tower.id, { data: { type: 1, components: { ...components, cooldown: Math.max(1, Math.round(defense.rate * 20 / (1 + relicEffects.attackSpeedPct / 100))) } } })
            this.spawnEntity({ type: 3, components: {
                towerType: String(components.towerType ?? 'bolt'),
                sourceId: tower.id,
                targetId: target.id,
                relicFamily,
                relicPower,
                damage: this.towerDamage(String(components.towerType ?? 'bolt'), Number(components.level ?? 1), relicPower, relicFamily),
                splash: defense.splash / 45 + relicEffects.impactRadius / 45,
                slow: Math.max(defense.slow, relicEffects.slowPct / 100),
                burnDamage: relicEffects.burnPct > 0 ? this.towerDamage(String(components.towerType ?? 'bolt'), Number(components.level ?? 1), relicPower, relicFamily) * relicEffects.burnPct / 100 : 0,
                burnDuration: relicEffects.burnDuration * 20,
                progress: 0
            } }, tower.x, tower.y, 0, target.x, target.y)
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
                this.events.push({ id: this.nextEventId++, type: 1, entityId: impactId, x: target.x, y: target.y, z: 0, v1: 0, v2: 0, v3: 0 })
                const splash = Math.max(0, Number(components.splash ?? 0))
                const affected = this.getEntities().filter(candidate => candidate.data.type === 2
                    && Math.hypot(candidate.x - target.x, candidate.y - target.y) <= splash)
                for (const victim of affected) {
                    const victimComponents = victim.data.components ?? {}
                    const hp = Number(victimComponents.hp ?? 1) - Number(components.damage ?? 1)
                    const slow = Math.max(Number(victimComponents.slow ?? 0), Number(components.slow ?? 0))
                    if (hp <= 0) {
                        this.removeEntity(victim.id)
                        this.state.score += 10
                        this.state.aether += Math.max(0, Number(victimComponents.reward ?? 0))
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
            this.spawnEntity({
                type: 4,
                components: {
                    storyId: this.nextAmbientStoryId,
                    progress: 0,
                    duration: 1800 + ((this.nextAmbientStoryId * 7919 + this.state.seed) % 4201),
                    kind: 'market'
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
            this.onAmbientStoryComplete(Number(components.storyId ?? 1))
        } else {
            this.updateEntity(ambient.id, { data: { type: 4, components: { ...components, progress } } })
        }
    }

    private relicEffects(family: string, power: number) {
        const directDamagePct: Record<string, number> = { fire: 6, frost: 4, storm: 3, venom: 3, blast: 6, leech: 4, pierce: 10, chain: 2, gale: 2, radiant: 4 }
        return {
            directDamagePct: (directDamagePct[family] ?? 0) * power,
            burnPct: family === 'fire' ? 18 * power : family === 'venom' ? 24 * power : 0,
            burnDuration: family === 'fire' ? 3 : family === 'venom' ? 4 : 0,
            slowPct: family === 'frost' ? 22 + 4 * power : 0,
            impactRadius: family === 'blast' ? 46 + power * 8 : family === 'radiant' ? 52 + power * 7 : 0,
            attackSpeedPct: family === 'gale' ? 7 * power : family === 'haste' ? 8 * power : 0
        }
    }

    private towerDamage(type: string, level: number, relicPower = 0, relicFamily = '') {
        const base = PATHWARDEN_DEFENSE_BLUEPRINTS.find(defense => defense.id === type)?.damage ?? 25
        const levelPower = level >= 3 ? 3.35 : level >= 2 ? 1.85 : 1
        const effects = this.relicEffects(relicFamily, relicPower)
        return base * levelPower * (1 + this.state.relicPower + Math.max(0, relicPower) + effects.directDamagePct / 100)
    }

    private spawnRelic(relic: PathwardenSavedRelic) {
        this.nextRelicInstanceId = Math.max(this.nextRelicInstanceId, relic.instanceId + 1)
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
            color: relic.color ?? '#c4b5fd'
        } }, 0, 0)
    }

    private relicFromEntity(entity: PathwardenEntity): PathwardenSavedRelic {
        const components = entity.data.components ?? {}
        return {
            instanceId: Number(components.instanceId ?? entity.id),
            id: String(components.relicId ?? `server-relic-${entity.id}`),
            family: String(components.family ?? 'fire'),
            rarity: String(components.rarity ?? 'common'),
            name: String(components.name ?? 'Server Relic'),
            description: String(components.description ?? 'A server-authoritative Pathwarden relic.'),
            towerSpecific: components.towerSpecific === true,
            iconIndex: Number(components.iconIndex ?? 0),
            power: Number(components.power ?? 0.5),
            sellValue: Number(components.sellValue ?? 15),
            color: String(components.color ?? '#c4b5fd')
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
        this.choiceRevision++
    }

    private openNextChoice() {
        const paths = this.pathChoices()
        if (paths.length) {
            this.state.phase = 'path'
            this.choiceKind = 'path'
            this.choices = paths.map((_, index) => index)
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

    private towerCost(towerType: string) {
        const defense = PATHWARDEN_DEFENSE_BLUEPRINTS.find(candidate => candidate.id === towerType)
        if (!defense) return Number.POSITIVE_INFINITY
        const purchases = Math.max(0, Math.floor(this.towerPurchases[towerType] ?? 0))
        return Math.round(defense.aetherCost * (1 + purchases * 0.28))
    }

    private enemyRoute() {
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
        if (!edges.has(originKey)) return [origin, { col: origin.col + 1, row: origin.row + 1 }]
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
        const terminals = queue.filter(cell => cell !== originKey && (edges.get(cell)?.size ?? 0) <= 1)
        const target = terminals.sort((left, right) => right.localeCompare(left))[0] ?? queue.at(-1)
        if (!target) return [origin, { col: origin.col + 1, row: origin.row + 1 }]
        const route: Cell[] = []
        for (let current: string | null = target; current; current = previous.get(current) ?? null) route.push(points.get(current)!)
        route.reverse()
        return route.length > 1 ? route : [origin, { col: origin.col + 1, row: origin.row + 1 }]
    }

    private routePosition(progress: number) {
        const route = this.enemyRoute()
        const index = Math.min(route.length - 1, Math.floor((1 - Math.max(0, progress)) * (route.length - 1)))
        return route[index]!
    }
}
