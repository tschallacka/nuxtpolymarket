import { describe, expect, it } from 'vitest'
import { B } from '../../app/utils/skyfarm/blocks'
import { Island } from '../../app/utils/skyfarm/island'
import { build, busyIslandWith, type Module } from '../../app/utils/skyfarm/test-island'
import { throughFile } from './save-helpers'
import { CHUNK } from '../../app/utils/skyfarm/world'

/** One machine from the test island, alone in a fresh cube east of the start, run for `seconds`. */
function machine(module: Module, seconds: number) {
    const island = Island.fresh()
    island.world.addCube(1, 1, 0)
    // Noon all the while: no monsters about, and the crops have light.
    island.time = 6000
    build(island, module, CHUNK, CHUNK, 0)
    island.mobs.target = { x: 5.5, y: 24, z: 5.5, active: false, held: null }
    const coins = island.coins
    for (let i = 0; i < seconds * 20; i++) island.step()
    const at = (x: number, y: number, z: number) => island.container(CHUNK + x, CHUNK + y, z)
    return { island, earned: island.coins - coins, at, leaked: island.inventory.slots.filter(Boolean) }
}

describe('the test island\'s machines', () => {
    it('cobblestone generators mine into hoppers and on to storage', () => {
        const { leaked, island } = machine('cobble', 60)
        expect(island.store.get('cobblestone')).toBeGreaterThan(0)
        expect(leaked).toEqual([])
        expect(island.world.get(CHUNK + 1, CHUNK + 2, 1)).toBe(B.Lava)
    })

    it('a sugar cane farm\'s pistons break the cane into a stream and a hopper', () => {
        const { at, leaked } = machine('cane', 300)
        expect(leaked).toEqual([])
        expect(at(8, 0, 7)!.count('sugar_cane')).toBeGreaterThan(0)
    })

    it('a melon farm\'s pistons break melons and pumpkins into a stream and a hopper', () => {
        const { at, leaked } = machine('melon', 600)
        expect(leaked).toEqual([])
        const box = at(9, 0, 7)!
        expect(box.count('melon_slice') + box.count('pumpkin')).toBeGreaterThan(0)
    })

    it('a farmer harvests and resows wheat and throws the spare to the villager on the hopper', () => {
        const { at, island } = machine('villagers', 900)
        expect(at(13, 1, 6)!.count('wheat')).toBeGreaterThan(0)
        // The field is kept sown.
        let wheat = 0
        for (let x = 2; x <= 10; x++) for (let z = 2; z <= 10; z++) if (island.world.get(CHUNK + x, CHUNK + 3, z) === B.Wheat) wheat++
        expect(wheat).toBeGreaterThan(70)
    })

    it('cobblestone generators keep going after a save and reload (pending redstone ticks are saved)', () => {
        const { island } = machine('cobble', 20)
        // Saved at many moments of the cycle, every generator must keep making cobblestone afterwards.
        for (let k = 0; k < 6; k++) {
            for (let i = 0; i < 7; i++) island.step()
            const back = Island.fromSave(throughFile(island.toSave())!)
            back.mobs.target = { x: 5.5, y: 24, z: 5.5, active: false, held: null }
            const before = back.store.get('cobblestone') ?? 0
            for (let i = 0; i < 20 * 20; i++) back.step()
            // Eight generators for twenty seconds: well over one each.
            expect((back.store.get('cobblestone') ?? 0) - before).toBeGreaterThan(40)
        }
    })

    it('an island saved before redstone ticks were saved starts its stalled generators again', () => {
        const { island } = machine('cobble', 20)
        for (let i = 0; i < 9; i++) island.step()
        // An older save: no redstone ticks in it (an observer may be caught mid-pulse).
        const { redstone: _, ...older } = island.toSave().state
        const back = Island.fromSave({ ...island.toSave(), state: older })
        back.mobs.target = { x: 5.5, y: 24, z: 5.5, active: false, held: null }
        const before = back.store.get('cobblestone') ?? 0
        for (let i = 0; i < 20 * 20; i++) back.step()
        expect((back.store.get('cobblestone') ?? 0) - before).toBeGreaterThan(40)
    })

    it('hopper lines empty full chests into store depots', () => {
        const { island } = machine('hoppers', 60)
        expect(island.store.get('cobblestone')).toBeGreaterThan(0)
    })
})

describe('the busy island round your own', () => {
    it('keeps your land, chests and inventory, and builds machines in the cubes round it', () => {
        const own = Island.fresh()
        own.world.addChunk(0, 0)
        own.world.set(6, 40, 6, B.Glowstone)
        own.inventory.add('diamond', 5)
        own.coins = 1234
        const busy = busyIslandWith(own)
        expect(busy.world.cubes.size).toBe(100)
        // Every cube past the starter one counts as bought (as the server prices land).
        expect(busy.chunksBought).toBe(busy.world.cubes.size - 1)
        expect(busy.world.get(6, 40, 6)).toBe(B.Glowstone)
        expect(busy.inventory.count('diamond')).toBe(5)
        expect(busy.coins).toBe(1234)
        expect(busy.container(8, 24, 5)).not.toBeNull()
        // Machines next door, and the farmers to work them.
        expect(busy.mobs.list.filter(m => m.profession === 'farmer').length).toBeGreaterThan(0)
        // Yours is left alone, and the result saves.
        expect(own.world.cubes.size).toBe(4)
        expect(throughFile(busy.toSave())).not.toBeNull()
    })
})
