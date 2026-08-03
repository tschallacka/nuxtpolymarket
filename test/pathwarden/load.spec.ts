import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathwardenWorld } from '#server/pathwarden/world'
import { createPathwardenMapPlan } from '#shared/utils/gamelogic/pathwarden-map'

const mapPlan = createPathwardenMapPlan({ seed: 91, realm: 2 })
const worlds: PathwardenWorld[] = []

afterEach(() => {
    for (const world of worlds) world.stop()
    worlds.length = 0
    vi.useRealTimers()
})

describe('Pathwarden bounded realtime load', () => {
    it('advances several combat-heavy worlds without unbounded queues or entities', () => {
        vi.useFakeTimers()
        for (let index = 0; index < 16; index++) {
            const world = new PathwardenWorld({
                runId: `load-${index}`,
                revision: 0,
                realm: 2,
                seed: index + 100,
                mapPlan,
                gameState: null
            })
            world.spawnEntity({ type: 1, components: {
                towerType: 'bolt',
                col: 10,
                row: 10,
                level: 3,
                targeting: 'first',
                invested: 200
            } }, 10, 10)
            world.enqueue(1, { type: 'start-wave' })
            world.start()
            worlds.push(world)
        }

        vi.advanceTimersByTime(50 * 120)

        expect(worlds.every(world => world.getSnapshot().tick === 120)).toBe(true)
        expect(worlds.every(world => world.pendingCommandCount <= 256)).toBe(true)
        expect(Math.max(...worlds.map(world => world.getSnapshot().entityCount))).toBeLessThan(64)
    })
})
