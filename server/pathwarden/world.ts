import type { PathwardenGameState, PathwardenMapPlan } from '#shared/types/pathwarden-save'
import { PATHWARDEN_DEFENSE_BLUEPRINTS } from '#shared/utils/gamelogic/pathwarden'
import type {
    PathwardenInputCommand,
    PathwardenPhase,
    PathwardenWorldSnapshot
} from '#shared/pathwarden/protocol'

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
    private readonly claimedRooms = new Set<string>()
    private readonly revealed = new Set<string>()
    private readonly reservedRoads = new Set<string>()
    private readonly state: PathwardenWorldSnapshot
    private timer: ReturnType<typeof setInterval> | null = null
    private lastInputSequence = 0
    private nextEntityId = 1
    private selectedTower = 'bolt'
    private spawnRemaining = 0
    private spawnCooldown = 0
    private ambientCooldown = 80
    private nextAmbientStoryId = 1
    private choiceKind: 'checkpoint' | 'relic' | 'path' | null = null
    private choices: number[] = []
    private batching = false
    private dirty = false
    private onChange: (snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[]) => void = () => {}

    constructor(source: PathwardenWorldSource) {
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
            relicPower: Math.max(0, Number(source.gameState?.globalRelics?.server?.power ?? 0)),
            paused: source.gameState?.paused === true,
            entityCount: 0
        }
        for (const tower of source.gameState?.towers ?? []) {
            this.spawnEntity({ type: 1, components: { towerType: tower.type, col: tower.col, row: tower.row, invested: tower.invested } }, tower.col, tower.row)
        }
    }

    setChangeHandler(handler: (snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[]) => void) {
        this.onChange = snapshot => handler(snapshot, this.getEntities())
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
        if (!Number.isSafeInteger(inputSequence) || inputSequence <= this.lastInputSequence || !this.canApply(command)) return false
        this.commands.push({ inputSequence, command })
        return true
    }

    canApply(command: PathwardenInputCommand) {
        if (command.type === 'place-tower') return this.validatePlacement(command).allowed
        if (command.type === 'upgrade-tower') return this.validateTower(command.id, 'upgrade')
        if (command.type === 'fuse-tower') return this.validateFuse(command.sourceId, command.targetId)
        if (command.type === 'salvage-tower') return this.validateTower(command.id, 'salvage')
        if (command.type === 'move-tower') return this.validateMove(command)
        if (command.type === 'set-targeting') return this.validateTargeting(command)
        if (command.type === 'continue-checkpoint') return this.state.phase === 'checkpoint'
        if (command.type === 'claim-path') return this.state.phase === 'path' && this.choiceKind === 'path' && this.choices.includes(command.choice)
        if (command.type === 'pause') return !['victory', 'defeat', 'cashout'].includes(this.state.phase)
        if (command.type === 'start-wave') return this.state.phase === 'planning' && this.state.wave < 12
        if (command.type === 'checkpoint-choice') return this.choiceKind === 'checkpoint' && this.choices.includes(command.choice)
        if (command.type === 'relic-choice') return this.choiceKind === 'relic' && this.choices.includes(command.choice)
        return command.type === 'select-tower' && PATHWARDEN_DEFENSE_BLUEPRINTS.some(defense => defense.id === command.tower)
    }

    getChoiceOffer() {
        return this.choiceKind ? { kind: this.choiceKind, choices: [...this.choices] } : null
    }

    getSnapshot() {
        return { ...this.state }
    }

    spawnEntity(data: PathwardenEntityData, x: number, y: number, z = 0, v1 = 0, v2 = 0, v3 = 0) {
        if (!Number.isInteger(data.type) || data.type < 0 || data.type > 255) throw new Error('Invalid Pathwarden entity type')
        const entity: PathwardenEntity = {
            id: this.nextEntityId++,
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
            streak: 0,
            flawlessWaves: 0,
            spawnLeft: this.spawnRemaining,
            spawnTotal: this.spawnRemaining,
            spawnTimer: this.spawnCooldown,
            combatRandomState: this.state.seed,
            path: this.mapPlan.rooms.find(room => room.id === this.mapPlan.castleRoomId)?.roadCells ?? [],
            claimedRoomIds: [...this.claimedRooms],
            activeRoomIds: [...this.claimedRooms],
            selectedTower: this.selectedTower,
            towerPurchases: {},
            relicRanks: {},
            globalRelics: {
                server: { level: Math.round(this.state.relicPower * 10), power: this.state.relicPower }
            },
            relicInventory: [],
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
                level: 1,
                merges: 0,
                targeting: 'first' as const,
                relicStacks: 0,
                relicPower: 0,
                relicShots: 0
            })),
            enemies: entities.filter(entity => entity.data.type === 2).map(entity => ({
                id: entity.id,
                type: String(entity.data.components?.enemyType ?? 'raider'),
                route: [],
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
            projectiles: [],
            towerId: this.nextEntityId,
            enemyId: this.nextEntityId,
            relicInstanceId: 1
        }
    }

    get lastAppliedInput() {
        return this.lastInputSequence
    }

    private advance() {
        this.state.tick += 1
        this.batching = true
        const commands = this.commands.splice(0)
        let changed = commands.length > 0
        for (const queued of commands) {
            if (queued.inputSequence <= this.lastInputSequence) continue
            this.lastInputSequence = queued.inputSequence
            changed = this.apply(queued.command) || changed
        }
        this.simulateWave()
        this.simulateAmbient()
        this.batching = false
        if (changed || this.dirty || this.state.tick % 10 === 0) this.notifyChange()
        else this.dirty = false
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
            this.state.aether += Math.floor(Number(components.invested ?? 0) * 0.6)
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
        if (command.type === 'checkpoint-choice' || command.type === 'relic-choice') {
            if (!this.canApply(command)) return false
            this.state.aether += command.choice * 10
            if (command.type === 'relic-choice') {
                this.state.relicPower = Math.min(5, this.state.relicPower + (command.choice + 1) * 0.1)
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
            const progress = Number(components.progress ?? 0) + 0.012
            if (progress >= 1) {
                this.removeEntity(enemy.id)
                this.state.lives = Math.max(0, this.state.lives - 1)
                if (this.state.lives === 0) {
                    this.state.phase = 'defeat'
                    this.spawnRemaining = 0
                    return
                }
                continue
            }
            this.updateEntity(enemy.id, { x: progress * 100, y: progress * 100, data: { type: 2, components: { ...components, progress } } })
        }
        this.simulateTowers()
        this.simulateProjectiles()
        if (this.spawnRemaining === 0 && !this.getEntities().some(entity => entity.data.type === 2)) {
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
        const route = this.mapPlan.rooms.find(room => room.id === this.mapPlan.castleRoomId)?.roadCells ?? []
        const start = route[0] ?? { col: 80, row: 80 }
        const hp = 40 + this.state.wave * 12
        this.spawnEntity({
            type: 2,
            components: {
                enemyType: this.state.wave >= 5 && this.spawnRemaining % 5 === 0 ? 'brute' : 'raider',
                progress: 0,
                hp,
                maxHp: hp,
                reward: 2 + this.state.wave
            }
        }, start.col, start.row)
    }

    private simulateTowers() {
        const enemies = this.getEntities().filter(entity => entity.data.type === 2)
        if (!enemies.length) return
        for (const tower of this.getEntities().filter(entity => entity.data.type === 1)) {
            const components = tower.data.components ?? {}
            const cooldown = Number(components.cooldown ?? 0)
            if (cooldown > 0) {
                this.updateEntity(tower.id, { data: { type: 1, components: { ...components, cooldown: cooldown - 1 } } })
                continue
            }
            const target = enemies[0]!
            this.updateEntity(tower.id, { data: { type: 1, components: { ...components, cooldown: 8 } } })
            this.spawnEntity({ type: 3, components: {
                sourceId: tower.id,
                targetId: target.id,
                damage: this.towerDamage(String(components.towerType ?? 'bolt')),
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
                const hp = Number(target.data.components?.hp ?? 1) - Number(components.damage ?? 1)
                this.removeEntity(projectile.id)
                if (hp <= 0) {
                    this.removeEntity(target.id)
                    this.state.score += 10
                } else {
                    this.updateEntity(target.id, { data: { type: 2, components: { ...target.data.components, hp } } })
                }
            } else {
                this.updateEntity(projectile.id, { x: nextX, y: nextY, data: { type: 3, components: { ...components, progress } } })
            }
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
                components: { storyId: this.nextAmbientStoryId++, progress: 0, duration: 120, kind: 'market' }
            }, road.col, road.row)
            this.ambientCooldown = 260
            return
        }
        const components = ambient.data.components ?? {}
        const progress = Number(components.progress ?? 0) + 1 / Number(components.duration ?? 120)
        if (progress >= 1) {
            this.removeEntity(ambient.id)
            this.state.aether += 5
            this.state.score += 5
        } else {
            this.updateEntity(ambient.id, { data: { type: 4, components: { ...components, progress } } })
        }
    }

    private towerDamage(type: string) {
        return (PATHWARDEN_DEFENSE_BLUEPRINTS.find(defense => defense.id === type)?.damage ?? 25) * (1 + this.state.relicPower)
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
    }

    private openNextChoice() {
        const paths = this.pathChoices()
        if (paths.length) {
            this.state.phase = 'path'
            this.choiceKind = 'path'
            this.choices = paths.map((_, index) => index)
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
        if (this.state.aether < defense.aetherCost) return { allowed: false, reason: 'Not enough Aether.' }
        return { allowed: true, cost: defense.aetherCost }
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
}
