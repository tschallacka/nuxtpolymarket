import type { ItemStack } from '#shared/utils/skyfarm/save'
import { DYE_COLORS, DYE_MIXES, DYE_SOURCES, dyeKey, woolKey } from './dyes'
import { armorKey } from './items'

/*
 * Crafting. A recipe is registered as a key (character => item) and a 3x3
 * grid of those characters, a space for an empty cell, in one of two kinds:
 *
 *   shaped:    the items must sit in exactly those cells of the 3x3 grid;
 *   unshaped:  only the form counts: the same arrangement anywhere in the grid;
 *   shapeless: only the items count, laid anywhere (Minecraft's shapeless recipes).
 *
 * Neither is mirrored; a recipe that works either way round is registered
 * twice. The inventory's 2x2 grid is the top-left corner of a 3x3.
 */

export type RecipeKind = 'shaped' | 'unshaped' | 'shapeless'

export interface Recipe {
    kind: RecipeKind
    /** Three rows of three characters; a space is an empty cell. */
    grid: [string, string, string]
    key: Record<string, string>
    result: ItemStack
}

type Cells = (string | null)[][]

/** A recipe's grid as item keys, checked for shape and for characters missing from the key. */
function cellsOf(r: Recipe): Cells {
    if (r.grid.length !== 3 || r.grid.some(row => row.length !== 3)) throw new Error(`Recipe for ${r.result.item}: the grid must be 3 rows of 3`)
    return r.grid.map(row => [...row].map((ch) => {
        if (ch === ' ') return null
        const it = r.key[ch]
        if (!it) throw new Error(`Recipe for ${r.result.item}: '${ch}' is not in the key`)
        return it
    }))
}

/** Cuts empty rows and columns off every side, leaving the form. */
function trim(cells: Cells): Cells {
    const used = (line: (string | null)[]) => line.some(c => c !== null)
    let top = 0, bottom = cells.length - 1
    while (top <= bottom && !used(cells[top]!)) top++
    while (bottom >= top && !used(cells[bottom]!)) bottom--
    if (top > bottom) return []
    const kept = cells.slice(top, bottom + 1)
    let left = 0, right = kept[0]!.length - 1
    while (left <= right && !used(kept.map(row => row[left]!))) left++
    while (right >= left && !used(kept.map(row => row[right]!))) right--
    return kept.map(row => row.slice(left, right + 1))
}

const same = (a: Cells, b: Cells) => a.length === b.length && a.every((row, y) => row.length === b[y]!.length && row.every((c, x) => c === b[y]![x]))

export class Recipes {
    private list: { recipe: Recipe, cells: Cells, form: Cells }[] = []

    register(kind: RecipeKind, grid: [string, string, string], key: Record<string, string>, result: ItemStack) {
        const recipe: Recipe = { kind, grid, key, result }
        const cells = cellsOf(recipe)
        this.list.push({ recipe, cells, form: trim(cells) })
        return this
    }

    shaped(grid: [string, string, string], key: Record<string, string>, item: string, count = 1) {
        return this.register('shaped', grid, key, { item, count })
    }

    unshaped(grid: [string, string, string], key: Record<string, string>, item: string, count = 1) {
        return this.register('unshaped', grid, key, { item, count })
    }

    /** `items`: one entry per item to lay in the grid, anywhere. */
    shapeless(items: string[], item: string, count = 1) {
        const chars = 'abcdefghi'
        const key: Record<string, string> = {}
        const flat = items.map((it, i) => {
            key[chars[i]!] = it
            return chars[i]!
        }).join('').padEnd(9, ' ')
        return this.register('shapeless', [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)], key, { item, count })
    }

    get all(): Recipe[] {
        return this.list.map(e => e.recipe)
    }

    /** What a crafting grid (`size` 2 or 3, row by row) makes, or null. */
    craft(grid: (ItemStack | null)[], size: number): ItemStack | null {
        // Lay the grid into the top-left of a 3x3.
        const cells: Cells = [0, 1, 2].map(y => [0, 1, 2].map(x => (x < size && y < size ? grid[y * size + x]?.item ?? null : null)))
        const form = trim(cells)
        if (!form.length) return null
        const bag = (c: Cells) => c.flat().filter((x): x is string => x !== null).sort().join('|')
        const have = bag(cells)
        for (const e of this.list) {
            const hit = e.recipe.kind === 'shaped' ? same(cells, e.cells) : e.recipe.kind === 'shapeless' ? have === bag(e.cells) : same(form, e.form)
            if (hit) return { ...e.recipe.result }
        }
        return null
    }
}

