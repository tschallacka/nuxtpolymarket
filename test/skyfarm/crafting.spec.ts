import { describe, expect, it } from 'vitest'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { consume, craft, RECIPES, Recipes } from '../../app/utils/skyfarm/crafting'
import { clickSlot, craftAll, dragSplit, takeResult } from '../../app/utils/skyfarm/cursor'
import { allItems, Slots } from '../../app/utils/skyfarm/items'

describe('the cursor', () => {
    it('picks up, puts down, merges and swaps like Minecraft', () => {
        const slots: (ItemStack | null)[] = [{ item: 'dirt', count: 10 }, { item: 'dirt', count: 60 }, { item: 'sand', count: 1 }, null]
        let cursor = clickSlot(slots, 0, null, false)
        expect(cursor).toEqual({ item: 'dirt', count: 10 })
        // Merging fills the other stack to 64 and keeps the rest.
        cursor = clickSlot(slots, 1, cursor, false)
        expect(slots[1]!.count).toBe(64)
        expect(cursor).toEqual({ item: 'dirt', count: 6 })
        // A different item swaps.
        cursor = clickSlot(slots, 2, cursor, false)
        expect(slots[2]).toEqual({ item: 'dirt', count: 6 })
        expect(cursor).toEqual({ item: 'sand', count: 1 })
        cursor = clickSlot(slots, 3, cursor, false)
        expect(cursor).toBeNull()
    })

    it('drag-splits a stack equally, keeping what does not divide', () => {
        const slots: (ItemStack | null)[] = [null, null, null, { item: 'dirt', count: 62 }, { item: 'sand', count: 1 }]
        const refs = [0, 1, 2, 3, 4].map(i => ({ slots, i }))
        // 10 dirt over three empties, a nearly full dirt stack (room for 2) and a sand slot (skipped).
        const cursor = dragSplit(refs, { item: 'dirt', count: 10 }, false)
        expect(slots.slice(0, 3).map(s => s?.count)).toEqual([2, 2, 2])
        expect(slots[3]!.count).toBe(64)
        expect(slots[4]).toEqual({ item: 'sand', count: 1 })
        expect(cursor).toEqual({ item: 'dirt', count: 2 })
    })

    it('right-drags one into each slot, and never over more slots than items', () => {
        const slots: (ItemStack | null)[] = [null, null, null, null]
        const refs = [0, 1, 2, 3].map(i => ({ slots, i }))
        expect(dragSplit(refs, { item: 'dirt', count: 5 }, true)).toEqual({ item: 'dirt', count: 1 })
        expect(slots.map(s => s?.count)).toEqual([1, 1, 1, 1])
        const few: (ItemStack | null)[] = [null, null, null]
        expect(dragSplit([0, 1, 2].map(i => ({ slots: few, i })), { item: 'dirt', count: 2 }, false)).toBeNull()
        expect(few.map(s => s?.count ?? 0)).toEqual([1, 1, 0])
    })

    it('takes half with a right click, and puts down one', () => {
        const slots: (ItemStack | null)[] = [{ item: 'dirt', count: 5 }, null]
        let cursor = clickSlot(slots, 0, null, true)
        expect(cursor).toEqual({ item: 'dirt', count: 3 })
        expect(slots[0]!.count).toBe(2)
        cursor = clickSlot(slots, 1, cursor, true)
        expect(slots[1]).toEqual({ item: 'dirt', count: 1 })
        expect(cursor).toEqual({ item: 'dirt', count: 2 })
    })
})

/** A grid from rows of letters: P planks, L log, S stick, C cobblestone, . empty. */
function grid(...lines: string[]): (ItemStack | null)[] {
    const names: Record<string, string> = { P: 'oak_planks', L: 'oak_log', S: 'stick', C: 'cobblestone', I: 'iron_ingot' }
    return lines.join('').split('').map(ch => (ch === '.' ? null : { item: names[ch]!, count: 2 }))
}

