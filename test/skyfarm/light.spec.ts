import { describe, expect, it } from 'vitest'
import { B, FURNACE_LIT } from '../../app/utils/skyfarm/blocks'
import { computeLight } from '../../app/utils/skyfarm/light'
import { World } from '../../app/utils/skyfarm/world'

/** A world with a closed stone box: walls from 4 to 8 on every axis, air inside (5 to 7). */
function boxWorld() {
    const world = new World()
    world.addChunk(0, 0)
    for (let x = 4; x <= 8; x++) {
        for (let y = 10; y <= 14; y++) {
            for (let z = 4; z <= 8; z++) {
                const wall = x === 4 || x === 8 || y === 10 || y === 14 || z === 4 || z === 8
                if (wall) world.set(x, y, z, B.Stone)
            }
        }
    }
    return world
}

describe('light', () => {
    it('is full daylight under the open sky', () => {
        const world = new World()
        world.addChunk(0, 0)
        world.set(3, 10, 3, B.Stone)
        const light = computeLight(world, 0, 0)
        expect(light.at(3, 11, 3)).toEqual([15, 0])
        // Sky light spreads in sideways under an overhang, a level a block.
        expect(light.at(3, 9, 3)[0]).toBe(14)
    })

    it('is dark inside a closed box', () => {
        const light = computeLight(boxWorld(), 0, 0)
        expect(light.at(6, 12, 6)).toEqual([0, 0])
    })

    it('falls off a level a block from a torch', () => {
        const world = boxWorld()
        world.set(6, 11, 6, B.Torch)
        const light = computeLight(world, 0, 0)
        expect(light.at(6, 11, 6)[1]).toBe(14)
        expect(light.at(6, 12, 6)[1]).toBe(13)
        expect(light.at(5, 11, 5)[1]).toBe(12)
        // None of it gets through the stone.
        expect(light.at(6, 11, 9)[1]).toBe(0)
    })

    it('comes from glowstone and jack o\'lanterns at full strength, and from a furnace only while it burns', () => {
        const world = boxWorld()
        world.set(6, 11, 6, B.Glowstone)
        expect(computeLight(world, 0, 0).at(6, 12, 6)[1]).toBe(14)
        world.set(6, 11, 6, B.Furnace)
        expect(computeLight(world, 0, 0).at(6, 12, 6)[1]).toBe(0)
        world.setMeta(6, 11, 6, FURNACE_LIT)
        expect(computeLight(world, 0, 0).at(6, 12, 6)[1]).toBe(12)
    })

    it('reaches across into the next chunk', () => {
        const world = new World()
        world.addChunk(0, 0)
        world.addChunk(1, 0)
        // A roofed tunnel along x, crossing the chunk border at x = 16.
        for (let x = 10; x <= 22; x++) {
            for (const [y, z] of [[9, 5], [11, 5], [10, 4], [10, 6]] as const) world.set(x, y, z, B.Stone)
        }
        world.set(10, 10, 5, B.Stone)
        world.set(22, 10, 5, B.Stone)
        world.set(14, 10, 5, B.Torch)
        expect(computeLight(world, 1, 0).at(18, 10, 5)[1]).toBe(10)
    })
})
