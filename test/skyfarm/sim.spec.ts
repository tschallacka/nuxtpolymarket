import { describe, expect, it } from 'vitest'
import { B } from '../../app/utils/skyfarm/blocks'
import { chunkPrice } from '../../app/utils/skyfarm/economy'
import { stepBody, type Body } from '../../app/utils/skyfarm/player'
import { fluidFlow, Sim, TICKS_PER_SECOND } from '../../app/utils/skyfarm/sim'
import { STARTER_TOP, World, starterIsland } from '../../app/utils/skyfarm/world'

/**
 * The classic one-wide generator along x at y = 11:
 *   x0 water source | x1 floor | x2 a drop the water falls into | x3 the cobble cell | x4 lava source
 * Walls on both sides (z 4 and 6) keep it in its trench.
 */
function generator(roll?: () => number) {
    const world = new World()
    world.addChunk(0, 0)
    for (let x = 0; x <= 4; x++) {
        world.set(x, 10, 5, x === 2 ? B.Air : B.Stone)
        world.set(x, 11, 4, B.Stone)
        world.set(x, 11, 6, B.Stone)
    }
    world.set(2, 9, 5, B.Stone)
    world.set(2, 10, 4, B.Stone)
    world.set(2, 10, 6, B.Stone)
    world.set(-1, 11, 5, B.Stone)
    world.set(5, 11, 5, B.Stone)
    const sim = new Sim(world, roll)
    world.set(0, 11, 5, B.Water)
    world.set(4, 11, 5, B.Lava)
    return { world, sim }
}

describe('flowing water', () => {
    it('flows away from its source, and a still pool does not flow', () => {
        const world = new World()
        starterIsland(world)
        const sim = new Sim(world)
        // A source on the grass: it spreads, and the flow next to it runs away from it.
        world.set(6, STARTER_TOP, 5, B.Water)
        sim.run(5 * TICKS_PER_SECOND)
        expect(world.get(7, STARTER_TOP, 5)).toBe(B.Water)
        const [fx] = fluidFlow(world, 7, STARTER_TOP, 5)
        expect(fx).toBeGreaterThan(0.5)
        // Water walled in on every side at one level does not move.
        const pool = new World()
        pool.addChunk(0, 0)
        for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) pool.set(x, 0, z, B.Stone)
        for (let x = 1; x < 4; x++) for (let z = 1; z < 4; z++) pool.set(x, 1, z, B.Water)
        for (const [x, z] of [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [4, 0], [4, 1], [4, 2], [4, 3], [4, 4], [1, 0], [2, 0], [3, 0], [1, 4], [2, 4], [3, 4]]) pool.set(x!, 1, z!, B.Stone)
        expect(fluidFlow(pool, 2, 1, 2)).toEqual([0, 0])
    })

    it('carries a player standing in it', () => {
        const world = new World()
        starterIsland(world)
        const sim = new Sim(world)
        world.set(4, STARTER_TOP, 5, B.Water)
        sim.run(5 * TICKS_PER_SECOND)
        // Stand in the flow two blocks downstream, doing nothing: it pushes east.
        const b: Body = { x: 6.5, y: STARTER_TOP, z: 5.5, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false }
        for (let t = 0; t < 0.5; t += 1 / 60) stepBody(world, b, 1 / 60, [0, 0], false, false)
        expect(b.x).toBeGreaterThan(6.7)
    })
})

describe('fire', () => {
    /** Lava in a stone pit, with a wooden wall beside it on the starter island's grass. */
    function lavaByWood() {
        const world = new World()
        starterIsland(world)
        const sim = new Sim(world)
        const top = STARTER_TOP
        // The lava sits in a hole in the grass at (6, top - 1, 5); planks stand next to it.
        world.set(6, top - 1, 5, B.Lava)
        for (let y = top; y < top + 3; y++) for (let z = 4; z <= 6; z++) world.set(7, y, z, B.OakPlanks)
        const planks = () => {
            let n = 0
            for (let y = top; y < top + 3; y++) for (let z = 4; z <= 6; z++) if (world.get(7, y, z) === B.OakPlanks) n++
            return n
        }
        return { world, sim, planks }
    }

    it('lava sets wood beside it alight, and it burns away', () => {
        const { sim, planks } = lavaByWood()
        expect(planks()).toBe(9)
        sim.run(5 * 60 * TICKS_PER_SECOND)
        expect(planks()).toBeLessThan(9)
    })

    it('does not start or spread while catching up on time away', () => {
        const { sim, planks } = lavaByWood()
        sim.fireEnabled = false
        sim.run(5 * 60 * TICKS_PER_SECOND)
        expect(planks()).toBe(9)
        expect(sim.fires.size).toBe(0)
    })

    it('goes out on stone with nothing to burn, and water puts it out', () => {
        const world = new World()
        world.addChunk(0, 0)
        for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) world.set(x, 0, z, B.Stone)
        const sim = new Sim(world)
        world.set(3, 1, 3, B.Fire)
        sim.run(30 * TICKS_PER_SECOND)
        expect(world.get(3, 1, 3)).toBe(B.Air)
        // Water flowing over a fire replaces it.
        world.set(5, 1, 5, B.Fire)
        sim.fireEnabled = false
        world.set(4, 1, 5, B.Water)
        sim.run(5 * TICKS_PER_SECOND)
        expect(world.get(5, 1, 5)).toBe(B.Water)
    })
})