describe('crafting', () => {
    it('turns a log into four planks, wherever it sits', () => {
        expect(craft(grid('L.', '..'), 2)).toEqual({ item: 'oak_planks', count: 4 })
        expect(craft(grid('...', '...', '..L'), 3)).toEqual({ item: 'oak_planks', count: 4 })
    })

    it('makes a crafting table in the 2x2 grid', () => {
        expect(craft(grid('PP', 'PP'), 2)).toEqual({ item: 'crafting_table', count: 1 })
    })

    it('makes sticks from two planks stacked, in any column', () => {
        expect(craft(grid('.P', '.P'), 2)).toEqual({ item: 'stick', count: 4 })
        expect(craft(grid('PP', '..'), 2)).toBeNull()
    })

    it('makes a stone pickaxe only in the 3x3, and an axe either way round', () => {
        expect(craft(grid('CCC', '.S.', '.S.'), 3)).toEqual({ item: 'stone_pickaxe', count: 1 })
        expect(craft(grid('CC.', 'CS.', '.S.'), 3)).toEqual({ item: 'stone_axe', count: 1 })
        expect(craft(grid('.CC', '.SC', '.S.'), 3)).toEqual({ item: 'stone_axe', count: 1 })
    })

    it('makes nothing from a wrong shape', () => {
        expect(craft(grid('C.C', '.S.', '.S.'), 3)).toBeNull()
        expect(craft(grid('..', '..'), 2)).toBeNull()
    })

    it('only uses and makes items that exist', () => {
        const known = new Set(allItems().map(i => i.key))
        for (const r of RECIPES.all) {
            for (const k of [...Object.values(r.key), r.result.item]) expect(known.has(k), k).toBe(true)
        }
    })

    it('needs a shaped recipe in exactly its cells, an unshaped one only in its form', () => {
        const book = new Recipes()
            .shaped(['P  ', 'P  ', '   '], { P: 'oak_planks' }, 'stick')
            .unshaped(['C  ', 'C  ', '   '], { C: 'cobblestone' }, 'lever')
        expect(book.craft(grid('P..', 'P..', '...'), 3)).toEqual({ item: 'stick', count: 1 })
        // Shaped: one column over is no longer the recipe.
        expect(book.craft(grid('.P.', '.P.', '...'), 3)).toBeNull()
        // Unshaped: the same form works anywhere.
        expect(book.craft(grid('...', '..C', '..C'), 3)).toEqual({ item: 'lever', count: 1 })
        // The inventory's 2x2 is the top-left of a 3x3, so a shaped recipe there fits as drawn.
        expect(book.craft(grid('P.', 'P.'), 2)).toEqual({ item: 'stick', count: 1 })
        expect(book.craft(grid('.P', '.P'), 2)).toBeNull()
    })

    it('refuses a grid that is not 3x3, or a character missing from the key', () => {
        expect(() => new Recipes().shaped(['PP', 'PP', '  '] as never, { P: 'oak_planks' }, 'x')).toThrow('3 rows of 3')
        expect(() => new Recipes().shaped(['PQ ', '   ', '   '], { P: 'oak_planks' }, 'x')).toThrow('\'Q\'')
    })

    it('crafts onto the cursor, and shift-crafts everything the grid allows', () => {
        const g: (ItemStack | null)[] = [{ item: 'oak_log', count: 3 }, null, null, null]
        let cursor = takeResult(g, 2, null)
        expect(cursor).toEqual({ item: 'oak_planks', count: 4 })
        cursor = takeResult(g, 2, cursor)
        expect(cursor).toEqual({ item: 'oak_planks', count: 8 })
        const inv = new Slots(36)
        expect(craftAll(g, 2, inv)).toBe(4)
        expect(g[0]).toBeNull()
        expect(inv.count('oak_planks')).toBe(4)
    })

    it('uses one of each ingredient', () => {
        const g = grid('PP', 'PP')
        g[0] = { item: 'oak_planks', count: 1 }
        consume(g)
        expect(g[0]).toBeNull()
        expect(g[3]).toEqual({ item: 'oak_planks', count: 1 })
    })
})
