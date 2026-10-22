import { describe, expect, it } from 'vitest'
import { B, FLOWERS, GRASS_FLOWERS, UPPER } from '../../app/utils/skyfarm/blocks'
import { COMPOST, Island } from '../../app/utils/skyfarm/island'
import { item } from '../../app/utils/skyfarm/items'
import { itemId } from '#shared/utils/skyfarm/item-ids'
import { EAST_FOR_TEST } from './redstone-helpers'

/** One chunk with a 16x16 grass floor at y = 10, at noon. */
function meadow() {
    const island = new Island()
    island.world.addChunk(0, 0)
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) island.world.set(x, 10, z, B.Grass)
    island.time = 6000
    island.weather = { kind: 'clear', ticksLeft: 1e6 }
    return island
}

/** Puts `count` of `key` in the inventory and returns its slot. */
function give(island: Island, key: string, count = 1) {
    island.inventory.add(key, count)
    return island.inventory.slots.findIndex(s => s?.item === key)
}

const settle = (island: Island) => {
    for (let i = 0; i < 5; i++) island.step()
}

const boneMeal = (island: Island, x: number, y: number, z: number) => {
    const slot = give(island, 'bone_meal')
    return island.useItem(slot, { x, y, z, id: island.world.get(x, y, z) })
}

describe('bone meal on grass', () => {
    it('sprouts a flower now and then among the short grass, plains flowers only', () => {
        let flowers = 0, grass = 0
        const kinds = new Set<number>()
        const allowed = new Set(GRASS_FLOWERS.map(([id]) => id))
        for (let n = 0; n < 40; n++) {
            const island = meadow()
            expect(boneMeal(island, 8, 10, 8)).toBe(true)
            for (let x = 0; x < 16; x++) {
                for (let z = 0; z < 16; z++) {
                    const id = island.world.get(x, 11, z)
                    if (id === B.TallGrass || id === B.DoubleTallGrass) grass++
                    else if (id !== B.Air) {
                        expect(allowed.has(id)).toBe(true)
                        flowers++
                        kinds.add(id)
                    }
                }
            }
        }
        // One in eight of what sprouts is a flower.
        const share = flowers / (flowers + grass)
        expect(share).toBeGreaterThan(0.06)
        expect(share).toBeLessThan(0.2)
        expect(kinds.size).toBeGreaterThan(4)
    })

    it('grows short grass into tall grass, given room above', () => {
        const island = meadow()
        island.world.set(4, 11, 4, B.TallGrass)
        expect(boneMeal(island, 4, 11, 4)).toBe(true)
        expect(island.world.get(4, 11, 4)).toBe(B.DoubleTallGrass)
        expect(island.world.get(4, 12, 4)).toBe(B.DoubleTallGrass)
        expect(island.world.meta(4, 12, 4) & UPPER).toBe(UPPER)
        settle(island)
        expect(island.world.get(4, 12, 4)).toBe(B.DoubleTallGrass)
        // No room: nothing happens, and the bone meal is kept.
        island.world.set(6, 11, 6, B.TallGrass)
        island.world.set(6, 12, 6, B.Stone)
        expect(boneMeal(island, 6, 11, 6)).toBe(false)
        expect(island.inventory.count('bone_meal')).toBe(1)
    })

    it('does nothing to a small flower', () => {
        const island = meadow()
        island.world.set(4, 11, 4, B.Poppy)
        expect(boneMeal(island, 4, 11, 4)).toBe(false)
    })
})

