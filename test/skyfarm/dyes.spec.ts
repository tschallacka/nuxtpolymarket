import { describe, expect, it } from 'vitest'
import { throughFile } from './save-helpers'
import { B } from '../../app/utils/skyfarm/blocks'
import { craft } from '../../app/utils/skyfarm/crafting'
import { DYE_COLORS, DYE_MIXES, DYE_SOURCES, dyeKey, woolKey } from '../../app/utils/skyfarm/dyes'
import { smeltResult } from '../../app/utils/skyfarm/furnace'
import { Island } from '../../app/utils/skyfarm/island'
import { item } from '../../app/utils/skyfarm/items'
import { Mob, sheepColor } from '../../app/utils/skyfarm/mobs'
import { itemId } from '#shared/utils/skyfarm/item-ids'

const stack = (key: string) => ({ item: key, count: 1 })
/** What the 3x3 grid makes from these items laid in a row. */
const make = (...keys: string[]) => craft([...keys.map(stack), ...Array(9 - keys.length).fill(null)], 3)

/** A grass meadow at y = 10 in one chunk, you far off and not playing. */
function meadow() {
    const island = new Island()
    island.world.addChunk(0, 0)
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) island.world.set(x, 10, z, B.Grass)
    island.time = 6000
    island.weather = { kind: 'clear', ticksLeft: 1e6 }
    island.mobs.target = { x: 200, y: 30, z: 200, active: false, held: null }
    return island
}

function give(island: Island, key: string, count = 1) {
    island.inventory.add(key, count)
    return island.inventory.slots.findIndex(s => s?.item === key)
}

describe('dyes', () => {
    it('are items with save ids, every colour but brown', () => {
        for (const [color] of DYE_COLORS) {
            expect(itemId(dyeKey(color)), color).toBeGreaterThan(0)
            expect(item(dyeKey(color)).name).toMatch(/ Dye$/)
            expect(itemId(woolKey(color)), color).toBeGreaterThan(0)
            expect(item(woolKey(color)).places).toBeDefined()
        }
        expect(itemId('brown_dye')).toBe(0)
        expect(itemId('ink_sac')).toBeGreaterThan(0)
    })

    it('come from flowers, bone meal and ink sacs, and green from smelting cactus', () => {
        for (const [from, color, count] of DYE_SOURCES) expect(make(from), from).toEqual({ item: dyeKey(color), count })
        expect(make('sunflower')).toEqual({ item: 'yellow_dye', count: 2 })
        expect(make('ink_sac')).toEqual({ item: 'black_dye', count: 1 })
        expect(smeltResult('furnace', 'cactus')).toBe('green_dye')
    })

    it('mix into the others, the way Minecraft mixes them', () => {
        for (const [dyes, color, count] of DYE_MIXES) expect(make(...dyes.map(dyeKey)), color).toEqual({ item: dyeKey(color), count })
        expect(make('red_dye', 'yellow_dye')).toEqual({ item: 'orange_dye', count: 2 })
        expect(make('blue_dye', 'white_dye')).toEqual({ item: 'light_blue_dye', count: 2 })
    })

    it('dye wool of any colour', () => {
        expect(make('red_dye', 'white_wool')).toEqual({ item: 'red_wool', count: 1 })
        expect(make('white_wool', 'red_dye')).toEqual({ item: 'red_wool', count: 1 })
        expect(make('blue_dye', 'red_wool')).toEqual({ item: 'blue_wool', count: 1 })
        expect(make('red_dye', 'red_wool')).toBeNull()
    })

    it('make shears from two iron ingots', () => {
        expect(craft([stack('iron_ingot'), null, null, stack('iron_ingot')], 2)).toEqual({ item: 'shears', count: 1 })
    })
})

