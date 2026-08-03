import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathwardenWorld } from '#server/pathwarden/world'

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
        expect(changes).toEqual([1])
        world.stop()
    })

    it('restores persisted render state without trusting client data', () => {
        const world = new PathwardenWorld({
            runId: 'run-2',
            revision: 4,
            realm: 2,
            seed: 99,
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
                relicInstanceId: 1
            }
        })
        expect(world.getSnapshot()).toMatchObject({ revision: 4, realm: 2, wave: 3, lives: 17, aether: 144, score: 880, paused: true })
    })
})