export const RECIPES = new Recipes()
    .unshaped(['L  ', '   ', '   '], { L: 'oak_log' }, 'oak_planks', 4)
    .unshaped(['P  ', 'P  ', '   '], { P: 'oak_planks' }, 'stick', 4)
    .unshaped(['PP ', 'PP ', '   '], { P: 'oak_planks' }, 'crafting_table')
    .shaped(['PPP', 'P P', 'PPP'], { P: 'oak_planks' }, 'chest')
    .shaped(['CCC', 'C C', 'CCC'], { C: 'cobblestone' }, 'furnace')
    // Slabs: three in a row, any row.
    .unshaped(['PPP', '   ', '   '], { P: 'oak_planks' }, 'oak_slab', 6)
    .unshaped(['CCC', '   ', '   '], { C: 'cobblestone' }, 'cobblestone_slab', 6)
    .unshaped(['SSS', '   ', '   '], { S: 'stone' }, 'stone_slab', 6)
    .unshaped(['WWW', '   ', '   '], { W: 'wheat' }, 'bread')
    .unshaped(['I I', ' I ', '   '], { I: 'iron_ingot' }, 'bucket')
    .shaped(['I I', 'ICI', ' I '], { I: 'iron_ingot', C: 'chest' }, 'hopper')
    .unshaped(['S  ', 'C  ', '   '], { S: 'stick', C: 'cobblestone' }, 'lever')
    .unshaped(['S  ', '   ', '   '], { S: 'stone' }, 'button')
    .unshaped(['R  ', 'S  ', '   '], { R: 'redstone', S: 'stick' }, 'redstone_torch')
    .unshaped(['TRT', 'SSS', '   '], { T: 'redstone_torch', R: 'redstone', S: 'stone' }, 'repeater')
    .shaped(['PPP', 'CIC', 'CRC'], { P: 'oak_planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone' }, 'piston')
    .shaped(['CCC', 'C C', 'CRC'], { C: 'cobblestone', R: 'redstone' }, 'dropper')
    .unshaped(['M  ', '   ', '   '], { M: 'melon_slice' }, 'melon_seeds')
    .shaped(['MMM', 'MMM', 'MMM'], { M: 'melon_slice' }, 'melon')
    .unshaped(['P  ', '   ', '   '], { P: 'pumpkin' }, 'pumpkin_seeds', 4)
    .unshaped(['B  ', '   ', '   '], { B: 'bone' }, 'bone_meal', 3)
    .unshaped(['C  ', 'S  ', '   '], { C: 'coal', S: 'stick' }, 'torch', 4)
    .unshaped(['C  ', 'S  ', '   '], { C: 'charcoal', S: 'stick' }, 'torch', 4)
    .unshaped(['P  ', 'T  ', '   '], { P: 'pumpkin', T: 'torch' }, 'jack_o_lantern')
    .unshaped(['GG ', 'GG ', '   '], { G: 'glowstone_dust' }, 'glowstone')

for (const [tier, material] of [['wooden', 'oak_planks'], ['stone', 'cobblestone'], ['iron', 'iron_ingot'], ['diamond', 'diamond']] as const) {
    const key = { M: material, S: 'stick' }
    RECIPES.shaped(['MMM', ' S ', ' S '], key, `${tier}_pickaxe`)
        // The axe works either way round, so it is registered both ways.
        .unshaped(['MM ', 'MS ', ' S '], key, `${tier}_axe`)
        .unshaped(['MM ', 'SM ', 'S  '], key, `${tier}_axe`)
        .unshaped(['M  ', 'S  ', 'S  '], key, `${tier}_shovel`)
        // The hoe, like the axe, either way round.
        .unshaped(['MM ', ' S ', ' S '], key, `${tier}_hoe`)
        .unshaped(['MM ', 'S  ', 'S  '], key, `${tier}_hoe`)
        .unshaped(['M  ', 'M  ', 'S  '], key, `${tier}_sword`)
}

// Armour: helmets and boots fit in either the top or the bottom two rows.
for (const [material, M] of [['leather', 'leather'], ['golden', 'gold_ingot'], ['iron', 'iron_ingot'], ['diamond', 'diamond']] as const) {
    RECIPES.unshaped(['MMM', 'M M', '   '], { M }, armorKey(material, 'head'))
        .shaped(['M M', 'MMM', 'MMM'], { M }, armorKey(material, 'chest'))
        .shaped(['MMM', 'M M', 'M M'], { M }, armorKey(material, 'legs'))
        .unshaped(['M M', 'M M', '   '], { M }, armorKey(material, 'feet'))
}
// Nuggets: nine to an ingot, and back.
for (const [nugget, ingot] of [['iron_nugget', 'iron_ingot'], ['gold_nugget', 'gold_ingot']] as const) {
    RECIPES.shaped(['NNN', 'NNN', 'NNN'], { N: nugget }, ingot)
        .unshaped(['I  ', '   ', '   '], { I: ingot }, nugget, 9)
}

