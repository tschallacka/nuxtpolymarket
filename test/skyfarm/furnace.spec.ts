import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { B, FURNACE_LIT } from '../../app/utils/skyfarm/blocks'
import { FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, FURNACE_SLOTS, idleFurnace, SMELT_TICKS, stepFurnace } from '../../app/utils/skyfarm/furnace'
import { Island } from '../../app/utils/skyfarm/island'
import { Slots } from '../../app/utils/skyfarm/items'
import { STARTER_TOP } from '../../app/utils/skyfarm/world'

function loaded(input: string, inputCount: number, fuel: string | null, fuelCount = 1) {
    const box = new Slots(FURNACE_SLOTS)
    box.slots[FURNACE_INPUT] = { item: input, count: inputCount }
    if (fuel) box.slots[FURNACE_FUEL] = { item: fuel, count: fuelCount }
    return box
}

const run = (box: Slots, ticks: number) => {
    const f = idleFurnace()
    let lit = false
    for (let i = 0; i < ticks; i++) lit = stepFurnace(box, f)
    return { f, lit }
}

describe('a furnace', () => {
    it('smelts one item every ten seconds while it burns', () => {
        const box = loaded('cobblestone', 8, 'coal')
        run(box, SMELT_TICKS)
        expect(box.slots[FURNACE_OUTPUT]).toEqual({ item: 'stone', count: 1 })
        expect(box.slots[FURNACE_INPUT]!.count).toBe(7)
        expect(box.slots[FURNACE_FUEL]).toBeNull()
    })

    it('smelts eight items on one coal', () => {
        const box = loaded('sand', 20, 'coal', 2)
        run(box, 1600)
        expect(box.slots[FURNACE_OUTPUT]).toEqual({ item: 'glass', count: 8 })
        // The second coal is still waiting: the first burns its last tick.
        expect(box.slots[FURNACE_FUEL]!.count).toBe(1)
    })

    it('does nothing without fuel, or with nothing that smelts', () => {
        const cold = loaded('cobblestone', 4, null)
        expect(run(cold, 400).lit).toBe(false)
        expect(cold.slots[FURNACE_OUTPUT]).toBeNull()
        const dirt = loaded('dirt', 4, 'coal')
        run(dirt, 400)
        expect(dirt.slots[FURNACE_FUEL]!.count).toBe(1)
        expect(dirt.slots[FURNACE_OUTPUT]).toBeNull()
    })

    it('burns lava out of its bucket and keeps the bucket', () => {
        const box = loaded('oak_log', 1, 'lava_bucket')
        run(box, SMELT_TICKS)
        expect(box.slots[FURNACE_OUTPUT]).toEqual({ item: 'charcoal', count: 1 })
        expect(box.slots[FURNACE_FUEL]).toEqual({ item: 'bucket', count: 1 })
    })

    it('stops when the output is full', () => {
        const box = loaded('cobblestone', 4, 'coal')
        box.slots[FURNACE_OUTPUT] = { item: 'stone', count: 64 }
        run(box, 400)
        expect(box.slots[FURNACE_INPUT]!.count).toBe(4)
        // Nothing to do, so the coal is never lit.
        expect(box.slots[FURNACE_FUEL]!.count).toBe(1)
    })
})

describe('a furnace on the island', () => {
    const ground = { x: 6, y: STARTER_TOP - 1, z: 6, nx: 0, ny: 1, nz: 0, id: B.Grass, py: STARTER_TOP }

    function withFurnace() {
        const island = Island.fresh()
        island.inventory.add('furnace', 1)
        // Looking north (yaw 0): the front turns south, to face the player.
        expect(island.placeAgainst(0, ground, () => false, 0)).toBe(true)
        expect(island.world.meta(6, STARTER_TOP, 6) & 3).toBe(2)
        return island
    }

    it('lights up while it smelts and goes out when done', () => {
        const island = withFurnace()
        const { box } = island.furnace(6, STARTER_TOP, 6)!
        box.slots[FURNACE_INPUT] = { item: 'cobblestone', count: 1 }
        box.slots[FURNACE_FUEL] = { item: 'stick', count: 1 }
        island.step()
        expect(island.world.meta(6, STARTER_TOP, 6) & FURNACE_LIT).toBeTruthy()
        for (let i = 0; i < 200; i++) island.step()
        expect(island.world.meta(6, STARTER_TOP, 6) & FURNACE_LIT).toBe(0)
        // A stick burns for 100 ticks, half an item: the cobblestone cooled back down unsmelted.
        expect(box.slots[FURNACE_OUTPUT]).toBeNull()
        // The facing survived the lighting up.
        expect(island.world.meta(6, STARTER_TOP, 6) & 3).toBe(2)
    })

    it('keeps its slots and its fire through a save', () => {
        const island = withFurnace()
        const { box } = island.furnace(6, STARTER_TOP, 6)!
        box.slots[FURNACE_INPUT] = { item: 'cobblestone', count: 5 }
        box.slots[FURNACE_FUEL] = { item: 'coal', count: 1 }
        for (let i = 0; i < 50; i++) island.step()
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!)
        const f = back.furnace(6, STARTER_TOP, 6)!
        expect(f.box.slots.length).toBe(FURNACE_SLOTS)
        // The coal lit on the first tick, which also began the smelt.
        expect(f.state).toEqual({ burn: 1551, burnMax: 1600, cook: 50 })
        expect(f.box.slots[FURNACE_INPUT]!.count).toBe(5)
    })

    it('spills its slots when broken', () => {
        const island = withFurnace()
        const { box } = island.furnace(6, STARTER_TOP, 6)!
        box.slots[FURNACE_INPUT] = { item: 'sand', count: 3 }
        island.breakBlock(6, STARTER_TOP, 6, 'wooden_pickaxe')
        expect(island.inventory.count('sand')).toBe(3)
        expect(island.inventory.count('furnace')).toBe(1)
        expect(island.furnaces.size).toBe(0)
    })

    it('is not extrapolated into chests over a long absence', () => {
        const island = withFurnace()
        const { box } = island.furnace(6, STARTER_TOP, 6)!
        box.slots[FURNACE_INPUT] = { item: 'cobblestone', count: 64 }
        box.slots[FURNACE_FUEL] = { item: 'coal', count: 8 }
        island.container(8, STARTER_TOP, 5)!.add('stone', 1)
        island.catchUp(3 * 60 * 60 * 1000)
        expect(island.container(8, STARTER_TOP, 5)!.count('stone')).toBe(1)
    })
})
