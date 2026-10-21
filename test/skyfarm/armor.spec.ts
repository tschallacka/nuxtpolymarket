import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { craft } from '../../app/utils/skyfarm/crafting'
import { SMELTS } from '../../app/utils/skyfarm/furnace'
import { Island } from '../../app/utils/skyfarm/island'
import { afterArmor, armorValue } from '../../app/utils/skyfarm/items'
import { equip, Mob } from '../../app/utils/skyfarm/mobs'

const ironSet = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']

describe('armour', () => {
    it('protects by Minecraft\'s numbers', () => {
        expect(armorValue(ironSet)).toEqual({ armor: 15, toughness: 0 })
        expect(armorValue(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'])).toEqual({ armor: 20, toughness: 8 })
        // 15 points against a 5 hit: 12.5 points, half the damage.
        expect(afterArmor(5, 15, 0)).toBeCloseTo(2.5)
        // A heavy hit gets through more of it (never under a fifth of the armour).
        expect(afterArmor(40, 15, 0)).toBeCloseTo(40 * (1 - 3 / 25))
    })

    it('softens blows, not falls', () => {
        const island = Island.fresh()
        for (const [i, key] of ironSet.entries()) island.armor.slots[i] = { item: key, count: 1 }
        island.hurtPlayer(5, 0, 0)
        expect(island.health).toBeCloseTo(17.5)
        const fall = Island.fresh()
        for (const [i, key] of ironSet.entries()) fall.armor.slots[i] = { item: key, count: 1 }
        fall.hurtPlayer(5)
        expect(fall.health).toBe(15)
    })

    it('goes on from the hand, swapping out what was worn', () => {
        const island = Island.fresh()
        island.inventory.add('leather_helmet', 1)
        expect(island.equip(0)).toBe(true)
        expect(island.armor.slots[0]).toEqual({ item: 'leather_helmet', count: 1 })
        island.inventory.slots[0] = { item: 'iron_helmet', count: 1 }
        island.equip(0)
        expect(island.armor.slots[0]!.item).toBe('iron_helmet')
        expect(island.inventory.slots[0]!.item).toBe('leather_helmet')
        island.inventory.slots[1] = { item: 'dirt', count: 1 }
        expect(island.equip(1)).toBe(false)
        expect(island.armorPoints).toBe(2)
    })

    it('is crafted, a helmet in either row', () => {
        const L = { item: 'leather', count: 1 }
        expect(craft([L, L, L, L, null, L, null, null, null], 3)).toEqual({ item: 'leather_helmet', count: 1 })
        expect(craft([null, null, null, L, L, L, L, null, L], 3)).toEqual({ item: 'leather_helmet', count: 1 })
        const I = { item: 'iron_ingot', count: 1 }
        expect(craft([I, null, I, I, I, I, I, I, I], 3)).toEqual({ item: 'iron_chestplate', count: 1 })
    })

    it('melts down to a nugget, nine of which make an ingot', () => {
        expect(SMELTS.iron_sword).toBe('iron_nugget')
        expect(SMELTS.chainmail_boots).toBe('iron_nugget')
        expect(SMELTS.golden_helmet).toBe('gold_nugget')
        expect(SMELTS.diamond_sword).toBeUndefined()
        const N = { item: 'gold_nugget', count: 1 }
        expect(craft(Array(9).fill(N), 3)).toEqual({ item: 'gold_ingot', count: 1 })
        expect(craft([{ item: 'iron_ingot', count: 1 }, null, null, null], 2)).toEqual({ item: 'iron_nugget', count: 9 })
    })

    it('comes back with you from a save', () => {
        const island = Island.fresh()
        island.armor.slots[1] = { item: 'diamond_chestplate', count: 1 }
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        expect(Island.fromSave(throughFile(save)!).armor.slots[1]!.item).toBe('diamond_chestplate')
    })
})

describe('monsters in armour', () => {
    it('now and then spawn dressed, from the boots up, all of one material', () => {
        let dressed = 0
        const materials = new Set<string>()
        for (let i = 0; i < 4000; i++) {
            const m = new Mob('zombie', 0, 0, 0)
            equip(m)
            const pieces = Object.values(m.armor)
            if (!pieces.length) continue
            dressed++
            expect(m.armor.feet).toBeDefined()
            expect(new Set(pieces.map(p => p.split('_')[0])).size).toBe(1)
            materials.add(pieces[0]!.split('_')[0]!)
        }
        // 7.5% of them.
        expect(dressed / 4000).toBeGreaterThan(0.05)
        expect(dressed / 4000).toBeLessThan(0.1)
        expect(materials.has('leather')).toBe(true)
        // Cows never.
        const cow = new Mob('cow', 0, 0, 0)
        equip(cow, () => 0)
        expect(cow.armor).toEqual({})
    })

    it('hit harder with a sword in hand, and take less from your blows in armour', () => {
        const island = Island.fresh()
        island.world.addChunk(1, 0)
        const z = new Mob('zombie', 7.5, 32, 6.5)
        z.held = 'iron_sword'
        island.mobs.list.push(z)
        island.mobs.target = { x: 8.3, y: 32, z: 6.5, active: true, held: null, health: 20 }
        z.seeTarget = true
        for (let i = 0; i < 40 && island.health === 20; i++) island.mobs.step()
        expect(island.health).toBe(12)
        const bare = new Mob('zombie', 0, 0, 0)
        const iron = new Mob('zombie', 0, 0, 0)
        iron.armor = { head: 'iron_helmet', chest: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }
        island.mobs.hurt(bare, 6, { x: 1, z: 0 })
        island.mobs.hurt(iron, 6, { x: 1, z: 0 })
        expect(bare.health).toBe(14)
        expect(iron.health).toBeGreaterThan(16)
    })
})