describe('the void', () => {
    it('swallows water poured off the edge instead of letting it pool at the bottom', () => {
        const world = new World()
        starterIsland(world)
        const sim = new Sim(world)
        // A source on the grass at the island's edge: it spreads, runs off and falls.
        world.set(4, STARTER_TOP, 4, B.Water)
        sim.run(60 * TICKS_PER_SECOND)
        // Below the island there are only waterfalls (falling water), never a spreading pool.
        let falling = 0, pooled = 0
        for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
                for (let y = 0; y < STARTER_TOP - 3; y++) {
                    if (world.get(x, y, z) !== B.Water) continue
                    if (world.meta(x, y, z) & 8) falling++
                    else pooled++
                }
            }
        }
        expect(falling).toBeGreaterThan(0)
        expect(pooled).toBe(0)
        expect(world.get(4, STARTER_TOP, 4)).toBe(B.Water)
    })
})

describe('the cobblestone generator', () => {
    it('forms cobblestone where the lava meets the water, and never obsidian', () => {
        const { world, sim } = generator(() => 0.99)
        sim.run(10 * TICKS_PER_SECOND)
        expect(world.get(3, 11, 5)).toBe(B.Cobblestone)
        expect(world.get(4, 11, 5)).toBe(B.Lava)
        expect(world.get(0, 11, 5)).toBe(B.Water)
    })

    it('makes a new block every time the last one is mined', () => {
        const { world, sim } = generator(() => 0.99)
        sim.run(10 * TICKS_PER_SECOND)
        for (let i = 0; i < 5; i++) {
            world.set(3, 11, 5, B.Air)
            sim.run(5 * TICKS_PER_SECOND)
            expect(world.get(3, 11, 5)).toBe(B.Cobblestone)
        }
        expect(sim.formed.get(B.Cobblestone)).toBe(6)
    })

    it('makes ores instead once upgraded, at the upgrade\'s odds', () => {
        const { world, sim } = generator(() => 0)
        sim.oreLevel = 4
        sim.run(10 * TICKS_PER_SECOND)
        // A roll of 0 lands in the first (rarest) bracket.
        expect(world.get(3, 11, 5)).toBe(B.DiamondOre)
    })
})

describe('water', () => {
    it('spreads seven blocks along a floor and no further', () => {
        const world = new World()
        world.addChunk(0, 0)
        for (let x = 0; x < 16; x++) world.set(x, 10, 0, B.Stone)
        const sim = new Sim(world)
        world.set(0, 11, 0, B.Water)
        sim.run(20 * TICKS_PER_SECOND)
        for (let x = 0; x <= 7; x++) expect(world.get(x, 11, 0), `x ${x}`).toBe(B.Water)
        expect(world.get(8, 11, 0)).toBe(B.Air)
    })

    it('fills the gap between two sources: infinite water', () => {
        const world = new World()
        world.addChunk(0, 0)
        for (let x = 0; x < 3; x++) world.set(x, 10, 0, B.Stone)
        const sim = new Sim(world)
        world.set(0, 11, 0, B.Water)
        world.set(2, 11, 0, B.Water)
        sim.run(5 * TICKS_PER_SECOND)
        expect(world.get(1, 11, 0)).toBe(B.Water)
        expect(world.meta(1, 11, 0) & 7).toBe(0)
    })

    it('stays on the island: it does not flow over the edge of owned land', () => {
        const world = new World()
        world.addChunk(0, 0)
        world.set(15, 10, 0, B.Stone)
        const sim = new Sim(world)
        world.set(15, 11, 0, B.Water)
        sim.run(5 * TICKS_PER_SECOND)
        expect(world.ownsAt(16, 11, 0)).toBe(false)
        expect(world.get(15, 11, 0)).toBe(B.Water)
    })
})

describe('the starting island', () => {
    it('is the classic L with a tree and a chest, on owned land', () => {
        const world = new World()
        const { spawn, chest } = starterIsland(world)
        expect(world.get(Math.floor(spawn.x), STARTER_TOP - 1, Math.floor(spawn.z))).toBe(B.Grass)
        expect(world.get(chest.x, chest.y, chest.z)).toBe(B.Chest)
        expect(world.get(8, STARTER_TOP - 1, 8)).toBe(B.Air) // the L's missing corner
        expect(world.get(5, STARTER_TOP, 8)).toBe(B.OakLog)
    })
})

describe('island chunks', () => {
    it('cost 1.2x more each', () => {
        expect(chunkPrice(1) / chunkPrice(0)).toBeCloseTo(1.2, 2)
        expect(chunkPrice(0)).toBe(50_000)
        expect(chunkPrice(10)).toBe(Math.round(50_000 * 1.2 ** 10))
    })
})