describe('sheep', () => {
    const sheepIn = (island: Island) => {
        const m = new Mob('sheep', 8.5, 11, 8.5)
        island.mobs.list.push(m)
        return m
    }

    it('are mostly white when they appear, now and then black, gray or light gray', () => {
        const counts = new Map<string, number>()
        for (let i = 0; i < 4000; i++) {
            const c = DYE_COLORS[sheepColor()]![0]
            counts.set(c, (counts.get(c) ?? 0) + 1)
        }
        expect(counts.get('white')! / 4000).toBeGreaterThan(0.8)
        for (const c of ['black', 'gray', 'light_gray']) expect(counts.get(c)! / 4000).toBeGreaterThan(0.03)
        expect([...counts.keys()].every(c => ['white', 'black', 'gray', 'light_gray', 'pink'].includes(c))).toBe(true)
    })

    it('take a dye, which is used up', () => {
        const island = meadow()
        const sheep = sheepIn(island)
        const slot = give(island, 'lime_dye', 2)
        expect(island.dyeSheep(slot, sheep)).toBe(true)
        expect(DYE_COLORS[sheep.color]![0]).toBe('lime')
        expect(island.dyeSheep(slot, sheep)).toBe(false)
        expect(island.inventory.count('lime_dye')).toBe(1)
    })

    it('shear for one to three wool of their colour, once, and drop none when shorn', () => {
        const island = meadow()
        const sheep = sheepIn(island)
        island.dyeSheep(give(island, 'red_dye'), sheep)
        const shears = give(island, 'shears')
        expect(island.shearSheep(shears, sheep)).toBe(true)
        const wool = island.inventory.count('red_wool')
        expect(wool).toBeGreaterThanOrEqual(1)
        expect(wool).toBeLessThanOrEqual(3)
        expect(island.shearSheep(shears, sheep)).toBe(false)
        expect(island.inventory.count('shears')).toBe(1)
        island.mobs.hurt(sheep, 100)
        expect(island.inventory.count('red_wool')).toBe(wool)
    })

    it('grow their wool back by eating grass, which turns to dirt', () => {
        const island = meadow()
        const sheep = sheepIn(island)
        island.shearSheep(give(island, 'shears'), sheep)
        for (let i = 0; i < 20; i++) island.step()
        const [x, z] = [Math.floor(sheep.x), Math.floor(sheep.z)]
        sheep.eating = 40
        for (let i = 0; i < 40; i++) {
            sheep.x = x + 0.5
            sheep.z = z + 0.5
            island.step()
        }
        expect(sheep.sheared).toBe(false)
        expect(island.world.get(x, 10, z)).toBe(B.Dirt)
    })

    it('eat short grass first, leaving the grass block', () => {
        const island = meadow()
        const sheep = sheepIn(island)
        island.world.set(8, 11, 8, B.TallGrass)
        sheep.sheared = true
        sheep.eating = 40
        for (let i = 0; i < 40; i++) {
            sheep.x = sheep.z = 8.5
            island.step()
        }
        expect(island.world.get(8, 11, 8)).toBe(B.Air)
        expect(island.world.get(8, 10, 8)).toBe(B.Grass)
        expect(sheep.sheared).toBe(false)
    })

    it('keep their colour and shearing through a save', () => {
        const island = meadow()
        const sheep = sheepIn(island)
        island.dyeSheep(give(island, 'cyan_dye'), sheep)
        island.shearSheep(give(island, 'shears'), sheep)
        const back = Island.fromSave(throughFile(island.toSave())!).mobs.list.find(m => m.kind === 'sheep')!
        expect(DYE_COLORS[back.color]![0]).toBe('cyan')
        expect(back.sheared).toBe(true)
    })
})

