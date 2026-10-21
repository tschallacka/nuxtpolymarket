import { describe, expect, it } from 'vitest'
import { B } from '../../app/utils/skyfarm/blocks'
import { Island } from '../../app/utils/skyfarm/island'
import { DOWN, EAST_FOR_TEST, REP_POWERED, UP } from './redstone-helpers'

/** A flat stone floor at y = 10 over the first chunk, nothing else. */
function floor() {
    const island = new Island()
    island.world.addChunk(0, 0)
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) island.world.set(x, 10, z, B.Stone)
    island.step()
    return island
}

const run = (island: Island, ticks: number) => {
    for (let i = 0; i < ticks; i++) island.step()
}
const power = (island: Island, x: number, z: number) => island.world.meta(x, 11, z) & 15

describe('dust', () => {
    it('carries a lever\'s power, a level less each block, out to fifteen', () => {
        const island = floor()
        for (let x = 1; x < 16; x++) island.world.set(x, 11, 5, B.RedstoneDust)
        island.world.set(0, 11, 5, B.Lever)
        run(island, 1)
        expect(power(island, 1, 5)).toBe(0)
        island.redstone.toggleLever(0, 11, 5)
        run(island, 1)
        expect(power(island, 1, 5)).toBe(15)
        expect(power(island, 5, 5)).toBe(11)
        expect(power(island, 15, 5)).toBe(1)
        island.redstone.toggleLever(0, 11, 5)
        run(island, 1)
        expect(power(island, 5, 5)).toBe(0)
    })

    it('links to dust beside it and draws as a line', () => {
        const island = floor()
        for (let x = 3; x < 6; x++) island.world.set(x, 11, 5, B.RedstoneDust)
        run(island, 1)
        // East and west neighbours: bits for east (2) and west (8).
        expect((island.world.meta(4, 11, 5) >> 4) & 15).toBe(2 | 8)
    })
})

describe('the redstone torch', () => {
    it('goes out two ticks after the block it is on is powered, and powers dust', () => {
        const island = floor()
        island.world.set(5, 11, 5, B.Stone)
        // A torch on the east side of the stone, leaning east (wall meta 1), dust beyond it.
        island.world.set(6, 11, 5, B.RedstoneTorch, 1)
        island.world.set(7, 11, 5, B.RedstoneDust)
        // A lever on the stone's west face (pointing west: wall meta 3); only that powers the stone.
        island.world.set(4, 11, 5, B.Lever, 3)
        run(island, 1)
        expect(power(island, 7, 5)).toBe(15)
        island.redstone.toggleLever(4, 11, 5)
        expect(island.world.meta(6, 11, 5) & 8).toBe(0)
        run(island, 2)
        expect(island.world.meta(6, 11, 5) & 8).toBe(8)
        expect(power(island, 7, 5)).toBe(0)
    })

    it('burns out when it flickers too fast (a torch looking at itself)', () => {
        const island = floor()
        // A torch on a block, with dust from the torch back around to the block: a fast clock.
        island.world.set(5, 11, 5, B.Stone)
        island.world.set(6, 11, 5, B.RedstoneTorch, 1)
        island.world.set(6, 10, 6, B.Stone)
        island.world.set(6, 11, 6, B.RedstoneDust)
        island.world.set(5, 11, 6, B.RedstoneDust)
        run(island, 200)
        // It stopped toggling: lit or out, it isn't still flickering every two ticks.
        const a = island.world.meta(6, 11, 5) & 8
        run(island, 2)
        expect(island.world.meta(6, 11, 5) & 8).toBe(a)
    })
})

describe('the repeater', () => {
    it('passes a signal on after its delay, at full strength', () => {
        const island = floor()
        // Lever, dust to the repeater (pointing east), dust after.
        island.world.set(1, 11, 5, B.Lever)
        for (let x = 2; x < 4; x++) island.world.set(x, 11, 5, B.RedstoneDust)
        island.world.set(4, 11, 5, B.Repeater, EAST_FOR_TEST | (3 << 2))
        island.world.set(5, 11, 5, B.RedstoneDust)
        run(island, 1)
        island.redstone.toggleLever(1, 11, 5)
        run(island, 7)
        expect(island.world.meta(4, 11, 5) & REP_POWERED).toBe(0)
        run(island, 1)
        expect(island.world.meta(4, 11, 5) & REP_POWERED).toBe(REP_POWERED)
        run(island, 1)
        expect(power(island, 5, 5)).toBe(15)
    })

    it('cycles its delay', () => {
        const island = floor()
        island.world.set(4, 11, 5, B.Repeater, EAST_FOR_TEST)
        island.redstone.cycleRepeater(4, 11, 5)
        expect((island.world.meta(4, 11, 5) >> 2) & 3).toBe(1)
    })
})

