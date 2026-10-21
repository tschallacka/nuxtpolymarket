import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { columnFile, columnHash, decodeBundle, decodeMap, encodeBundle, encodeMap, isColumnHash, mapOf } from '#shared/utils/skyfarm/binary'
import { isValidSave, runs, throughFile } from './save-helpers'
import { B, facingToward, SLAB_BOTTOM, SLAB_DOUBLE, SLAB_TOP } from '../../app/utils/skyfarm/blocks'
import { craft } from '../../app/utils/skyfarm/crafting'
import { leafDrops } from '../../app/utils/skyfarm/sim'
import { chunkPrice, SHOP } from '../../app/utils/skyfarm/economy'
import { systemPrice } from '../../app/utils/skyfarm/market'
import { Island } from '../../app/utils/skyfarm/island'
import { breakTime } from '../../app/utils/skyfarm/items'
import { STARTER_TOP } from '../../app/utils/skyfarm/world'

describe('a fresh island', () => {
    it('starts with the classic chest', () => {
        const island = Island.fresh()
        const chest = island.container(8, STARTER_TOP, 5)!
        expect(chest.count('lava_bucket')).toBe(1)
        expect(chest.count('ice')).toBe(2)
    })

    it('round-trips through a save, block for block', () => {
        const island = Island.fresh()
        island.coins = 1234
        island.world.set(6, STARTER_TOP, 6, B.Cobblestone)
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!)
        expect(back.world.get(6, STARTER_TOP, 6)).toBe(B.Cobblestone)
        expect(back.world.get(5, STARTER_TOP, 8)).toBe(B.OakLog)
        expect(back.coins).toBe(1234)
        expect(back.container(8, STARTER_TOP, 5)!.count('ice')).toBe(2)
        // An island is mostly air: gzipped, the starter island's column file is well under 1 KB.
        expect(gzipSync(columnFile(save.columns[0]!)).length).toBeLessThan(1000)
    })

    it('rejects a save that claims land it has not paid for', () => {
        const save = Island.fresh().toSave()
        save.state.chunksBought = 3
        expect(isValidSave(save)).toBe(false)
    })

    it('rejects a map file that is cut short, padded or lists a column twice', () => {
        const save = Island.fresh().toSave()
        const bytes = encodeMap(mapOf(save, ['ab'.repeat(32)]))
        expect(decodeMap(bytes)).not.toBeNull()
        expect(decodeMap(bytes.subarray(0, bytes.length - 1))).toBeNull()
        expect(decodeMap(new Uint8Array([...bytes, 0]))).toBeNull()
        save.columns.push({ ...save.columns[0]! })
        expect(isValidSave(save)).toBe(false)
    })

    it('names a column file by its contents, so an unchanged column keeps its name', async () => {
        const island = Island.fresh()
        const hash = async () => columnHash(columnFile(island.toSave().columns[0]!))
        const before = await hash()
        expect(isColumnHash(before)).toBe(true)
        expect(await hash()).toBe(before)
        island.world.set(6, STARTER_TOP, 6, B.Cobblestone)
        expect(await hash()).not.toBe(before)
    })

    it('sends a bundle of the map and new column files, read back exactly', () => {
        const map = new Uint8Array([1, 2, 3])
        const columns = [{ hash: 'cd'.repeat(32), file: new Uint8Array([9, 8]) }]
        const bundle = encodeBundle(map, columns)
        expect(decodeBundle(bundle)).toEqual({ map, columns })
        expect(decodeBundle(bundle.subarray(0, bundle.length - 1))).toBeNull()
    })
})

describe('mining', () => {
    it('is faster with the right tool, and stone needs a pickaxe to drop', () => {
        expect(breakTime(B.Stone, 'stone_pickaxe').seconds).toBeLessThan(breakTime(B.Stone, 'wooden_pickaxe').seconds)
        expect(breakTime(B.Stone, null).drops).toBe(false)
        expect(breakTime(B.Dirt, null).drops).toBe(true)
        expect(breakTime(B.Bedrock, 'diamond_pickaxe').seconds).toBe(Infinity)
    })

    it('leaves water where ice was broken', () => {
        const island = Island.fresh()
        island.world.set(6, STARTER_TOP, 5, B.Ice)
        island.breakBlock(6, STARTER_TOP, 5, 'wooden_pickaxe')
        expect(island.world.get(6, STARTER_TOP, 5)).toBe(B.Water)
    })
})

