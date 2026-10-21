import { describe, expect, it } from 'vitest'
import { columnFile, decodeMap, encodeMap, mapOf, readColumnFile } from '#shared/utils/skyfarm/binary'
import { ITEM_ID_COUNT, itemId, itemKey } from '#shared/utils/skyfarm/item-ids'
import { B } from '../../app/utils/skyfarm/blocks'
import { Island } from '../../app/utils/skyfarm/island'
import { allItems } from '../../app/utils/skyfarm/items'
import { STARTER_TOP } from '../../app/utils/skyfarm/world'
import { throughFile } from './save-helpers'

describe('item save ids', () => {
    it('gives every item in the game an id, and reads it back as the same item', () => {
        const missing = allItems().map(i => i.key).filter(k => itemId(k) === 0)
        // A new item needs a line at the end of shared/utils/skyfarm/item-ids.ts.
        expect(missing).toEqual([])
        for (const { key } of allItems()) expect(itemKey(itemId(key))).toBe(key)
        expect(itemKey(0)).toBeNull()
        expect(itemKey(ITEM_ID_COUNT + 1)).toBeNull()
    })
})

describe('the save files', () => {
    it('carry a chest and a furnace in the column they stand in, items as ids', () => {
        const island = Island.fresh()
        island.container(8, STARTER_TOP, 5)!.add('diamond', 7)
        island.placeFromSlot(0, 6, STARTER_TOP, 6)
        island.world.set(6, STARTER_TOP, 6, B.Furnace)
        island.furnace(6, STARTER_TOP, 6)!.box.add('cobblestone', 3)
        const save = island.toSave()
        const column = save.columns[0]!
        expect(column.containers.map(c => [c.x, c.y, c.z])).toContainEqual([8, STARTER_TOP, 5])
        // The map holds no containers: they are in the column file.
        expect(save.state.containers).toBeUndefined()
        const file = columnFile(column)
        // Item keys don't appear in the file: only their ids.
        expect(new TextDecoder('latin1').decode(file)).not.toContain('diamond')
        const back = Island.fromSave(throughFile(save)!)
        expect(back.container(8, STARTER_TOP, 5)!.count('diamond')).toBe(7)
        expect(back.furnace(6, STARTER_TOP, 6)!.box.count('cobblestone')).toBe(3)
    })

    it('keeps the island state with no JSON in the map: villager trades, store, ledger and all', () => {
        const island = Island.fresh()
        island.inventory.add('golden_apple', 2)
        island.store.set('emerald', 1234)
        island.ledger.produce('cobblestone', 12)
        island.ledger.tick(() => island.containerTotals())
        const save = island.toSave()
        const map = encodeMap(mapOf(save, ['ab'.repeat(32)]))
        expect(new TextDecoder('latin1').decode(map)).not.toMatch(/emerald|golden_apple|"coins"/)
        const back = decodeMap(map)!.state
        expect(back.inventory.find(s => s?.item === 'golden_apple')?.count).toBe(2)
        expect(back.store).toEqual({ emerald: 1234 })
        expect(back.coins).toBe(save.state.coins)
        expect(back.player).toEqual(save.state.player)
    })

    it('refuses an unknown item id and a container outside its column', () => {
        const save = Island.fresh().toSave()
        const file = columnFile(save.columns[0]!)
        // The starter chest's first slot: after the blocks, the count, its x y z kind n, then the slot's id.
        const bad = file.slice()
        const at = 16 * 16 * 64 * 2 + 2 + 5
        new DataView(bad.buffer).setUint16(at, 60_000, true)
        new DataView(bad.buffer).setUint8(at + 2, 1)
        expect(readColumnFile(file, 0, 0)).not.toBeNull()
        expect(readColumnFile(bad, 0, 0)).toBeNull()
        const outside = file.slice()
        outside[16 * 16 * 64 * 2 + 2] = 16
        expect(readColumnFile(outside, 0, 0)).toBeNull()
    })
})