describe('tall flowers', () => {
    it('place as two halves, given ground and room', () => {
        const island = meadow()
        const slot = give(island, 'sunflower', 3)
        expect(island.placeFromSlot(slot, 4, 11, 4)).toBe(true)
        expect(island.world.get(4, 11, 4)).toBe(B.Sunflower)
        expect(island.world.get(4, 12, 4)).toBe(B.Sunflower)
        expect(island.world.meta(4, 12, 4) & UPPER).toBe(UPPER)
        // Not on stone, nor under a ceiling.
        island.world.set(6, 10, 6, B.Stone)
        expect(island.placeFromSlot(slot, 6, 11, 6)).toBe(false)
        island.world.set(8, 12, 8, B.Stone)
        expect(island.placeFromSlot(slot, 8, 11, 8)).toBe(false)
        expect(island.inventory.count('sunflower')).toBe(2)
        settle(island)
        expect(island.world.get(4, 12, 4)).toBe(B.Sunflower)
    })

    it('drop another of themselves for bone meal, from either half, and stay', () => {
        for (const [key, id] of [['sunflower', B.Sunflower], ['lilac', B.Lilac], ['rose_bush', B.RoseBush], ['peony', B.Peony]] as const) {
            const island = meadow()
            island.placeFromSlot(give(island, key), 4, 11, 4)
            expect(boneMeal(island, 4, 11, 4)).toBe(true)
            expect(boneMeal(island, 4, 12, 4)).toBe(true)
            expect(island.inventory.count(key)).toBe(2)
            expect(island.inventory.count('bone_meal')).toBe(0)
            expect(island.world.get(4, 11, 4)).toBe(id)
            expect(island.world.get(4, 12, 4)).toBe(id)
        }
    })

    it('come down whole and drop once, broken at either half', () => {
        for (const y of [11, 12]) {
            const island = meadow()
            island.placeFromSlot(give(island, 'peony'), 4, 11, 4)
            const out = island.breakBlock(4, y, 4, null)
            settle(island)
            expect(out).toEqual([{ item: 'peony', count: 1 }])
            expect(island.world.get(4, 11, 4)).toBe(B.Air)
            expect(island.world.get(4, 12, 4)).toBe(B.Air)
            expect(island.inventory.count('peony')).toBe(1)
        }
    })

    it('pop off as one item when the ground goes', () => {
        const island = meadow()
        island.placeFromSlot(give(island, 'lilac'), 4, 11, 4)
        island.world.set(4, 10, 4, B.Air)
        settle(island)
        expect(island.world.get(4, 11, 4)).toBe(B.Air)
        expect(island.world.get(4, 12, 4)).toBe(B.Air)
        expect(island.inventory.count('lilac')).toBe(1)
    })
})

describe('a dispenser with bone meal', () => {
    /** A dispenser at (3, 11, z) facing east, a lever beside it to fire it, holding `n` bone meal. */
    function dispenser(island: Island, z: number, n: number) {
        island.world.set(3, 11, z, B.Dispenser, EAST_FOR_TEST)
        island.world.set(2, 11, z, B.Lever)
        island.containerAt(3, 11, z)!.add('bone_meal', n)
        return () => {
            island.redstone.toggleLever(2, 11, z)
            for (let i = 0; i < 4; i++) island.step()
            island.redstone.toggleLever(2, 11, z)
            for (let i = 0; i < 4; i++) island.step()
        }
    }

    it('makes a tall flower drop another of itself', () => {
        const island = meadow()
        island.placeFromSlot(give(island, 'sunflower'), 4, 11, 5)
        const fire = dispenser(island, 5, 3)
        fire()
        fire()
        expect(island.inventory.count('sunflower')).toBe(2)
        expect(island.containerAt(3, 11, 5)!.count('bone_meal')).toBe(1)
        expect(island.world.get(4, 12, 5)).toBe(B.Sunflower)
    })

    it('grows short grass into tall grass', () => {
        const island = meadow()
        island.world.set(4, 11, 7, B.TallGrass)
        const fire = dispenser(island, 7, 1)
        fire()
        expect(island.world.get(4, 11, 7)).toBe(B.DoubleTallGrass)
        expect(island.world.get(4, 12, 7)).toBe(B.DoubleTallGrass)
    })
})

describe('flowers', () => {
    it('are items that place, pop off as themselves, and compost', () => {
        const island = meadow()
        for (const id of FLOWERS) {
            const key = item(String(['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip'][FLOWERS.indexOf(id)])).key
            expect(item(key).places).toBe(id)
            expect(itemId(key)).toBeGreaterThan(0)
            expect(COMPOST[key]).toBe(0.65)
        }
        island.placeFromSlot(give(island, 'cornflower'), 3, 11, 3)
        expect(island.world.get(3, 11, 3)).toBe(B.Cornflower)
        island.world.set(3, 10, 3, B.Air)
        settle(island)
        expect(island.inventory.count('cornflower')).toBe(1)
    })

    it('tall grass is no item, and drops a seed now and then from its lower half only', () => {
        expect(item('tall_grass').places).toBeUndefined()
        expect(itemId('tall_grass')).toBe(0)
        // One meadow, grown and broken 400 times (a new island each time is slow enough to time out under load).
        const island = meadow()
        let seeds = 0
        for (let i = 0; i < 400; i++) {
            island.world.set(4, 12, 4, B.DoubleTallGrass, UPPER)
            island.world.set(4, 11, 4, B.DoubleTallGrass, 0)
            seeds += island.breakBlock(4, 12, 4, null, false).filter(s => s.item === 'wheat_seeds').length
            settle(island)
        }
        // Anything the upper half dropped on its own would land here.
        seeds += island.inventory.count('wheat_seeds')
        expect(seeds).toBeGreaterThan(20)
        expect(seeds).toBeLessThan(90)
    })
})