describe('pistons', () => {
    it('push a row of blocks and a sticky one pulls one back', () => {
        const island = floor()
        // A sticky piston pushing east, with three blocks in front and a lever behind.
        island.world.set(3, 11, 5, B.StickyPiston, EAST_FOR_TEST)
        for (let x = 4; x < 7; x++) island.world.set(x, 11, 5, B.Cobblestone)
        island.world.set(2, 11, 5, B.Lever)
        run(island, 1)
        island.redstone.toggleLever(2, 11, 5)
        run(island, 2)
        expect(island.world.get(4, 11, 5)).toBe(B.PistonHead)
        expect([5, 6, 7].map(x => island.world.get(x, 11, 5))).toEqual([B.Cobblestone, B.Cobblestone, B.Cobblestone])
        island.redstone.toggleLever(2, 11, 5)
        run(island, 2)
        // Only the block the head touched comes back, leaving a gap behind it.
        expect([4, 5, 6, 7].map(x => island.world.get(x, 11, 5))).toEqual([B.Cobblestone, B.Air, B.Cobblestone, B.Cobblestone])
    })

    it('can\'t move obsidian, and break a torch in the way', () => {
        const island = floor()
        island.world.set(3, 11, 5, B.Piston, EAST_FOR_TEST)
        island.world.set(4, 11, 5, B.Obsidian)
        island.world.set(2, 11, 5, B.Lever)
        run(island, 1)
        island.redstone.toggleLever(2, 11, 5)
        run(island, 2)
        expect(island.world.get(4, 11, 5)).toBe(B.Obsidian)
        expect(island.world.meta(3, 11, 5) & 8).toBe(0)
        island.world.set(4, 11, 5, B.Torch)
        run(island, 2)
        expect(island.world.get(4, 11, 5)).toBe(B.PistonHead)
        expect(island.inventory.count('torch')).toBe(1)
    })
})

describe('the observer', () => {
    it('pulses out of its back when the block it watches changes', () => {
        const island = floor()
        // Looking west (its face toward x = 4), dust behind it to the east.
        island.world.set(5, 11, 5, B.Observer, 3)
        island.world.set(6, 11, 5, B.RedstoneDust)
        run(island, 3)
        expect(power(island, 6, 5)).toBe(0)
        island.world.set(4, 11, 5, B.Cobblestone)
        run(island, 3)
        expect(power(island, 6, 5)).toBe(15)
        run(island, 3)
        expect(power(island, 6, 5)).toBe(0)
    })
})

describe('hoppers, droppers and the store', () => {
    it('a hopper pulls from a chest above and pushes into one it points at, and stops while powered', () => {
        const island = floor()
        island.world.set(5, 13, 5, B.Chest)
        island.containerAt(5, 13, 5)!.add('cobblestone', 3)
        island.world.set(5, 12, 5, B.Hopper, DOWN)
        island.world.set(5, 11, 5, B.Chest)
        run(island, 40)
        expect(island.containerAt(5, 11, 5)!.count('cobblestone')).toBe(3)
        // Locked by a lever beside it.
        island.containerAt(5, 13, 5)!.add('cobblestone', 3)
        island.world.set(6, 12, 5, B.Lever, 0)
        island.world.set(6, 11, 5, B.Stone)
        island.redstone.toggleLever(6, 12, 5)
        run(island, 40)
        expect(island.containerAt(5, 11, 5)!.count('cobblestone')).toBe(3)
    })

    it('a hopper feeds a furnace from above, and the store through a depot', () => {
        const island = floor()
        island.world.set(5, 12, 5, B.Hopper, DOWN)
        island.containerAt(5, 12, 5)!.add('cobblestone', 2)
        island.world.set(5, 11, 5, B.Furnace)
        run(island, 20)
        expect(island.furnace(5, 11, 5)!.box.slots[0]).toEqual({ item: 'cobblestone', count: 2 })
        island.world.set(8, 12, 8, B.Hopper, DOWN)
        island.containerAt(8, 12, 8)!.add('wheat', 2)
        island.world.set(8, 11, 8, B.Depot)
        run(island, 20)
        expect(island.store.get('wheat')).toBe(2)
    })

    it('a dropper passes one item on per pulse; the block breaker mines what it faces into a hopper below', () => {
        const island = floor()
        island.world.set(5, 11, 5, B.Dropper, EAST_FOR_TEST)
        island.containerAt(5, 11, 5)!.add('stick', 5)
        island.world.set(6, 11, 5, B.Chest)
        island.world.set(4, 11, 5, B.Button, 0)
        island.redstone.pressButton(4, 11, 5)
        run(island, 30)
        expect(island.containerAt(6, 11, 5)!.count('stick')).toBe(1)
        // A breaker looking up at stone, a hopper... the drop lands in the hopper under the broken block's place.
        island.world.set(9, 12, 9, B.BlockBreaker, UP)
        island.world.set(9, 13, 9, B.Cobblestone)
        island.world.set(8, 11, 9, B.Stone)
        island.world.set(8, 12, 9, B.Lever)
        island.redstone.toggleLever(8, 12, 9)
        run(island, 6)
        expect(island.world.get(9, 13, 9)).toBe(B.Air)
        expect(island.inventory.count('cobblestone')).toBe(1)
    })
})