describe('buckets', () => {
    it('pour a source in front of the clicked face and scoop it back up', () => {
        const island = Island.fresh()
        island.inventory.add('lava_bucket', 1)
        const ground = { x: 6, y: STARTER_TOP - 1, z: 5, nx: 0, ny: 1, nz: 0, id: B.Grass }
        expect(island.useBucket(0, ground)).toBe(true)
        expect(island.world.get(6, STARTER_TOP, 5)).toBe(B.Lava)
        expect(island.inventory.slots[0]).toEqual({ item: 'bucket', count: 1 })
        expect(island.useBucket(0, { x: 6, y: STARTER_TOP, z: 5, nx: 0, ny: 1, nz: 0, id: B.Lava })).toBe(true)
        expect(island.world.get(6, STARTER_TOP, 5)).toBe(B.Air)
        expect(island.inventory.count('lava_bucket')).toBe(1)
    })

    it('cannot pour off owned land', () => {
        const island = Island.fresh()
        island.inventory.add('water_bucket', 1)
        expect(island.useBucket(0, { x: 15, y: STARTER_TOP, z: 5, nx: 1, ny: 0, nz: 0, id: B.Dirt })).toBe(false)
    })
})

describe('slabs', () => {
    const top = STARTER_TOP
    // The grass at (6, top - 1, 5), clicked on its top face.
    const onGrass = { x: 6, y: top - 1, z: 5, nx: 0, ny: 1, nz: 0, id: B.Grass, py: top }

    it('craft six from three in a row, in any row', () => {
        const row = (y: number) => Array.from({ length: 9 }, (_, i) => (Math.floor(i / 3) === y ? { item: 'cobblestone', count: 1 } : null))
        expect(craft(row(0), 3)).toEqual({ item: 'cobblestone_slab', count: 6 })
        expect(craft(row(2), 3)).toEqual({ item: 'cobblestone_slab', count: 6 })
    })

    it('go in the half that was clicked, and a second one makes a double', () => {
        const island = Island.fresh()
        island.inventory.add('oak_slab', 3)
        // On top of the grass: a bottom slab.
        expect(island.placeAgainst(0, onGrass)).toBe(true)
        expect(island.world.get(6, top, 5)).toBe(B.OakSlab)
        expect(island.world.meta(6, top, 5) & 3).toBe(SLAB_BOTTOM)
        // Onto that bottom slab's open top: it becomes a double.
        expect(island.placeAgainst(0, { x: 6, y: top, z: 5, nx: 0, ny: 1, nz: 0, id: B.OakSlab, py: top + 0.5 })).toBe(true)
        expect(island.world.meta(6, top, 5) & 3).toBe(SLAB_DOUBLE)
        // The upper half of a side face makes a top slab.
        expect(island.placeAgainst(0, { x: 6, y: top, z: 5, nx: 1, ny: 0, nz: 0, id: B.OakSlab, py: top + 0.8 })).toBe(true)
        expect(island.world.meta(7, top, 5) & 3).toBe(SLAB_TOP)
        expect(island.inventory.count('oak_slab')).toBe(0)
    })

    it('a double slab breaks into two', () => {
        const island = Island.fresh()
        island.world.set(6, top, 5, B.StoneSlab, SLAB_DOUBLE)
        expect(island.breakBlock(6, top, 5, 'wooden_pickaxe')).toEqual([{ item: 'stone_slab', count: 2 }])
        expect(island.inventory.count('stone_slab')).toBe(2)
    })

    it('is not placed where the player stands, but a top slab above their head is fine', () => {
        const island = Island.fresh()
        island.inventory.add('oak_slab', 2)
        // Blocked for a bottom slab (the player's feet are in it)...
        const feet = (_x: number, _y: number, _z: number, _id: number, meta: number) => (meta & 3) !== SLAB_TOP
        expect(island.placeAgainst(0, onGrass, feet)).toBe(false)
        expect(island.inventory.count('oak_slab')).toBe(2)
    })
})