RECIPES.shaped(['GGG', 'GAG', 'GGG'], { G: 'gold_ingot', A: 'apple' }, 'golden_apple')

// Paper, books, and the blocks villagers work at (Minecraft's recipes; the fletching
// table wants flint and the brewing stand a blaze rod, neither of which a skyblock has:
// the shop sells those two).
RECIPES.unshaped(['CCC', '   ', '   '], { C: 'sugar_cane' }, 'paper', 3)
    .shapeless(['paper', 'paper', 'paper', 'leather'], 'book')
    .shaped(['PPP', 'BBB', 'PPP'], { P: 'oak_planks', B: 'book' }, 'bookshelf')
    .unshaped(['S S', 'S S', 'SSS'], { S: 'oak_slab' }, 'composter')
    .shaped(['PSP', 'P P', 'PSP'], { P: 'oak_planks', S: 'oak_slab' }, 'barrel')
    .shaped([' L ', 'LFL', ' L '], { L: 'oak_log', F: 'furnace' }, 'smoker')
    .shaped(['III', 'IFI', 'SSS'], { I: 'iron_ingot', F: 'furnace', S: 'smooth_stone' }, 'blast_furnace')
    .unshaped([' I ', 'SSS', '   '], { I: 'iron_ingot', S: 'stone' }, 'stonecutter')
    .unshaped(['II ', 'PP ', 'PP '], { I: 'iron_ingot', P: 'oak_planks' }, 'smithing_table')
    .unshaped(['TST', 'P P', '   '], { T: 'stick', S: 'stone_slab', P: 'oak_planks' }, 'grindstone')
    .unshaped(['AA ', 'PP ', 'PP '], { A: 'paper', P: 'oak_planks' }, 'cartography_table')
    .shaped(['I I', 'I I', 'III'], { I: 'iron_ingot' }, 'cauldron')
    .shaped(['SSS', ' B ', ' S '], { S: 'oak_slab', B: 'bookshelf' }, 'lectern')
    .unshaped(['SS ', 'PP ', '   '], { S: 'string', P: 'oak_planks' }, 'loom')
    .unshaped(['SS ', 'SS ', '   '], { S: 'stone' }, 'stone_bricks', 4)
    .unshaped(['BBB', '   ', '   '], { B: 'stone_bricks' }, 'stone_brick_slab', 6)
    .shaped(['EEE', 'EEE', 'EEE'], { E: 'emerald' }, 'emerald_block')
    .unshaped(['B  ', '   ', '   '], { B: 'emerald_block' }, 'emerald', 9)

// Dyes: from a flower (or bone meal, or an ink sac) alone in the grid, and mixed.
for (const [from, color, count] of DYE_SOURCES) RECIPES.shapeless([from], dyeKey(color), count)
for (const [dyes, color, count] of DYE_MIXES) RECIPES.shapeless(dyes.map(dyeKey), dyeKey(color), count)
// Wool of any colour and a dye make wool of the dye's colour (Minecraft 1.21's recipe).
for (const [color] of DYE_COLORS) {
    for (const [from] of DYE_COLORS) if (from !== color) RECIPES.shapeless([dyeKey(color), woolKey(from)], woolKey(color))
}
RECIPES.unshaped(['I  ', ' I ', '   '], { I: 'iron_ingot' }, 'shears')
    .unshaped([' I ', 'I  ', '   '], { I: 'iron_ingot' }, 'shears')

RECIPES.unshaped(['SS ', 'SS ', '   '], { S: 'string' }, 'white_wool')
    .unshaped(['S  ', '   ', '   '], { S: 'sugar_cane' }, 'sugar')
    .shaped(['G G', ' G ', '   '], { G: 'glass' }, 'glass_bottle', 3)

/**
 * The stonecutter: one block of stone in, one cut out (Minecraft gives two
 * slabs where a crafting table gives one for each half block).
 */
export const STONECUTTING: Record<string, ItemStack[]> = {
    stone: [{ item: 'stone_slab', count: 2 }, { item: 'stone_bricks', count: 1 }, { item: 'stone_brick_slab', count: 2 }],
    cobblestone: [{ item: 'cobblestone_slab', count: 2 }],
    stone_bricks: [{ item: 'stone_brick_slab', count: 2 }]
}

/** What a `size` x `size` grid makes with the game's recipes, or null. */
export function craft(grid: (ItemStack | null)[], size: number): ItemStack | null {
    return RECIPES.craft(grid, size)
}

/** Uses up one of each ingredient in the grid (after taking the result). */
export function consume(grid: (ItemStack | null)[]) {
    for (let i = 0; i < grid.length; i++) {
        const s = grid[i]
        if (!s) continue
        s.count--
        if (s.count <= 0) grid[i] = null
    }
}
