import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { B, WORKSTATIONS } from '../../app/utils/skyfarm/blocks'
import { craft } from '../../app/utils/skyfarm/crafting'
import { FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, FURNACE_SLOTS, idleFurnace, smeltResult, stepFurnace } from '../../app/utils/skyfarm/furnace'
import { Island } from '../../app/utils/skyfarm/island'
import { Slots } from '../../app/utils/skyfarm/items'
import { Mob } from '../../app/utils/skyfarm/mobs'
import { STARTER_TOP } from '../../app/utils/skyfarm/world'

const top = STARTER_TOP

describe('the composter', () => {
    it('fills a layer at a time (the first always), and gives bone meal a second after it is full', () => {
        const island = Island.fresh()
        island.world.set(6, top, 6, B.Composter)
        island.inventory.add('wheat_seeds', 64)
        expect(island.compost(0, 6, top, 6)).toEqual({ used: true, rose: true })
        for (let i = 0; i < 64 && island.world.meta(6, top, 6) < 7; i++) island.compost(0, 6, top, 6)
        expect(island.world.meta(6, top, 6)).toBe(7)
        // Full: nothing more goes in.
        expect(island.compost(0, 6, top, 6).used).toBe(false)
        expect(island.emptyComposter(6, top, 6)).toBe(false)
        for (let i = 0; i < 20; i++) island.step()
        expect(island.world.meta(6, top, 6)).toBe(8)
        expect(island.emptyComposter(6, top, 6)).toBe(true)
        expect(island.world.meta(6, top, 6)).toBe(0)
        expect(island.inventory.count('bone_meal')).toBe(1)
        // Dirt doesn't compost.
        island.inventory.slots[1] = { item: 'dirt', count: 1 }
        expect(island.compost(1, 6, top, 6).used).toBe(false)
    })
})

describe('the cauldron', () => {
    it('fills from a water bucket and empties into a bucket', () => {
        const island = Island.fresh()
        island.world.set(6, top, 6, B.Cauldron)
        const hit = { x: 6, y: top, z: 6, nx: 0, ny: 1, nz: 0, id: B.Cauldron }
        island.inventory.slots[0] = { item: 'water_bucket', count: 1 }
        expect(island.useBucket(0, hit)).toBe(true)
        expect(island.world.meta(6, top, 6)).toBe(3)
        expect(island.inventory.slots[0]).toEqual({ item: 'bucket', count: 1 })
        expect(island.useBucket(0, hit)).toBe(true)
        expect(island.world.meta(6, top, 6)).toBe(0)
        expect(island.inventory.count('water_bucket')).toBe(1)
    })
})

describe('the smoker and the blast furnace', () => {
    it('take only their own trade, and do it twice as fast', () => {
        expect(smeltResult('smoker', 'beef')).toBe('cooked_beef')
        expect(smeltResult('smoker', 'iron_ore')).toBeUndefined()
        expect(smeltResult('blast_furnace', 'iron_ore')).toBe('iron_ingot')
        expect(smeltResult('blast_furnace', 'iron_sword')).toBe('iron_nugget')
        expect(smeltResult('blast_furnace', 'beef')).toBeUndefined()
        expect(smeltResult('blast_furnace', 'cobblestone')).toBeUndefined()
        const box = new Slots(FURNACE_SLOTS)
        box.slots[FURNACE_INPUT] = { item: 'porkchop', count: 4 }
        box.slots[FURNACE_FUEL] = { item: 'coal', count: 1 }
        const f = idleFurnace()
        for (let i = 0; i < 100; i++) stepFurnace(box, f, 'smoker')
        expect(box.slots[FURNACE_OUTPUT]).toEqual({ item: 'cooked_porkchop', count: 1 })
        // Coal burns for half as long in it: 800 ticks.
        expect(f.burnMax).toBe(800)
    })

    it('open as furnaces on the island and light up', () => {
        const island = Island.fresh()
        island.inventory.add('blast_furnace', 1)
        island.placeFromSlot(0, 6, top, 6)
        const it = island.furnace(6, top, 6)!
        expect(it.kind).toBe('blast_furnace')
        it.box.slots[FURNACE_INPUT] = { item: 'gold_ore', count: 1 }
        it.box.slots[FURNACE_FUEL] = { item: 'coal', count: 1 }
        for (let i = 0; i < 100; i++) island.step()
        expect(it.box.slots[FURNACE_OUTPUT]).toEqual({ item: 'gold_ingot', count: 1 })
    })
})