describe('farming', () => {
    const top = STARTER_TOP
    const grassAt = (x: number, z: number) => ({ x, y: top - 1, z, nx: 0, ny: 1, nz: 0, id: B.Grass, py: top })
    const give = (island: Island, key: string, count = 1) => {
        island.inventory.add(key, count)
        return island.inventory.slots.findIndex(s => s?.item === key)
    }

    it('starts from the classic SkyBlock chest', () => {
        const chest = Island.fresh().container(8, top, 5)!
        for (const k of ['lava_bucket', 'ice', 'melon_slice', 'pumpkin_seeds', 'bone', 'sugar_cane', 'cactus']) expect(chest.count(k), k).toBeGreaterThan(0)
        expect(craft([{ item: 'bone', count: 1 }, null, null, null], 2)).toEqual({ item: 'bone_meal', count: 3 })
        expect(craft([{ item: 'melon_slice', count: 1 }, null, null, null], 2)).toEqual({ item: 'melon_seeds', count: 1 })
    })

    it('bone meal on grass sprouts short grass, which now and then gives wheat seeds', () => {
        const island = Island.fresh()
        const slot = give(island, 'bone_meal', 1)
        expect(island.useItem(slot, { x: 6, y: top - 1, z: 5, id: B.Grass })).toBe(true)
        expect(island.inventory.count('bone_meal')).toBe(0)
        expect(island.world.get(6, top, 5)).toBe(B.TallGrass)
        // Breaking short grass: a seed about one time in eight.
        let seeds = 0
        for (let i = 0; i < 400; i++) {
            island.world.set(6, top, 5, B.TallGrass)
            seeds += island.breakBlock(6, top, 5, null).filter(s => s.item === 'wheat_seeds').length
        }
        expect(seeds).toBeGreaterThan(20)
        expect(seeds).toBeLessThan(90)
    })

    it('a hoe tills grass into farmland, moist beside water, and wheat grows ripe on it', () => {
        const island = Island.fresh()
        const hoe = give(island, 'wooden_hoe')
        expect(island.useItem(hoe, { x: 6, y: top - 1, z: 5, id: B.Grass })).toBe(true)
        expect(island.world.get(6, top - 1, 5)).toBe(B.Farmland)
        // Water two blocks away keeps it moist.
        island.world.set(8, top - 1, 5, B.Water)
        const seeds = give(island, 'wheat_seeds')
        expect(island.placeAgainst(seeds, { x: 6, y: top - 1, z: 5, nx: 0, ny: 1, nz: 0, id: B.Farmland, py: top })).toBe(true)
        expect(island.world.get(6, top, 5)).toBe(B.Wheat)
        for (let i = 0; i < 15 * 60 * 20 && (island.world.meta(6, top, 5) & 7) < 7; i++) island.step()
        expect(island.world.meta(6, top - 1, 5) & 1).toBe(1)
        expect(island.world.meta(6, top, 5) & 7).toBe(7)
        const harvest = island.breakBlock(6, top, 5, null)
        expect(harvest[0]).toEqual({ item: 'wheat', count: 1 })
    })

    it('a melon stem grows a melon beside it, and a melon breaks into slices', () => {
        const island = Island.fresh()
        island.world.set(6, top - 1, 5, B.Farmland)
        const seeds = give(island, 'melon_seeds')
        expect(island.placeAgainst(seeds, { x: 6, y: top - 1, z: 5, nx: 0, ny: 1, nz: 0, id: B.Farmland, py: top })).toBe(true)
        let melon: [number, number] | null = null
        for (let i = 0; i < 30 * 60 * 20 && !melon; i++) {
            island.step()
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (island.world.get(6 + dx, top, 5 + dz) === B.Melon) melon = [6 + dx, 5 + dz]
        }
        expect(melon).not.toBeNull()
        const slices = island.breakBlock(melon![0], top, melon![1], 'wooden_axe')[0]!
        expect(slices.item).toBe('melon_slice')
        expect(slices.count).toBeGreaterThanOrEqual(3)
        expect(slices.count).toBeLessThanOrEqual(7)
    })

    it('sugar cane needs water beside it and grows three tall', () => {
        const island = Island.fresh()
        const cane = give(island, 'sugar_cane', 2)
        // No water: it can't be planted.
        expect(island.placeAgainst(cane, grassAt(6, 5))).toBe(false)
        island.world.set(7, top - 1, 5, B.Water)
        expect(island.placeAgainst(cane, grassAt(6, 5))).toBe(true)
        for (let i = 0; i < 10 * 60 * 20; i++) island.step()
        expect(island.world.get(6, top + 1, 5)).toBe(B.SugarCane)
        expect(island.world.get(6, top + 2, 5)).toBe(B.SugarCane)
        expect(island.world.get(6, top + 3, 5)).toBe(B.Air)
    })

    it('a plant pops off as an item when its ground is dug out', () => {
        const island = Island.fresh()
        const sapling = give(island, 'oak_sapling')
        expect(island.placeAgainst(sapling, grassAt(6, 5))).toBe(true)
        island.breakBlock(6, top - 1, 5, 'wooden_shovel')
        island.step()
        island.step()
        expect(island.world.get(6, top, 5)).toBe(B.Air)
        expect(island.inventory.count('oak_sapling')).toBe(1)
    })
})

