import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { B } from '../../app/utils/skyfarm/blocks'
import { craft } from '../../app/utils/skyfarm/crafting'
import { Island } from '../../app/utils/skyfarm/island'
import { Mob } from '../../app/utils/skyfarm/mobs'
import { CURED_REPUTATION, LEVEL_XP, levelFor, newOffers, priceOf, TRADES } from '../../app/utils/skyfarm/trades'

/** A villager on a stone floor next to a composter (a farmer's workstation), already working there. */
function farmer() {
    const island = Island.fresh()
    for (let x = 0; x < 16; x++) for (let z = 10; z < 16; z++) island.world.set(x, 20, z, B.Stone)
    island.world.set(8, 21, 12, B.Composter)
    const v = new Mob('villager', 7.5, 21, 12.5)
    island.mobs.list.push(v)
    island.mobs.target = { x: 0, y: 50, z: 0, active: false, held: null }
    for (let i = 0; i < 400 && !v.profession; i++) island.step()
    return { island, v }
}

describe('villager trades', () => {
    it('start with two Novice offers from the trade\'s list', () => {
        const { v } = farmer()
        expect(v.profession).toBe('farmer')
        expect(v.offers).toHaveLength(2)
        expect(v.level).toBe(1)
    })

    it('take what is asked, give emeralds, run out, and level the villager up', () => {
        const { island, v } = farmer()
        const wheat = v.offers.findIndex(o => o.a.item === 'wheat')
        island.inventory.add('wheat', 64)
        expect(island.trade(v, wheat)).toBe(1)
        expect(island.inventory.count('wheat')).toBe(44)
        expect(island.inventory.count('emerald')).toBe(1)
        expect(v.xp).toBe(2)
        // Shift: as often as you can afford (two more of 20 wheat).
        expect(island.trade(v, wheat, 64)).toBe(2)
        expect(island.inventory.count('wheat')).toBe(4)
        island.inventory.add('wheat', 600)
        island.trade(v, wheat, 64)
        // 16 uses in all, then out of stock.
        expect(v.offers[wheat]!.uses).toBe(16)
        expect(island.trade(v, wheat)).toBe(0)
        // 32 experience: Apprentice two seconds later, with two more offers.
        expect(levelFor(v.xp)).toBe(2)
        for (let i = 0; i < 41; i++) island.step()
        expect(v.level).toBe(2)
        expect(v.offers).toHaveLength(4)
    })

    it('can\'t be taken without paying, or without room for what you get', () => {
        const { island, v } = farmer()
        const bread = v.offers.findIndex(o => o.out.item === 'bread')
        expect(island.trade(v, bread)).toBe(0)
        island.inventory.add('emerald', 1)
        for (let i = 1; i < 36; i++) island.inventory.slots[i] = { item: 'dirt', count: 64 }
        island.inventory.slots[0] = { item: 'emerald', count: 2 }
        // Paying frees nothing (two emeralds, one taken): no room for the bread.
        expect(island.trade(v, bread)).toBe(0)
    })

    it('restock at the workstation, twice a day at most', () => {
        const { island, v } = farmer()
        const wheat = v.offers.findIndex(o => o.a.item === 'wheat')
        island.inventory.add('wheat', 640)
        island.trade(v, wheat, 64)
        expect(v.offers[wheat]!.uses).toBe(16)
        // Hold it at its composter.
        let restocked = 0
        for (let i = 0; i < 12000; i++) {
            v.x = 7.5
            v.z = 12.5
            const before = v.offers[wheat]!.uses
            island.step()
            if (before > 0 && v.offers[wheat]!.uses === 0) {
                restocked++
                island.trade(v, wheat, 64)
            }
        }
        expect(restocked).toBe(2)
    })

    it('are cheaper from a villager you cured', () => {
        const o = newOffers('farmer', 1, [], () => 0).find(x => x.a.item === 'wheat') ?? { a: { item: 'wheat', count: 20 }, out: { item: 'emerald', count: 1 }, uses: 0, max: 16, xp: 2 }
        expect(priceOf(o, 0).count).toBe(20)
        expect(priceOf(o, CURED_REPUTATION).count).toBe(14)
        const sale = { a: { item: 'emerald', count: 9 }, out: { item: 'iron_chestplate', count: 1 }, uses: 0, max: 12, xp: 1 }
        expect(priceOf(sale, CURED_REPUTATION).count).toBe(3)
        expect(priceOf({ ...sale, a: { item: 'emerald', count: 1 } }, CURED_REPUTATION).count).toBe(1)
    })

    it('a cured zombie villager keeps its trade, with offers, and its good opinion', () => {
        const { island } = farmer()
        const z = new Mob('zombie_villager', 3.5, 21, 14.5)
        z.profession = 'armorer'
        // A helmet keeps the sun off it through the cure (else it burns, as in Minecraft).
        z.armor.head = 'leather_helmet'
        island.mobs.list.push(z)
        island.mobs.affect(z, 'weakness', 1)
        island.inventory.add('golden_apple', 1)
        island.feedGoldenApple(0, z)
        for (let i = 0; i < 6000 && z.converting > 0; i++) island.mobs.step()
        const v = island.mobs.list.find(m => m.kind === 'villager' && m.profession === 'armorer')!
        expect(v.offers.length).toBeGreaterThan(0)
        expect(v.reputation).toBe(CURED_REPUTATION)
    })

    it('a villager that has traded keeps its trade when its workstation goes; one that never has, loses it', () => {
        const traded = farmer()
        traded.island.inventory.add('wheat', 20)
        traded.island.trade(traded.v, traded.v.offers.findIndex(o => o.a.item === 'wheat'))
        traded.island.world.set(8, 21, 12, B.Air)
        for (let i = 0; i < 5; i++) traded.island.step()
        expect(traded.v.profession).toBe('farmer')
        const fresh = farmer()
        fresh.island.world.set(8, 21, 12, B.Air)
        for (let i = 0; i < 5; i++) fresh.island.step()
        expect(fresh.v.profession).toBeNull()
        expect(fresh.v.offers).toHaveLength(0)
    })

    it('are kept in a save', () => {
        const { island, v } = farmer()
        island.inventory.add('wheat', 20)
        island.trade(v, v.offers.findIndex(o => o.a.item === 'wheat'))
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!).mobs.list[0]!
        expect(back.profession).toBe('farmer')
        expect(back.offers).toEqual(v.offers)
        expect(back.xp).toBe(2)
    })

    it('levels need Minecraft\'s experience, and every trade has a list for each level', () => {
        expect(LEVEL_XP).toEqual([0, 10, 70, 150, 250])
        expect(levelFor(9)).toBe(1)
        expect(levelFor(250)).toBe(5)
        for (const levels of Object.values(TRADES)) expect(levels).toHaveLength(5)
        // Every trade has something to start with (the mason with stone, for want of clay).
        for (const [prof, levels] of Object.entries(TRADES)) expect(levels[0]!.length, prof).toBeGreaterThan(0)
        expect(newOffers('mason', 1, [], () => 0).map(o => [o.a.item, o.out.item]).sort()).toEqual([['emerald', 'stone_bricks'], ['stone', 'emerald']])
    })
})

describe('emeralds', () => {
    it('pack nine to a block and back', () => {
        const E = { item: 'emerald', count: 1 }
        expect(craft(Array(9).fill(E), 3)).toEqual({ item: 'emerald_block', count: 1 })
        expect(craft([{ item: 'emerald_block', count: 1 }, null, null, null], 2)).toEqual({ item: 'emerald', count: 9 })
    })
})
