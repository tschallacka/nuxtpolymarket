import { B } from './blocks'
import { allItems, item, type Slots } from './items'

/*
 * The furnace, as in Minecraft: an item in the top slot smelts in ten seconds
 * while fuel in the bottom slot burns, and the result stacks up on the right.
 * A fuel burns for a fixed time once lit, whether there is anything left to
 * smelt or not; a furnace only lights a new fuel when it has something to do.
 */

export const FURNACE_SLOTS = 3
export const FURNACE_INPUT = 0
export const FURNACE_FUEL = 1
export const FURNACE_OUTPUT = 2

/** Ticks one item takes to smelt: ten seconds. */
export const SMELT_TICKS = 200

/** What smelts into what. */
export const SMELTS: Record<string, string> = {
    cobblestone: 'stone',
    sand: 'glass',
    oak_log: 'charcoal',
    cactus: 'green_dye',
    iron_ore: 'iron_ingot',
    gold_ore: 'gold_ingot',
    beef: 'cooked_beef',
    porkchop: 'cooked_porkchop',
    mutton: 'cooked_mutton',
    chicken: 'cooked_chicken',
    stone: 'smooth_stone'
}
// Iron and chainmail gear (tools, swords, armour) melts down to an iron nugget, gold to a gold nugget.
for (const def of allItems()) {
    if (!def.tool && !def.armor) continue
    if (def.key.startsWith('iron_') || def.key.startsWith('chainmail_')) SMELTS[def.key] = 'iron_nugget'
    else if (def.key.startsWith('golden_')) SMELTS[def.key] = 'gold_nugget'
}

/** Ticks a fuel burns for (Minecraft's: coal smelts eight items, a log one and a half). */
export const FUEL: Record<string, number> = {
    lava_bucket: 20000,
    coal: 1600,
    charcoal: 1600,
    oak_log: 300,
    oak_planks: 300,
    crafting_table: 300,
    chest: 300,
    oak_slab: 150,
    wooden_pickaxe: 200,
    wooden_axe: 200,
    wooden_shovel: 200,
    wooden_hoe: 200,
    wooden_sword: 200,
    white_wool: 100,
    stick: 100,
    oak_sapling: 100
}

export interface FurnaceState {
    /** Ticks the current fuel has left, and how long it burns in all (for the flame gauge). */
    burn: number
    burnMax: number
    /** Ticks the item in the top slot has smelted for. */
    cook: number
}

export const idleFurnace = (): FurnaceState => ({ burn: 0, burnMax: 0, cook: 0 })

/** Which furnace: the furnace smelts anything; a smoker only food, a blast furnace only ores and metal gear. */
export type FurnaceKind = 'furnace' | 'smoker' | 'blast_furnace'
export const furnaceKind = (id: number): FurnaceKind => (id === B.Smoker ? 'smoker' : id === B.BlastFurnace ? 'blast_furnace' : 'furnace')
const FOOD = new Set(['beef', 'porkchop', 'mutton', 'chicken'])

/** What `key` smelts into in a furnace of this kind (undefined: not here). */
export function smeltResult(kind: FurnaceKind, key: string): string | undefined {
    const result = SMELTS[key]
    if (!result || kind === 'furnace') return result
    if (kind === 'smoker') return FOOD.has(key) ? result : undefined
    return /_ore$/.test(key) || result.endsWith('_nugget') ? result : undefined
}

/** The smoker and blast furnace work twice as fast (and burn their fuel twice as fast). */
const speedOf = (kind: FurnaceKind) => (kind === 'furnace' ? 1 : 2)

/** Whether the furnace has something to smelt and room for the result. */
function canSmelt(box: Slots, kind: FurnaceKind) {
    const input = box.slots[FURNACE_INPUT]
    const result = input ? smeltResult(kind, input.item) : undefined
    if (!result) return false
    const out = box.slots[FURNACE_OUTPUT]
    return !out || (out.item === result && out.count < item(result).maxStack)
}

/** One tick of a furnace. Returns whether it is burning afterwards. */
export function stepFurnace(box: Slots, f: FurnaceState, kind: FurnaceKind = 'furnace'): boolean {
    if (f.burn > 0) f.burn--
    const smelting = canSmelt(box, kind)
    const cookTicks = SMELT_TICKS / speedOf(kind)
    if (f.burn === 0 && smelting) {
        const fuel = box.slots[FURNACE_FUEL]
        const ticks = fuel ? Math.floor((FUEL[fuel.item] ?? 0) / speedOf(kind)) : 0
        if (ticks > 0) {
            f.burn = f.burnMax = ticks
            // Lava burns out of its bucket and leaves the bucket behind.
            if (fuel!.item === 'lava_bucket') box.slots[FURNACE_FUEL] = { item: 'bucket', count: 1 }
            else box.useOne(FURNACE_FUEL)
        }
    }
    if (f.burn > 0 && smelting) {
        if (++f.cook >= cookTicks) {
            f.cook = 0
            const result = smeltResult(kind, box.slots[FURNACE_INPUT]!.item)!
            box.useOne(FURNACE_INPUT)
            const out = box.slots[FURNACE_OUTPUT]
            if (out) out.count++
            else box.slots[FURNACE_OUTPUT] = { item: result, count: 1 }
        }
    } else if (!smelting) {
        f.cook = 0
    } else if (f.cook > 0) {
        // Out of fuel mid-smelt: the progress cools back down.
        f.cook = Math.max(0, f.cook - 2)
    }
    return f.burn > 0
}

/** Whether a furnace has nothing to do and nothing burning, so it can be skipped. */
export function furnaceIdle(box: Slots, f: FurnaceState, kind: FurnaceKind = 'furnace') {
    return f.burn === 0 && f.cook === 0 && !canSmelt(box, kind)
}

/** How far along the item in a furnace of this kind is, 0..1. */
export const cookProgress = (f: FurnaceState, kind: FurnaceKind) => f.cook / (SMELT_TICKS / speedOf(kind))