describe('saplings', () => {
    const plantAt = (island: Island, x: number, z: number) => {
        island.inventory.add('oak_sapling', 1)
        const slot = island.inventory.slots.findIndex(s => s?.item === 'oak_sapling')
        return island.placeAgainst(slot, { x, y: STARTER_TOP - 1, z, nx: 0, ny: 1, nz: 0, id: B.Grass, py: STARTER_TOP })
    }

    it('grow into an oak in a few minutes, and the young tree keeps its leaves', () => {
        const island = Island.fresh()
        expect(plantAt(island, 7, 5)).toBe(true)
        // Ten minutes is far more than the two or so it takes on average.
        for (let i = 0; i < 10 * 60 * 20 && island.world.get(7, STARTER_TOP, 5) === B.OakSapling; i++) island.step()
        expect(island.world.get(7, STARTER_TOP, 5)).toBe(B.OakLog)
        let logs = 0, leaves = 0
        for (let y = STARTER_TOP; y < STARTER_TOP + 9; y++) {
            for (let x = 4; x <= 10; x++) {
                for (let z = 2; z <= 8; z++) {
                    const id = island.world.get(x, y, z)
                    if (id === B.OakLog && x === 7 && z === 5) logs++
                    if (id === B.OakLeaves) leaves++
                }
            }
        }
        expect(logs).toBeGreaterThanOrEqual(4)
        expect(logs).toBeLessThanOrEqual(6)
        expect(leaves).toBeGreaterThan(20)
        // A while later the new tree still stands, leaves and all.
        const before = leaves
        for (let i = 0; i < 20 * 20; i++) island.step()
        let after = 0
        for (let y = STARTER_TOP; y < STARTER_TOP + 9; y++) for (let x = 4; x <= 10; x++) for (let z = 2; z <= 8; z++) if (island.world.get(x, y, z) === B.OakLeaves) after++
        expect(after).toBeGreaterThanOrEqual(before)
    })

    it('wait while something blocks the trunk', () => {
        const island = Island.fresh()
        expect(plantAt(island, 7, 5)).toBe(true)
        island.world.set(7, STARTER_TOP + 2, 5, B.Cobblestone)
        for (let i = 0; i < 10 * 60 * 20; i++) island.step()
        expect(island.world.get(7, STARTER_TOP, 5)).toBe(B.OakSapling)
    })
})

describe('leaves', () => {
    const leavesOf = (island: Island) => {
        let n = 0
        for (let y = 0; y < 64; y++) for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (island.world.get(x, y, z) === B.OakLeaves) n++
        return n
    }

    it('stay while the tree stands', () => {
        const island = Island.fresh()
        const before = leavesOf(island)
        for (let i = 0; i < 20 * 20; i++) island.step()
        expect(leavesOf(island)).toBe(before)
    })

    it('decay once the trunk is gone, dropping what leaves drop', () => {
        const island = Island.fresh()
        expect(leavesOf(island)).toBeGreaterThan(30)
        for (let y = STARTER_TOP; y < STARTER_TOP + 4; y++) island.breakBlock(5, y, 8, 'wooden_axe')
        const logs = island.inventory.count('oak_log')
        // A few seconds is enough for every leaf to notice.
        for (let i = 0; i < 20 * 20; i++) island.step()
        expect(leavesOf(island)).toBe(0)
        // With no game running, the drops land in the inventory: only things leaves drop.
        const got = island.inventory.slots.filter(Boolean).map(s => s!.item)
        for (const k of got) expect(['oak_log', 'oak_sapling', 'stick', 'apple']).toContain(k)
        expect(island.inventory.count('oak_log')).toBe(logs)
    })

    it('that the player placed never decay', () => {
        const island = Island.fresh()
        island.inventory.add('oak_leaves', 1)
        expect(island.placeAgainst(0, { x: 6, y: STARTER_TOP - 1, z: 5, nx: 0, ny: 1, nz: 0, id: B.Grass, py: STARTER_TOP })).toBe(true)
        for (let i = 0; i < 20 * 20; i++) island.step()
        expect(island.world.get(6, STARTER_TOP, 5)).toBe(B.OakLeaves)
    })

    it('drop saplings, sticks and apples at Minecraft\'s odds', () => {
        const always = leafDrops(() => 0)
        expect(always.map(s => s.item)).toEqual(['oak_sapling', 'stick', 'apple'])
        expect(leafDrops(() => 0.99)).toEqual([])
    })
})

