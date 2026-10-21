import type { ItemStack } from '#shared/utils/skyfarm/save'
import { B, BLOCKS, block, type Tool } from './blocks'
import { DYE_COLORS, dyeKey } from './dyes'

/*
 * Everything you can hold. Every block is an item that places itself; the rest
 * are materials, seeds, buckets and tools. Items are keyed by string in saves
 * (ids are for blocks only), so they can be renamed in display without
 * breaking anything.
 */

/** Where armour is worn: head, chest, legs, feet (the armour slots, in that order). */
export type ArmorSlot = 'head' | 'chest' | 'legs' | 'feet'
export const ARMOR_SLOTS: ArmorSlot[] = ['head', 'chest', 'legs', 'feet']
const PIECE: Record<ArmorSlot, string> = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' }

/**
 * Armour materials, Minecraft's numbers: protection per piece (head, chest,
 * legs, feet) and toughness. `texture` names the skin it is drawn with on a
 * mob; `tier` is the order a mob's armour is rolled in (leather to diamond).
 */
export const ARMOR_MATERIALS = {
    leather: { name: 'Leather', defense: [1, 3, 2, 1], toughness: 0, texture: 'leather', tier: 0, color: 0xa06540 },
    golden: { name: 'Golden', defense: [2, 5, 3, 1], toughness: 0, texture: 'gold', tier: 1, color: 0xf5d340 },
    chainmail: { name: 'Chainmail', defense: [2, 5, 4, 1], toughness: 0, texture: 'chainmail', tier: 2, color: 0x9a9a9a },
    iron: { name: 'Iron', defense: [2, 6, 5, 2], toughness: 0, texture: 'iron', tier: 3, color: 0xd8d8d8 },
    diamond: { name: 'Diamond', defense: [3, 8, 6, 3], toughness: 2, texture: 'diamond', tier: 4, color: 0x5ae0e0 }
} as const
export type ArmorMaterial = keyof typeof ARMOR_MATERIALS

export interface ItemDef {
    key: string
    name: string
    /** The block it places, if any. */
    places?: B
    /** A tool: what it is and how fast it mines (1 is the bare hand). */
    tool?: { kind: Tool, speed: number }
    /** Armour: where it goes, how much it protects, and what it's made of. */
    armor?: { slot: ArmorSlot, defense: number, toughness: number, material: ArmorMaterial }
    maxStack: number
    /** Swatch for the inventory icon. */
    color: number
}

const ITEMS = new Map<string, ItemDef>()
const add = (d: ItemDef) => ITEMS.set(d.key, d)

for (const b of BLOCKS) {
    if (b.id === B.Air || b.id === B.Water || b.id === B.Lava || b.id === B.PistonHead || b.id === B.Bedrock || b.id === B.Fire || b.id === B.TallGrass || b.id === B.DoubleTallGrass) continue
    // Plants and dust are placed by their seed/material item instead.
    if ([B.Wheat, B.MelonStem, B.PumpkinStem, B.RedstoneDust].includes(b.id)) continue
    add({ key: b.key, name: b.name, places: b.id, maxStack: 64, color: b.colors[1] })
}

