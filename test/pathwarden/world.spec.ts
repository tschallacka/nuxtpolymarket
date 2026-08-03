import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathwardenWorld } from '#server/pathwarden/world'
import { pathwardenRelicDefinition, pathwardenRelicOfferIds } from '#shared/utils/gamelogic/pathwarden'
import { createPathwardenMapPlan } from '#shared/utils/gamelogic/pathwarden-map'

const mapPlan = createPathwardenMapPlan({ seed: 1, realm: 1 })

afterEach(() => {
    vi.useRealTimers()
})

describe('Pathwarden authoritative world', () => {
    it('advances on a fixed clock and applies queued commands once', () => {
        vi.useFakeTimers()
        const changes: number[] = []
        const world = new PathwardenWorld({
            runId: 'run-1',
            revision: 0,
            realm: 1,
            seed: 12,
            mapPlan,
            gameState: null
        })
        world.setChangeHandler(snapshot => changes.push(snapshot.tick))
        world.start()
        expect(world.getSnapshot().tick).toBe(0)

        world.enqueue(1, { type: 'start-wave' })
        world.enqueue(1, { type: 'pause', value: true })
        vi.advanceTimersByTime(50)

        expect(world.getSnapshot()).toMatchObject({ tick: 1, phase: 'wave', wave: 1, paused: false })
        expect(world.lastAppliedInput).toBe(1)
        expect(changes.length).toBeGreaterThan(0)
        expect(changes.every(tick => tick === 1)).toBe(true)
        world.stop()
    })

    it('restores persisted render state without trusting client data', () => {
        const world = new PathwardenWorld({
            runId: 'run-2',
            revision: 4,
            realm: 2,
            seed: 99,
            mapPlan,
            gameState: {
                phase: 'planning',
                paused: true,
                wave: 3,
                lives: 17,
                maxLives: 20,
                aether: 144,
                score: 880,
                streak: 2,
                flawlessWaves: 1,
                spawnLeft: 0,
                spawnTotal: 0,
                spawnTimer: 0,
                combatRandomState: 1,
                path: [],
                claimedRoomIds: [],
                activeRoomIds: [],
                selectedTower: 'bolt',
                towerPurchases: {},
                relicRanks: {},
                globalRelics: {},
                relicInventory: [],
                ashPiles: [],
                interest: 0,
                canSellRelics: false,
                towers: [],
                enemies: [],
                projectiles: [],
                towerId: 1,
                enemyId: 1,
                relicInstanceId: 1,
                lastInputSequence: 4
            }
        })
        expect(world.getSnapshot()).toMatchObject({ revision: 4, realm: 2, wave: 3, lives: 17, aether: 144, score: 880, paused: true })
        expect(world.lastAppliedInput).toBe(4)
    })

    it('locks permanent boost effects into a fresh authoritative world', () => {
        const world = new PathwardenWorld({
            runId: 'run-boosts',
            revision: 0,
            realm: 1,
            seed: 1,
            mapPlan,
            gameState: null,
            boosts: {
                startingLives: 24,
                startingAether: 260,
                damageMultiplier: 1.3,
                rangeMultiplier: 1.2,
                rateMultiplier: 1.1,
                bountyMultiplier: 1.25,
                arcanistLevel: 2
            }
        })
        expect(world.getSnapshot()).toMatchObject({ lives: 24, aether: 260 })
    })

    it('rejects commands outside the current phase before queueing them', () => {
        const world = new PathwardenWorld({ runId: 'run-3', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        expect(world.canApply({ type: 'place-tower', col: 1, row: 1 })).toBe(false)
        expect(world.canApply({ type: 'start-wave' })).toBe(true)
        world.enqueue(1, { type: 'start-wave' })
        expect(world.canApply({ type: 'start-wave' })).toBe(true)
    })

    it('allocates and owns entity lifecycle state through the world API', () => {
        const world = new PathwardenWorld({ runId: 'run-4', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const first = world.spawnEntity({ type: 4, components: { health: 100 } }, 10, 20, 1, 2, 3, 4)
        const second = world.spawnEntity({ type: 5 }, 2, 3)
        expect(first).toBe(1)
        expect(second).toBe(2)
        expect(world.getSnapshot().entityCount).toBe(2)
        expect(world.updateEntity(first, { x: 11, data: { type: 4, components: { health: 80 } } })).toBe(true)
        expect(world.getEntities()[0]).toMatchObject({ id: 1, x: 11, data: { components: { health: 80 } } })
        expect(world.removeEntity(second)).toBe(true)
        expect(world.getSnapshot().entityCount).toBe(1)
    })

    it('validates and applies a server-owned tower placement', () => {
        const world = new PathwardenWorld({ runId: 'run-5', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const road = mapPlan.rooms.find(room => room.id === mapPlan.castleRoomId)!.roadCells
        const candidate = Array.from({ length: 5 }, (_, index) => ({ col: road[0]!.col + index - 2, row: road[0]!.row + 3 }))
            .find(cell => world.canApply({ type: 'place-tower', ...cell }))
        expect(candidate).toBeDefined()
        expect(world.enqueue(1, { type: 'place-tower', ...candidate! })).toBe(true)
        world.setChangeHandler(() => {})
        // The fixed tick is the only mutation boundary.
        world.start()
        return new Promise<void>(resolve => {
            setTimeout(() => {
                world.stop()
                expect(world.getSnapshot().entityCount).toBe(1)
                expect(world.getSnapshot().aether).toBeLessThan(205)
                resolve()
            }, 55)
        })
    })

    it('applies building mutations only at the authoritative tick boundary', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-6', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const road = mapPlan.rooms.find(room => room.id === mapPlan.castleRoomId)!.roadCells
        const candidate = Array.from({ length: 5 }, (_, index) => ({ col: road[0]!.col + index - 2, row: road[0]!.row + 3 }))
            .find(cell => world.canApply({ type: 'place-tower', ...cell }))!
        world.enqueue(1, { type: 'place-tower', ...candidate })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()
        const tower = world.getEntities()[0]!
        expect(world.canApply({ type: 'upgrade-tower', id: tower.id })).toBe(true)
        world.enqueue(2, { type: 'upgrade-tower', id: tower.id })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()
        expect(world.getEntities()[0]!.data.components?.level).toBe(2)
        expect(world.canApply({ type: 'salvage-tower', id: tower.id })).toBe(true)
    })

    it('revalidates commands after earlier commands in the same tick mutate state', () => {
        vi.useFakeTimers()
        const source = new PathwardenWorld({ runId: 'run-6b-source', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        source.spawnEntity({ type: 1, components: { towerType: 'bolt', col: 10, row: 10, invested: 75, level: 1, targeting: 'first' } }, 10, 10, 0, 0, 0, 0, 1)
        const saved = source.exportGameState()
        saved.aether = 55
        const world = new PathwardenWorld({ runId: 'run-6b', revision: 0, realm: 1, seed: 1, mapPlan, gameState: saved })
        const tower = world.getEntities().find(entity => entity.data.type === 1)!
        world.enqueue(2, { type: 'upgrade-tower', id: tower.id })
        world.enqueue(3, { type: 'upgrade-tower', id: tower.id })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()

        expect(world.getEntities().find(entity => entity.id === tower.id)?.data.components?.level).toBe(2)
        expect(world.getSnapshot().aether).toBeGreaterThanOrEqual(0)
        expect(world.lastAppliedInput).toBe(3)
    })

    it('keeps relic inventory and binding on the server entity graph', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-7', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const towerId = world.spawnEntity({ type: 1, components: { towerType: 'bolt', col: 10, row: 10 } }, 10, 10)
        const relicId = world.spawnEntity({ type: 5, components: { instanceId: 8, relicId: 'fire-common', family: 'fire', power: 1, sellValue: 15 } }, 0, 0)
        expect(world.canApply({ type: 'bind-relic', towerId, instanceId: relicId })).toBe(true)
        world.enqueue(1, { type: 'bind-relic', towerId, instanceId: relicId })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()
        const tower = world.getEntities().find(entity => entity.id === towerId)!
        expect(tower.data.components).toMatchObject({ relicFamily: 'fire', relicStacks: 1, relicPower: 1 })
        expect(world.getEntities().some(entity => entity.id === relicId)).toBe(false)
    })

    it('resolves live relic rebinding on the authoritative tick', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-7b', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null, boosts: {
            startingLives: 20,
            startingAether: 205,
            damageMultiplier: 1,
            rangeMultiplier: 1,
            rateMultiplier: 1,
            bountyMultiplier: 1,
            arcanistLevel: 3
        } })
        const towerId = world.spawnEntity({ type: 1, components: { towerType: 'bolt', col: 10, row: 10, relicFamily: 'fire', relicId: 'fire-common', relicStacks: 2, relicPower: 2 } }, 10, 10)
        const relicId = world.spawnEntity({ type: 5, components: { instanceId: 8, relicId: 'frost-common', family: 'frost', power: 1, sellValue: 15 } }, 0, 0)
        world.enqueue(1, { type: 'rebind-relic', towerId, instanceId: relicId, amount: 40, focus: 'preservation' })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()

        const tower = world.getEntities().find(entity => entity.id === towerId)!
        expect(tower.data.components).toMatchObject({ relicFamily: 'frost', relicId: 'frost-common', relicStacks: 1, relicPower: 1 })
        expect(world.getEntities().some(entity => entity.id === relicId)).toBe(false)
        expect(world.getSnapshot().aether).toBe(165)
    })

    it('scales repeated tower purchases and refunds half the investment', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-8', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const road = mapPlan.rooms.find(room => room.id === mapPlan.castleRoomId)!.roadCells
        const candidates = Array.from({ length: 8 }, (_, index) => ({ col: road[0]!.col + index - 3, row: road[0]!.row + 3 }))
            .filter(cell => world.canApply({ type: 'place-tower', ...cell }))
        expect(candidates.length).toBeGreaterThanOrEqual(2)

        world.enqueue(1, { type: 'place-tower', ...candidates[0]! })
        world.start()
        vi.advanceTimersByTime(50)
        const first = world.getEntities().find(entity => entity.data.type === 1)!
        const afterFirst = world.getSnapshot().aether

        world.enqueue(2, { type: 'place-tower', ...candidates[1]! })
        vi.advanceTimersByTime(50)
        const towers = world.getEntities().filter(entity => entity.data.type === 1)
        const second = towers.find(entity => entity.id !== first.id)!
        const secondCost = afterFirst - world.getSnapshot().aether
        expect(secondCost).toBeGreaterThan(Number(first.data.components?.invested ?? 0))

        const beforeSalvage = world.getSnapshot().aether
        world.enqueue(3, { type: 'salvage-tower', id: second.id })
        vi.advanceTimersByTime(50)
        world.stop()
        expect(world.getSnapshot().aether).toBe(beforeSalvage + Math.floor(secondCost * 0.5))
        expect(world.exportGameState().towerPurchases.bolt).toBe(2)
    })

    it('keeps enemy movement on the server road graph', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-9', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        world.enqueue(1, { type: 'start-wave' })
        world.start()
        vi.advanceTimersByTime(100)
        world.stop()

        const enemy = world.getEntities().find(entity => entity.data.type === 2)
        expect(enemy).toBeDefined()
        const roadCells = mapPlan.rooms
            .filter(room => room.id === mapPlan.castleRoomId)
            .flatMap(room => room.roadCells)
        expect(roadCells).toContainEqual({ col: enemy!.x, row: enemy!.y })
    })

    it('moves enemies across adjacent authoritative road links', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-9a', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        world.enqueue(1, { type: 'start-wave' })
        world.start()
        vi.advanceTimersByTime(50 * 40)
        const enemy = world.getEntities().find(entity => entity.data.type === 2)
        const routeCells = new Set(mapPlan.roadLinks.flatMap(link => [
            `${link.from.col}:${link.from.row}`,
            `${link.to.col}:${link.to.row}`
        ]))
        world.stop()

        expect(enemy).toBeDefined()
        expect(routeCells.has(`${enemy!.x}:${enemy!.y}`)).toBe(true)
    })

    it('uses the authoritative enemy archetype schedule', () => {
        vi.useFakeTimers()
        const source = new PathwardenWorld({ runId: 'run-9b-source', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const saved = source.exportGameState()
        saved.wave = 3
        const world = new PathwardenWorld({ runId: 'run-9b', revision: 0, realm: 1, seed: 1, mapPlan, gameState: saved })
        world.enqueue(1, { type: 'start-wave' })
        world.start()
        vi.advanceTimersByTime(50 * 100)
        const types = new Set(world.getEntities().filter(entity => entity.data.type === 2).map(entity => entity.data.components?.enemyType))
        world.stop()

        expect([...types]).toEqual(expect.arrayContaining(['runner', 'brute']))
    })

    it('restores active combat entities and wave counters on reconnect', () => {
        const source = new PathwardenWorld({ runId: 'run-10', revision: 2, realm: 1, seed: 1, mapPlan, gameState: null })
        source.spawnEntity({ type: 1, components: { towerType: 'bolt', col: 10, row: 10, invested: 64, level: 2, targeting: 'strong' } }, 10, 10, 0, 0, 0, 0, 10)
        source.spawnEntity({ type: 2, components: { enemyType: 'brute', progress: 0.4, hp: 80, maxHp: 120, reward: 9 } }, 0, 0, 0, 0, 0, 0, 20)
        source.spawnEntity({ type: 3, components: { towerType: 'bolt', targetId: 20, damage: 32, progress: 0.5 } }, 4, 5, 0, 0, 0, 0, 30)
        const saved = source.exportGameState()
        saved.phase = 'wave'
        saved.wave = 3
        saved.spawnLeft = 4
        saved.spawnTotal = 7
        saved.spawnTimer = 2
        saved.lastInputSequence = 12

        const restored = new PathwardenWorld({ runId: 'run-10', revision: 3, realm: 1, seed: 1, mapPlan, gameState: saved })
        expect(restored.getSnapshot()).toMatchObject({ phase: 'wave', wave: 3, entityCount: 3 })
        expect(restored.lastAppliedInput).toBe(12)
        expect(restored.getEntities().map(entity => entity.id)).toEqual(expect.arrayContaining([10, 20, 30]))
        expect(restored.getEntities().find(entity => entity.id === 10)?.data.components).toMatchObject({ level: 2, targeting: 'strong' })
        expect(restored.getEntities().find(entity => entity.id === 20)?.data.components).toMatchObject({ enemyType: 'brute', hp: 80 })
        expect(restored.getEntities().find(entity => entity.id === 30)?.data.components).toMatchObject({ targetId: 20, damage: 32, splash: 0, slow: 0 })
    })

    it('emits one stable server gameplay event when a projectile impacts', () => {
        vi.useFakeTimers()
        const source = new PathwardenWorld({ runId: 'run-event', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        source.spawnEntity({ type: 2, components: { enemyType: 'raider', progress: 0, hp: 100, maxHp: 100, reward: 1 } }, 0, 0, 0, 0, 0, 0, 20)
        source.spawnEntity({ type: 3, components: { towerType: 'bolt', targetId: 20, damage: 1, progress: 0.75 } }, 0, 0, 0, 0, 0, 0, 30)
        const saved = source.exportGameState()
        saved.phase = 'wave'
        const world = new PathwardenWorld({ runId: 'run-event', revision: 0, realm: 1, seed: 1, mapPlan, gameState: saved })
        const events: Array<Array<{ id: number, type: number }>> = []
        world.setChangeHandler((_snapshot, _entities, tickEvents) => events.push(tickEvents))
        world.start()
        vi.advanceTimersByTime(50)
        vi.advanceTimersByTime(50)
        world.stop()

        const impactEvents = events.flat().filter(event => event.type === 1)
        expect(impactEvents).toHaveLength(1)
        expect(impactEvents[0]!.id).toBeGreaterThan(0)
        expect(new Set(impactEvents.map(event => event.id)).size).toBe(1)
    })

    it('bounds queued inputs before the tick can consume them', () => {
        const world = new PathwardenWorld({ runId: 'run-11', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        for (let sequence = 1; sequence <= 256; sequence++) {
            expect(world.enqueue(sequence, { type: 'select-tower', tower: 'bolt' })).toBe(true)
        }
        expect(world.pendingCommandCount).toBe(256)
        expect(world.enqueue(257, { type: 'select-tower', tower: 'bolt' })).toBe(false)
    })

    it('stages ambient stories on a slow deterministic schedule', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-12', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        world.start()
        vi.advanceTimersByTime(50 * 902)
        const ambient = world.getEntities().find(entity => entity.data.type === 4)
        world.stop()
        expect(ambient).toBeDefined()
        expect(Number(ambient!.data.components?.duration)).toBeGreaterThanOrEqual(1800)
        expect(Number(ambient!.data.components?.duration)).toBeLessThanOrEqual(6000)
        expect(ambient!.data.components).toMatchObject({ family: 'Market day', kind: 'market', variant: 1 })
    })

    it('restores an in-progress ambient actor after world reconstruction', () => {
        vi.useFakeTimers()
        const source = new PathwardenWorld({ runId: 'run-12b', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        source.start()
        vi.advanceTimersByTime(50 * 902)
        const saved = source.exportGameState()
        source.stop()

        const restored = new PathwardenWorld({ runId: 'run-12b', revision: 1, realm: 1, seed: 1, mapPlan, gameState: saved })
        const ambient = restored.getEntities().find(entity => entity.data.type === 4)
        expect(ambient?.data.components).toMatchObject({ storyId: 1, family: 'Market day', kind: 'market', variant: 1 })
        expect(Number(ambient?.data.components?.progress)).toBeCloseTo(Number(saved.ambientActor?.progress ?? 0))
    })

    it('rejects stale choice offer revisions', () => {
        const source = new PathwardenWorld({ runId: 'run-13', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const saved = source.exportGameState()
        saved.phase = 'checkpoint'
        const world = new PathwardenWorld({ runId: 'run-13', revision: 0, realm: 1, seed: 1, mapPlan, gameState: saved })
        expect(world.canApply({ type: 'checkpoint-choice', choice: 1, offerRevision: 0 })).toBe(false)
        expect(world.canApply({ type: 'checkpoint-choice', choice: 1, offerRevision: 1 })).toBe(true)
    })

    it('derives relic offers from the shared catalogue and materializes the selected definition', () => {
        vi.useFakeTimers()
        const world = new PathwardenWorld({ runId: 'run-relic-catalogue', revision: 0, realm: 1, seed: 17, mapPlan, gameState: null })
        const openRelicChoice = (world as unknown as { openRelicChoice: () => void }).openRelicChoice
        openRelicChoice.call(world)
        const offer = world.getChoiceOffer()!
        expect(offer.choiceKeys).toEqual(pathwardenRelicOfferIds(17))
        const selected = pathwardenRelicDefinition(offer.choiceKeys[1]!)!

        world.enqueue(1, { type: 'relic-choice', choice: 1, offerRevision: offer.offerRevision })
        world.start()
        vi.advanceTimersByTime(50)
        world.stop()

        const relic = world.getEntities().find(entity => entity.data.type === 5)!
        expect(relic.data.components).toMatchObject({
            relicId: `${selected.id}-1`,
            family: selected.family,
            rarity: selected.rarity,
            name: selected.name,
            description: selected.description,
            towerSpecific: selected.towerSpecific,
            iconIndex: selected.iconIndex,
            power: selected.power,
            sellValue: selected.sellValue,
            color: selected.color,
            effects: selected.effects
        })
    })

    it('applies bounded chain targets and impact damage on the authoritative projectile tick', () => {
        vi.useFakeTimers()
        const source = new PathwardenWorld({ runId: 'run-effects-source', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        const saved = source.exportGameState()
        saved.phase = 'wave'
        const world = new PathwardenWorld({ runId: 'run-effects', revision: 0, realm: 1, seed: 1, mapPlan, gameState: saved })
        const primary = world.spawnEntity({ type: 2, components: { hp: 100, progress: 1, speed: 1 } }, 1, 1)
        const chained = world.spawnEntity({ type: 2, components: { hp: 100, progress: 0.9, speed: 1 } }, 2, 1)
        const untouched = world.spawnEntity({ type: 2, components: { hp: 100, progress: 0.8, speed: 1 } }, 3, 1)
        world.spawnEntity({ type: 3, components: {
            targetId: primary,
            damage: 20,
            splash: 0,
            impactDamagePct: 50,
            chainCount: 1,
            chainRetentionPct: 50,
            progress: 0
        } }, 0, 1)
        const simulateProjectiles = (world as unknown as { simulateProjectiles: () => void }).simulateProjectiles
        for (let index = 0; index < 4; index++) simulateProjectiles.call(world)

        expect(world.getEntities().find(entity => entity.id === primary)?.data.components?.hp).toBe(70)
        expect(world.getEntities().find(entity => entity.id === chained)?.data.components?.hp).toBe(90)
        expect(world.getEntities().find(entity => entity.id === untouched)?.data.components?.hp).toBe(100)
    })

    it('emits a deterministic echo projectile on the shared cadence', () => {
        const world = new PathwardenWorld({ runId: 'run-echo', revision: 0, realm: 1, seed: 1, mapPlan, gameState: null })
        world.spawnEntity({ type: 1, components: { towerType: 'bolt', level: 1, relicFamily: 'chain', relicPower: 1, relicShots: 3, cooldown: 0 } }, 10, 10)
        world.spawnEntity({ type: 2, components: { hp: 100, progress: 0.5, speed: 1 } }, 11, 10)
        const simulateTowers = (world as unknown as { simulateTowers: () => void }).simulateTowers
        simulateTowers.call(world)
        const projectiles = world.getEntities().filter(entity => entity.data.type === 3)
        expect(projectiles).toHaveLength(2)
        expect(Number(projectiles[1]?.data.components?.damage)).toBeCloseTo(Number(projectiles[0]?.data.components?.damage) * 0.48)
    })
})