describe('the shop', () => {
    it('takes in what was bought (the server charged for it), when there is room', () => {
        const island = Island.fresh()
        expect(island.hasRoom('wheat_seeds', 1)).toBe(true)
        island.received('wheat_seeds', 3)
        expect(island.inventory.count('wheat_seeds')).toBe(3)
        for (let i = 0; i < 36; i++) island.inventory.slots[i] = { item: 'dirt', count: 64 }
        expect(island.hasRoom('wheat_seeds', 1)).toBe(false)
    })

    it('never sells for more than it costs: nothing bought can be sold back at a profit', () => {
        for (const rows of Object.values(SHOP)) for (const r of rows) expect(systemPrice(r.item)).toBeLessThan(r.price)
        // Bone meal costs more than the most one can grow (a pumpkin, or a melon's seven slices).
        const bone = SHOP.Farming!.find(r => r.item === 'bone_meal')!.price
        expect(bone).toBeGreaterThan(systemPrice('pumpkin'))
        expect(bone).toBeGreaterThan(7 * systemPrice('melon_slice'))
    })

    it('starts with one 16x16x16 cube and only builds inside owned cubes', () => {
        const island = Island.fresh()
        expect([...island.world.cubes]).toEqual(['0,1,0'])
        expect(island.world.set(6, 31, 6, B.Dirt)).toBe(true)
        expect(island.world.set(6, 32, 6, B.Dirt)).toBe(false)
        expect(island.world.set(6, 15, 6, B.Dirt)).toBe(false)
        expect(island.canPlace(6, 32, 6)).toBe(false)
    })

    it('takes cubes on any side of one you own, up and down too, each 1.2x the last', () => {
        const island = Island.fresh()
        // Not touching what you own (only an edge or corner), or off the top of the world.
        expect(island.addBoughtCube(1, 2, 0, 1)).toBe(false)
        expect(island.addBoughtCube(2, 1, 0, 1)).toBe(false)
        expect(island.addBoughtCube(0, 2, 0, 1)).toBe(true)
        expect(island.addBoughtCube(0, 3, 0, 2)).toBe(true)
        expect(island.addBoughtCube(0, 4, 0, 3)).toBe(false)
        expect(island.addBoughtCube(1, 3, 0, 3)).toBe(true)
        expect(island.addBoughtCube(1, 3, 0, 4)).toBe(false)
        expect(island.chunksBought).toBe(3)
        expect(island.nextChunkPrice).toBe(chunkPrice(3))
        expect(chunkPrice(1) / chunkPrice(0)).toBeCloseTo(1.2, 5)
        expect(island.world.set(6, 40, 6, B.Dirt)).toBe(true)
        expect(island.world.set(20, 50, 6, B.Dirt)).toBe(true)
        expect(island.world.set(20, 20, 6, B.Dirt)).toBe(false)
    })

    it('saves its cubes, and an older island keeps every cube of its chunks', () => {
        const island = Island.fresh()
        island.addBoughtCube(0, 0, 0, 1)
        const save = island.toSave()
        // One column, owning cubes 0 and 1 of it.
        expect(throughFile(save)!.columns.map(c => [c.cx, c.cz, c.cubes])).toEqual([[0, 0, 0b0011]])
        expect(new Set(Island.fromSave(throughFile(save)!).world.cubes)).toEqual(new Set(['0,1,0', '0,0,0']))
        // An older JSON save (whole chunks, no cube list) owns all four cubes of each chunk.
        const column = save.columns[0]!
        const older = { ...save.state, chunksBought: 0, chunks: [{ cx: 0, cz: 0, blocks: runs(column.blocks), meta: runs(column.meta) }] }
        const old = Island.fromSave(older)
        expect(old.world.cubes.size).toBe(4)
        expect(old.world.get(5, STARTER_TOP, 8)).toBe(B.OakLog)
        expect(old.world.set(6, 60, 6, B.Dirt)).toBe(true)
        expect(isValidSave(old.toSave())).toBe(true)
    })
})