add({ key: 'wheat_seeds', name: 'Wheat Seeds', places: B.Wheat, maxStack: 64, color: 0x8fb04a })
add({ key: 'melon_seeds', name: 'Melon Seeds', places: B.MelonStem, maxStack: 64, color: 0x2a2a20 })
add({ key: 'pumpkin_seeds', name: 'Pumpkin Seeds', places: B.PumpkinStem, maxStack: 64, color: 0xe0d090 })
add({ key: 'redstone', name: 'Redstone', places: B.RedstoneDust, maxStack: 64, color: 0xb01010 })
for (const [key, name, color] of [
    ['stick', 'Stick', 0x8a6a3c], ['bone', 'Bone', 0xe8e4d0], ['bone_meal', 'Bone Meal', 0xf2f0e6], ['coal', 'Coal', 0x222222], ['charcoal', 'Charcoal', 0x2e2620], ['glowstone_dust', 'Glowstone Dust', 0xf2d27a], ['iron_ingot', 'Iron Ingot', 0xd8d8d8], ['gold_ingot', 'Gold Ingot', 0xf5d340],
    ['diamond', 'Diamond', 0x5ae0e0], ['wheat', 'Wheat', 0xd9c25a], ['bread', 'Bread', 0xb07a3a], ['apple', 'Apple', 0xd8282a], ['melon_slice', 'Melon Slice', 0xe04a4a]
] as const) add({ key, name, maxStack: 64, color })
// What mobs drop, and their meat cooked.
for (const [key, name, color] of [
    ['leather', 'Leather', 0x9a5a2c], ['beef', 'Raw Beef', 0xc8483c], ['cooked_beef', 'Steak', 0x7a4a2a], ['porkchop', 'Raw Porkchop', 0xe89a9a],
    ['cooked_porkchop', 'Cooked Porkchop', 0xc8925a], ['mutton', 'Raw Mutton', 0xc84a4a], ['cooked_mutton', 'Cooked Mutton', 0x9a5a3a],
    ['chicken', 'Raw Chicken', 0xf0c8b0], ['cooked_chicken', 'Cooked Chicken', 0xc8925a], ['feather', 'Feather', 0xf0f0f0],
    ['rotten_flesh', 'Rotten Flesh', 0x8a5a3a], ['gunpowder', 'Gunpowder', 0x6a6a6a], ['string', 'String', 0xf0f0f0], ['arrow', 'Arrow', 0x8a6a3c],
    ['sugar', 'Sugar', 0xf4f4f4], ['spider_eye', 'Spider Eye', 0x9a2a3a], ['glass_bottle', 'Glass Bottle', 0xcfe8f0]
] as const) add({ key, name, maxStack: 64, color })
// Dyes (DYE_COLORS), the squid's ink sac, and shears.
for (const [color, rgb] of DYE_COLORS) add({ key: dyeKey(color), name: `${color.split('_').map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')} Dye`, maxStack: 64, color: rgb })
add({ key: 'ink_sac', name: 'Ink Sac', maxStack: 64, color: 0x1d1d21 })
add({ key: 'shears', name: 'Shears', maxStack: 1, color: 0xc8c8c8 })
add({ key: 'bucket', name: 'Bucket', maxStack: 16, color: 0xb0b0b8 })
add({ key: 'water_bucket', name: 'Water Bucket', maxStack: 1, color: 0x2f5fd0 })
add({ key: 'lava_bucket', name: 'Lava Bucket', maxStack: 1, color: 0xe25a14 })
for (const [tier, speed, color] of [['wooden', 2, 0xa07a48], ['stone', 4, 0x8a8a8a], ['iron', 6, 0xe0e0e0], ['diamond', 8, 0x5ae0e0]] as const) {
    for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe'] as const) {
        add({ key: `${tier}_${kind}`, name: `${tier[0]!.toUpperCase()}${tier.slice(1)} ${kind[0]!.toUpperCase()}${kind.slice(1)}`, tool: { kind, speed }, maxStack: 1, color })
    }
    add({ key: `${tier}_sword`, name: `${tier[0]!.toUpperCase()}${tier.slice(1)} Sword`, tool: { kind: 'sword', speed: 1.5 }, maxStack: 1, color })
}

for (const [material, m] of Object.entries(ARMOR_MATERIALS) as [ArmorMaterial, (typeof ARMOR_MATERIALS)[ArmorMaterial]][]) {
    ARMOR_SLOTS.forEach((slot, i) => {
        const piece = PIECE[slot]
        add({ key: `${material}_${piece}`, name: `${m.name} ${piece[0]!.toUpperCase()}${piece.slice(1)}`, armor: { slot, defense: m.defense[i]!, toughness: m.toughness, material }, maxStack: 1, color: m.color })
    })
}
add({ key: 'golden_apple', name: 'Golden Apple', maxStack: 64, color: 0xf5d340 })
add({ key: 'paper', name: 'Paper', maxStack: 64, color: 0xf0f0e8 })
// What villagers trade in.
add({ key: 'emerald', name: 'Emerald', maxStack: 64, color: 0x2ad25a })
add({ key: 'book', name: 'Book', maxStack: 64, color: 0x8a4a2a })
// Thrown with right click; one at a zombie villager weakens it for a golden apple to cure.
add({ key: 'splash_potion_weakness', name: 'Splash Potion of Weakness', maxStack: 1, color: 0x484d48 })
add({ key: 'iron_nugget', name: 'Iron Nugget', maxStack: 64, color: 0xd8d8d8 })
add({ key: 'gold_nugget', name: 'Gold Nugget', maxStack: 64, color: 0xf5d340 })

/** The armour piece of `material` for `slot` (an item key). */
export const armorKey = (material: ArmorMaterial, slot: ArmorSlot) => `${material}_${PIECE[slot]}`