describe('squid', () => {
    // You, 60 blocks off: far enough to let squid spawn, near enough that they don't despawn at once.
    const FAR = { x: 60, y: 30, z: 60, active: false, held: null }
    /** A pool (x 2..13, z 2..13) of water `depth` deep, its floor at y = 10. */
    function pool(depth: number) {
        const island = new Island()
        island.world.addChunk(0, 0)
        for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
                island.world.set(x, 10, z, B.Stone)
                for (let y = 11; y <= 10 + depth; y++) island.world.set(x, y, z, x >= 2 && x <= 13 && z >= 2 && z <= 13 ? B.Water : B.Stone)
            }
        }
        island.mobs.target = FAR
        island.spawn = { x: 300, y: 30, z: 300 }
        return island
    }
    const env = (_island: Island) => ({ skyDarken: 0, raining: false, thundering: false, spawn: { x: 300, y: 30, z: 300 }, jobSites: new Map(), day: 0 })

    it('spawn only in water with water above and below', () => {
        const deep = pool(3)
        expect(deep.mobs.canSpawn('squid', 5, 12, 5, env(deep))).toBe(true)
        expect(deep.mobs.canSpawn('squid', 5, 11, 5, env(deep))).toBe(false)
        expect(deep.mobs.canSpawn('squid', 5, 13, 5, env(deep))).toBe(false)
        const shallow = pool(2)
        let n = 0
        for (let i = 0; i < 500; i++) n += shallow.mobs.spawnSquid(0, 0, env(shallow))
        expect(n).toBe(0)
        for (let i = 0; i < 500 && n === 0; i++) n += deep.mobs.spawnSquid(0, 0, env(deep))
        expect(n).toBeGreaterThan(0)
        for (const m of deep.mobs.list) expect(deep.world.get(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z))).toBe(B.Water)
    })

    it('appear by themselves in deep water, never more than five', () => {
        const island = pool(6)
        for (let i = 0; i < 2000; i++) island.step()
        const squid = island.mobs.list.filter(m => m.kind === 'squid' && !m.dead)
        expect(squid.length).toBeGreaterThan(0)
        expect(squid.length).toBeLessThanOrEqual(5)
    })

    it('swim about in the water, and stay in it', () => {
        const island = pool(6)
        const squid = new Mob('squid', 7.5, 13, 7.5)
        island.mobs.list.push(squid)
        let moved = 0, wet = 0
        for (let i = 0; i < 400; i++) {
            const [x, y, z] = [squid.x, squid.y, squid.z]
            island.step()
            moved += Math.hypot(squid.x - x, squid.y - y, squid.z - z)
            if (squid.inWater) wet++
        }
        expect(moved).toBeGreaterThan(5)
        expect(squid.dead).toBe(false)
        // It may breach the surface now and then, as Minecraft's do, but falls back in.
        expect(wet).toBeGreaterThan(340)
        expect(squid.x).toBeGreaterThan(2)
        expect(squid.x).toBeLessThan(14)
        expect(squid.y).toBeLessThan(18)
    })

    it('suffocate out of water, dropping ink sacs', () => {
        const island = new Island()
        island.world.addChunk(0, 0)
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) island.world.set(x, 10, z, B.Stone)
        island.mobs.target = FAR
        island.spawn = { x: 300, y: 30, z: 300 }
        const squid = new Mob('squid', 7.5, 11, 7.5)
        island.mobs.list.push(squid)
        for (let i = 0; i < 300; i++) island.step()
        expect(squid.health).toBe(10)
        for (let i = 0; i < 400; i++) island.step()
        expect(squid.dead || squid.removed).toBe(true)
        const ink = island.inventory.count('ink_sac')
        expect(ink).toBeGreaterThanOrEqual(1)
        expect(ink).toBeLessThanOrEqual(3)
    })

    it('dart away from a blow', () => {
        const island = pool(6)
        const squid = new Mob('squid', 7.5, 13, 7.5)
        island.mobs.list.push(squid)
        island.mobs.hurt(squid, 1, { x: 5.5, z: 7.5 }, true)
        for (let i = 0; i < 20; i++) island.step()
        expect(squid.x).toBeGreaterThan(8.5)
    })
})