describe('sell chests, retired', () => {
    it('turn into store depots, what was in them on its way to storage; nothing sells by itself', () => {
        const island = Island.fresh()
        island.world.set(6, STARTER_TOP, 5, B.SellChest)
        island.containerAt(6, STARTER_TOP, 5)!.add('diamond', 2)
        for (let i = 0; i < 40; i++) island.step()
        expect(island.coins).toBe(0)
        const back = Island.fromSave(throughFile(island.toSave())!)
        expect(back.world.get(6, STARTER_TOP, 5)).toBe(B.Depot)
        expect(back.store.get('diamond')).toBe(2)
    })

    it('one left in your inventory places a store depot', () => {
        const island = Island.fresh()
        island.inventory.add('sell_chest', 1)
        expect(island.placeFromSlot(0, 6, STARTER_TOP, 5)).toBe(true)
        expect(island.world.get(6, STARTER_TOP, 5)).toBe(B.Depot)
    })
})

describe('torches and facing blocks', () => {
    const top = STARTER_TOP

    it('stands a torch on a floor and hangs one on a wall, never from a ceiling', () => {
        const island = Island.fresh()
        island.inventory.add('torch', 4)
        island.world.set(6, top, 6, B.Cobblestone)
        // On top of the cobblestone.
        expect(island.placeAgainst(0, { x: 6, y: top, z: 6, nx: 0, ny: 1, nz: 0, id: B.Cobblestone, py: top + 1 })).toBe(true)
        expect(island.world.get(6, top + 1, 6)).toBe(B.Torch)
        expect(island.world.meta(6, top + 1, 6)).toBe(0)
        // On its east face: the torch leans out east (meta 1).
        expect(island.placeAgainst(0, { x: 6, y: top, z: 6, nx: 1, ny: 0, nz: 0, id: B.Cobblestone, py: top + 0.5 })).toBe(true)
        expect(island.world.get(7, top, 6)).toBe(B.Torch)
        expect(island.world.meta(7, top, 6)).toBe(1)
        // Under it: no.
        island.world.set(6, top + 3, 6, B.Cobblestone)
        expect(island.placeAgainst(0, { x: 6, y: top + 3, z: 6, nx: 0, ny: -1, nz: 0, id: B.Cobblestone, py: top + 3 })).toBe(false)
    })

    it('drops a wall torch when its wall goes', () => {
        const island = Island.fresh()
        island.inventory.add('torch', 1)
        island.world.set(6, top, 6, B.Cobblestone)
        island.placeAgainst(0, { x: 6, y: top, z: 6, nx: 0, ny: 0, nz: 1, id: B.Cobblestone, py: top + 0.5 })
        expect(island.world.meta(6, top, 7)).toBe(2)
        island.world.set(6, top, 6, B.Air)
        for (let i = 0; i < 5; i++) island.step()
        expect(island.world.get(6, top, 7)).toBe(B.Air)
        expect(island.inventory.count('torch')).toBe(1)
    })

    it('turns a jack o\'lantern to face the player', () => {
        expect(facingToward(0)).toBe(2)
        expect(facingToward(Math.PI / 2)).toBe(1)
        expect(facingToward(Math.PI)).toBe(0)
        expect(facingToward(-Math.PI / 2)).toBe(3)
        const island = Island.fresh()
        island.inventory.add('jack_o_lantern', 1)
        island.placeAgainst(0, { x: 6, y: top - 1, z: 6, nx: 0, ny: 1, nz: 0, id: B.Grass, py: top }, () => false, Math.PI / 2)
        expect(island.world.get(6, top, 6)).toBe(B.JackOLantern)
        expect(island.world.meta(6, top, 6)).toBe(1)
    })

    it('crafts torches from coal or charcoal and a stick', () => {
        const grid = (top: string) => [null, { item: top, count: 1 }, null, { item: 'stick', count: 1 }]
        expect(craft(grid('coal'), 2)).toEqual({ item: 'torch', count: 4 })
        expect(craft(grid('charcoal'), 2)).toEqual({ item: 'torch', count: 4 })
    })
})

