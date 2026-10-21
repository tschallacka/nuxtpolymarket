import { describe, expect, it } from 'vitest'
import { B, SLAB_BOTTOM } from '../../app/utils/skyfarm/blocks'
import { pick, stepBody, type Body } from '../../app/utils/skyfarm/player'
import { STARTER_TOP, World, starterIsland } from '../../app/utils/skyfarm/world'

/** Walks west (toward the island's edge at x = 4) for `seconds`. */
function walkWest(sneak: boolean, seconds: number) {
    const world = new World()
    starterIsland(world)
    const b: Body = { x: 5.5, y: STARTER_TOP, z: 5.5, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false }
    for (let t = 0; t < seconds; t += 1 / 60) stepBody(world, b, 1 / 60, [-1, 0], false, false, sneak)
    return b
}

describe('slabs', () => {
    it('step you up without a jump, but a full block stops you', () => {
        const world = new World()
        starterIsland(world)
        world.set(8, STARTER_TOP, 5, B.OakSlab, SLAB_BOTTOM)
        world.set(8, STARTER_TOP, 4, B.Dirt)
        const walkEast = (z: number) => {
            const b: Body = { x: 6.5, y: STARTER_TOP, z, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false }
            // Half a second: far enough to reach the slab (x 8..9), not past the island's edge.
            for (let t = 0; t < 0.5; t += 1 / 60) stepBody(world, b, 1 / 60, [1, 0], false, false)
            return b
        }
        const onSlab = walkEast(5.5)
        expect(onSlab.x).toBeGreaterThan(8.3)
        expect(onSlab.x).toBeLessThan(9)
        expect(onSlab.y).toBeCloseTo(STARTER_TOP + 0.5, 3)
        expect(walkEast(4.5).x).toBeLessThan(8)
    })

    it('can be looked through above a bottom slab, and hit on its top face', () => {
        const world = new World()
        starterIsland(world)
        world.set(6, STARTER_TOP, 5, B.StoneSlab, SLAB_BOTTOM)
        // A ray skimming over the slab's empty upper half goes on to the next block.
        world.set(8, STARTER_TOP, 5, B.Dirt)
        const over = pick(world, 5.5, STARTER_TOP + 0.75, 5.5, 1, 0, 0, 5)
        expect(over?.id).toBe(B.Dirt)
        // Looking down at it: the hit is on the slab's top, half way up the cell.
        const down = pick(world, 6.5, STARTER_TOP + 1.6, 5.5, 0, -1, 0, 5)
        expect(down?.id).toBe(B.StoneSlab)
        expect(down?.ny).toBe(1)
        expect(down?.py).toBeCloseTo(STARTER_TOP + 0.5, 6)
    })
})

describe('water', () => {
    it('lets you climb out of a one-deep channel onto the bank by swimming into it with jump held', () => {
        const world = new World()
        starterIsland(world)
        // A channel along the x arm: the grass row at z = 5 dug out and filled with water.
        for (let x = 4; x < 10; x++) world.set(x, STARTER_TOP - 1, 5, B.Water)
        const b: Body = { x: 6.5, y: STARTER_TOP - 1, z: 5.5, vx: 0, vy: 0, vz: 0, onGround: true, inWater: true }
        // Swim north (toward z = 4, the bank) holding jump, and let go once over it
        // (the bank is one block wide: carry on and you walk off the island).
        for (let t = 0; t < 2 && b.z > 4.6; t += 1 / 60) stepBody(world, b, 1 / 60, [0, -1], true, false)
        for (let t = 0; t < 1; t += 1 / 60) stepBody(world, b, 1 / 60, [0, 0], false, false)
        expect(b.z).toBeLessThan(5)
        expect(b.y).toBeCloseTo(STARTER_TOP, 3)
        expect(b.onGround).toBe(true)
    })

    it('does not climb a wall too tall to get over', () => {
        const world = new World()
        starterIsland(world)
        for (let x = 4; x < 10; x++) {
            world.set(x, STARTER_TOP - 1, 5, B.Water)
            world.set(x, STARTER_TOP, 4, B.Dirt)
            world.set(x, STARTER_TOP + 1, 4, B.Dirt)
        }
        const b: Body = { x: 6.5, y: STARTER_TOP - 1, z: 5.5, vx: 0, vy: 0, vz: 0, onGround: true, inWater: true }
        for (let t = 0; t < 2; t += 1 / 60) stepBody(world, b, 1 / 60, [0, -1], true, false)
        expect(b.z).toBeGreaterThan(5)
    })
})

describe('sneaking', () => {
    it('walking off the edge drops you into the void', () => {
        const b = walkWest(false, 3)
        expect(b.y).toBeLessThan(STARTER_TOP - 2)
    })

    it('stops you at the edge of the block you stand on', () => {
        const b = walkWest(true, 6)
        expect(b.y).toBe(STARTER_TOP)
        expect(b.onGround).toBe(true)
        // Hanging over the edge, but with the body's corner still over the grass (x 4 to 5).
        expect(b.x).toBeLessThan(4.3)
        expect(b.x + 0.3).toBeGreaterThan(4)
    })
})

describe('creative flight', () => {
    const fly = (seconds: number, wish: [number, number], jump: boolean, sneak: boolean, b: Body, world: World) => {
        for (let t = 0; t < seconds; t += 1 / 60) stepBody(world, b, 1 / 60, wish, jump, false, sneak, true)
    }

    it('hovers without falling, rises with jump and sinks with sneak, and walls still stop it', () => {
        // Open sky: an owned column with nothing in it.
        const world = new World()
        world.addChunk(0, 0)
        const b: Body = { x: 2.5, y: 30, z: 5.5, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false }
        fly(2, [0, 0], false, false, b, world)
        expect(b.y).toBeCloseTo(30, 3)
        fly(1, [0, 0], true, false, b, world)
        expect(b.y).toBeGreaterThan(35)
        const high = b.y
        // It carries its speed a moment (as in Minecraft), then sinks.
        fly(1.5, [0, 0], false, true, b, world)
        expect(b.y).toBeLessThan(high - 2)
        // Far faster than walking (4.3 a second).
        const x = b.x
        fly(1, [1, 0], false, false, b, world)
        expect(b.x - x).toBeGreaterThan(7)
        // A wall in the way stops it like walking does.
        for (let y = 0; y < 64; y++) world.set(Math.floor(b.x) + 2, y, Math.floor(b.z), B.Stone)
        fly(2, [1, 0], false, false, b, world)
        expect(b.x).toBeLessThan(Math.floor(b.x) + 2)
    })
})