/** Armour points and toughness of what is worn (keys or stacks, null for nothing). */
export function armorValue(worn: (string | null | undefined)[]) {
    let armor = 0, toughness = 0
    for (const key of worn) {
        const a = key ? item(key).armor : undefined
        if (!a) continue
        armor += a.defense
        toughness += a.toughness
    }
    return { armor, toughness }
}

/**
 * Damage after armour, Minecraft's formula: every point of armour takes 4%
 * off, less against a heavy hit unless the armour is tough, never more than 80%.
 */
export function afterArmor(damage: number, armor: number, toughness: number) {
    const points = Math.min(20, Math.max(armor / 5, armor - (4 * damage) / (toughness + 8)))
    return damage * (1 - points / 25)
}

/**
 * How hard a hit with `held` lands and how often it can land at full
 * strength (Minecraft's attack damage and attack speed, hits a second).
 */
export function attackStats(held: string | null): { damage: number, speed: number } {
    if (!held) return { damage: 1, speed: 4 }
    const tool = item(held).tool
    if (!tool) return { damage: 1, speed: 4 }
    const tier = held.split('_')[0]
    const t = ({ wooden: 0, stone: 1, iron: 2, diamond: 3 } as Record<string, number>)[tier ?? ''] ?? 0
    switch (tool.kind) {
        case 'sword': return { damage: 4 + t, speed: 1.6 }
        case 'axe': return { damage: [7, 9, 9, 9][t]!, speed: [0.8, 0.8, 0.9, 1][t]! }
        case 'pickaxe': return { damage: 2 + t, speed: 1.2 }
        case 'shovel': return { damage: 2.5 + t, speed: 1 }
        case 'hoe': return { damage: 1, speed: [1, 2, 3, 4][t]! }
        default: return { damage: 1, speed: 4 }
    }
}

export function item(key: string): ItemDef {
    return ITEMS.get(key) ?? { key, name: key, maxStack: 64, color: 0x888888 }
}

export function allItems() {
    return [...ITEMS.values()]
}

/**
 * Seconds to break a block holding `held` (an item key, or null for the bare
 * hand), and whether it drops anything. The right tool divides the time by its
 * speed; stone-like blocks need a pickaxe to drop at all.
 */
export function breakTime(blockId: number, held: string | null): { seconds: number, drops: boolean } {
    const def = block(blockId)
    if (!Number.isFinite(def.hardness)) return { seconds: Infinity, drops: false }
    if (def.hardness === 0) return { seconds: 0.05, drops: true }
    const tool = held ? item(held).tool : undefined
    const right = !!tool && tool.kind === def.tool
    const needsTool = def.tool === 'pickaxe'
    if (right) return { seconds: (def.hardness * 1.5) / tool!.speed, drops: true }
    return { seconds: def.hardness * (needsTool ? 5 : 1.5), drops: !needsTool }
}

/** A row of slots: the player's inventory (36, the first 9 the hotbar) or a chest (27). */
export class Slots {
    slots: (ItemStack | null)[]

    constructor(size: number, from?: (ItemStack | null)[]) {
        this.slots = Array.from({ length: size }, (_, i) => (from?.[i] ? { ...from[i]! } : null))
    }

    /** Puts items in, topping up stacks first; returns how many did not fit. */
    add(key: string, count: number): number {
        const max = item(key).maxStack
        for (const s of this.slots) {
            if (count <= 0) break
            if (s && s.item === key && s.count < max) {
                const n = Math.min(count, max - s.count)
                s.count += n
                count -= n
            }
        }
        for (let i = 0; i < this.slots.length && count > 0; i++) {
            if (this.slots[i]) continue
            const n = Math.min(count, max)
            this.slots[i] = { item: key, count: n }
            count -= n
        }
        return count
    }

    /** Takes up to `count` of `key`; returns how many it took. */
    take(key: string, count: number): number {
        let taken = 0
        for (let i = this.slots.length - 1; i >= 0 && taken < count; i--) {
            const s = this.slots[i]
            if (!s || s.item !== key) continue
            const n = Math.min(s.count, count - taken)
            s.count -= n
            taken += n
            if (s.count === 0) this.slots[i] = null
        }
        return taken
    }

    count(key: string) {
        return this.slots.reduce((n, s) => n + (s?.item === key ? s.count : 0), 0)
    }

    /** Takes one item out of a specific slot (placing a block, using a bucket). */
    useOne(i: number): string | null {
        const s = this.slots[i]
        if (!s) return null
        s.count--
        if (s.count === 0) this.slots[i] = null
        return s.item
    }
}