describe('the stonecutter', () => {
    it('cuts a block of stone into two slabs, or bricks', () => {
        const island = Island.fresh()
        const box = new Slots(1, [{ item: 'stone', count: 2 }])
        expect(island.cutStone(box, 0, 'stone_slab')).toEqual({ item: 'stone_slab', count: 2 })
        expect(island.cutStone(box, 0, 'stone_bricks')).toEqual({ item: 'stone_bricks', count: 1 })
        expect(box.slots[0]).toBeNull()
        expect(island.cutStone(new Slots(1, [{ item: 'dirt', count: 1 }]), 0, 'stone_slab')).toBeNull()
    })
})

describe('recipes', () => {
    it('make a book from three paper and leather laid anywhere, and the workstations', () => {
        const P = { item: 'paper', count: 1 }, L = { item: 'leather', count: 1 }
        expect(craft([P, null, L, null, P, null, null, null, P], 3)).toEqual({ item: 'book', count: 1 })
        expect(craft([L, P, P, P], 2)).toEqual({ item: 'book', count: 1 })
        const S = { item: 'oak_slab', count: 1 }
        expect(craft([S, null, S, S, null, S, S, S, S], 3)).toEqual({ item: 'composter', count: 1 })
        const I = { item: 'iron_ingot', count: 1 }
        expect(craft([I, null, I, I, null, I, I, I, I], 3)).toEqual({ item: 'cauldron', count: 1 })
    })
})

describe('villagers and workstations', () => {
    /** A villager on a flat stone floor, with a lectern 5 blocks away. */
    function setup() {
        const island = Island.fresh()
        for (let x = 0; x < 16; x++) for (let z = 10; z < 16; z++) island.world.set(x, 20, z, B.Stone)
        island.world.set(10, 21, 12, B.Lectern)
        const v = new Mob('villager', 5.5, 21, 12.5)
        island.mobs.list.push(v)
        island.mobs.target = { x: 0, y: 50, z: 0, active: false, held: null }
        return { island, v }
    }

    it('walks to a free workstation and takes up its trade', () => {
        const { island, v } = setup()
        expect(island.jobSites.get('10,21,12')).toBe(B.Lectern)
        for (let i = 0; i < 600 && !v.profession; i++) island.step()
        expect(v.profession).toBe('librarian')
        expect(v.site).toEqual([10, 21, 12])
        // Kept in a save, and the workstation found again on loading.
        const back = Island.fromSave(throughFile(island.toSave())!)
        expect(isValidSave(island.toSave())).toBe(true)
        expect(back.mobs.list[0]!.profession).toBe('librarian')
        expect(back.jobSites.get('10,21,12')).toBe(B.Lectern)
    })

    it('loses the trade when its workstation is broken, and one workstation employs only one', () => {
        const { island, v } = setup()
        const other = new Mob('villager', 3.5, 21, 14.5)
        island.mobs.list.push(other)
        for (let i = 0; i < 800; i++) island.step()
        expect([v.profession, other.profession].filter(Boolean)).toEqual(['librarian'])
        const worker = v.profession ? v : other
        island.world.set(10, 21, 12, B.Air)
        for (let i = 0; i < 5; i++) island.step()
        expect(worker.profession).toBeNull()
    })

    it('has a trade for every workstation', () => {
        expect(Object.keys(WORKSTATIONS)).toHaveLength(13)
    })
})