describe('the day and the weather', () => {
    it('runs a twenty-minute day, through a save and through time away', () => {
        const island = Island.fresh()
        for (let i = 0; i < 6000; i++) island.step()
        expect(island.dayTime).toBeCloseTo(0.25)
        island.weather = { kind: 'thunder', ticksLeft: 500 }
        const back = Island.fromSave(throughFile(island.toSave())!)
        expect(back.time).toBe(6000)
        expect(back.weather).toEqual({ kind: 'thunder', ticksLeft: 500 })
        expect(back.sim.raining).toBe(true)
        // A whole day away comes back at the same time of day.
        back.catchUp(20 * 60 * 1000 * 1)
        expect(back.day).toBe(1)
        expect(back.dayTime).toBeCloseTo(0.25)
    })

    it('alternates clear spells and rain', () => {
        const island = Island.fresh()
        island.weather = { kind: 'clear', ticksLeft: 1 }
        island.step()
        expect(island.weather.kind).not.toBe('clear')
        expect(island.sim.raining).toBe(true)
        island.weather.ticksLeft = 1
        island.step()
        expect(island.weather.kind).toBe('clear')
        expect(island.sim.raining).toBe(false)
    })
})

describe('time away', () => {
    /**
     * Island with a hopper at (6, top + 1, 6) feeding down into `sink` at
     * (6, top, 6), and a machine dropping a cobblestone into it every second
     * (part of the island's tick, so it keeps going while time is replayed), run for `seconds`.
     */
    function machine(sink: B, seconds: number) {
        const island = Island.fresh()
        island.world.set(6, STARTER_TOP, 6, sink)
        island.world.set(6, STARTER_TOP + 1, 6, B.Hopper, 5)
        const step = island.step.bind(island)
        let t = 0
        island.step = () => {
            if (t++ % 20 === 0) island.drop(6, STARTER_TOP + 2, 6, { item: 'cobblestone', count: 1 })
            step()
        }
        for (let i = 0; i < seconds * 20; i++) island.step()
        return island
    }

    it('keeps the island\'s own production going while you are away, from the ledger', () => {
        // A depot fed a cobblestone a second (a machine) for two minutes, then an hour away.
        const island = machine(B.Depot, 120)
        const before = island.store.get('cobblestone') ?? 0
        island.catchUp(60 * 60 * 1000)
        // About one a second for the hour (the minute replayed adds nothing: the supply was the machine).
        const made = island.store.get('cobblestone')! - before
        expect(made).toBeGreaterThan(3000)
        expect(made).toBeLessThan(3800)
    })

    it('fills the store through a depot, and a chest only up to full', () => {
        const store = machine(B.Depot, 120)
        store.catchUp(60 * 60 * 1000)
        expect(store.store.get('cobblestone')!).toBeGreaterThan(3000)
        const chest = machine(B.Chest, 120)
        chest.catchUp(10 * 60 * 60 * 1000)
        expect(chest.container(6, STARTER_TOP, 6)!.count('cobblestone')).toBe(27 * 64)
    })

    it('never repeats a stockpile being run down: diamonds put in a depot go once', () => {
        const island = Island.fresh()
        island.world.set(6, STARTER_TOP, 5, B.Depot)
        for (let i = 0; i < 2400; i++) island.step()
        island.insert(6, STARTER_TOP, 5, { item: 'diamond', count: 64 }, 0)
        for (let i = 0; i < 40; i++) island.step()
        expect(island.store.get('diamond')).toBe(64)
        island.catchUp(24 * 60 * 60 * 1000)
        expect(island.store.get('diamond')).toBe(64)
    })

    it('keeps its ledger in a save', () => {
        const island = machine(B.Depot, 70)
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!)
        expect(back.ledger.buckets.length).toBe(1)
        // The loaded island has no machine running: its replayed minute makes nothing, so the
        // saved minute's rate is halved by it (about 1800 for the hour, not 3600).
        const before = back.store.get('cobblestone') ?? 0
        back.catchUp(60 * 60 * 1000)
        expect(back.store.get('cobblestone')! - before).toBeGreaterThan(1500)
    })
})
