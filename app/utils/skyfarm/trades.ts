import type { ItemStack } from '#shared/utils/skyfarm/save'

/*
 * Villager trades, Minecraft's (Java edition's tables), kept to what exists
 * on an island: a trade for potatoes, fish, maps, enchanted books, bells or
 * flint is left out, so some trades have short lists. Every villager starts a
 * Novice with two offers from its trade's first list; trading with it earns it
 * experience, and at each new level it adds two offers from that level's list.
 * Offers run out after so many uses and come back when it restocks at its
 * workstation, at most twice a day.
 */

export interface TradeDef {
    /** What you give (and, for some, a second thing), and what you get. */
    a: [string, number]
    b?: [string, number]
    out: [string, number]
    /** Uses before it runs out (until a restock), and the experience it gives the villager. */
    max: number
    xp: number
}

export interface Offer {
    a: ItemStack
    b?: ItemStack
    out: ItemStack
    uses: number
    max: number
    xp: number
}

const t = (a: [string, number], out: [string, number], max: number, xp: number, b?: [string, number]): TradeDef => ({ a, out, max, xp, ...(b ? { b } : {}) })
const E = 'emerald'

/** Each trade's offers by level: Novice, Apprentice, Journeyman, Expert, Master. */
export const TRADES: Record<string, TradeDef[][]> = {
    farmer: [
        [t(['wheat', 20], [E, 1], 16, 2), t([E, 1], ['bread', 6], 16, 1)],
        [t(['pumpkin', 6], [E, 1], 12, 10), t([E, 1], ['apple', 4], 16, 5)],
        [t(['melon', 4], [E, 1], 12, 20)],
        [],
        []
    ],
    fisherman: [
        [t(['string', 20], [E, 1], 16, 2), t(['coal', 10], [E, 1], 16, 2)],
        [], [], [], []
    ],
    butcher: [
        [t(['chicken', 14], [E, 1], 16, 2), t(['porkchop', 7], [E, 1], 16, 2)],
        [t(['coal', 15], [E, 1], 16, 2), t([E, 1], ['cooked_porkchop', 5], 16, 5), t([E, 1], ['cooked_chicken', 8], 16, 5)],
        [t(['mutton', 7], [E, 1], 16, 20), t(['beef', 10], [E, 1], 16, 20)],
        [],
        []
    ],
    armorer: [
        [t(['coal', 15], [E, 1], 16, 2), t([E, 5], ['iron_leggings', 1], 12, 1), t([E, 4], ['iron_boots', 1], 12, 1), t([E, 5], ['iron_helmet', 1], 12, 1), t([E, 9], ['iron_chestplate', 1], 12, 1)],
        [t(['iron_ingot', 4], [E, 1], 12, 10), t([E, 3], ['chainmail_leggings', 1], 12, 5), t([E, 1], ['chainmail_boots', 1], 12, 5)],
        [t(['lava_bucket', 1], [E, 1], 12, 20), t(['diamond', 1], [E, 1], 12, 20), t([E, 1], ['chainmail_helmet', 1], 12, 10), t([E, 4], ['chainmail_chestplate', 1], 12, 10)],
        [t([E, 14], ['diamond_leggings', 1], 3, 15), t([E, 8], ['diamond_boots', 1], 3, 15)],
        [t([E, 8], ['diamond_helmet', 1], 3, 30), t([E, 16], ['diamond_chestplate', 1], 3, 30)]
    ],
    toolsmith: [
        [t(['coal', 15], [E, 1], 16, 2), t([E, 1], ['stone_axe', 1], 12, 1), t([E, 1], ['stone_shovel', 1], 12, 1), t([E, 1], ['stone_pickaxe', 1], 12, 1), t([E, 1], ['stone_hoe', 1], 12, 1)],
        [t(['iron_ingot', 4], [E, 1], 12, 10)],
        [t([E, 4], ['diamond_hoe', 1], 3, 10)],
        [t(['diamond', 1], [E, 1], 12, 30), t([E, 12], ['diamond_axe', 1], 3, 15), t([E, 5], ['diamond_shovel', 1], 3, 15)],
        [t([E, 13], ['diamond_pickaxe', 1], 3, 30)]
    ],
    weaponsmith: [
        [t(['coal', 15], [E, 1], 16, 2), t([E, 3], ['iron_axe', 1], 12, 1), t([E, 2], ['iron_sword', 1], 12, 1)],
        [t(['iron_ingot', 4], [E, 1], 12, 10)],
        [],
        [t(['diamond', 1], [E, 1], 12, 30), t([E, 12], ['diamond_axe', 1], 3, 15)],
        [t([E, 8], ['diamond_sword', 1], 3, 30)]
    ],
    fletcher: [
        [t(['stick', 32], [E, 1], 16, 2), t([E, 1], ['arrow', 16], 12, 1)],
        [],
        [t(['string', 14], [E, 1], 16, 20)],
        [t(['feather', 24], [E, 1], 16, 30)],
        []
    ],
    leatherworker: [
        [t(['leather', 6], [E, 1], 16, 2), t([E, 3], ['leather_leggings', 1], 12, 1), t([E, 7], ['leather_chestplate', 1], 12, 1)],
        [t([E, 5], ['leather_helmet', 1], 12, 5), t([E, 4], ['leather_boots', 1], 12, 5)],
        [t([E, 7], ['leather_chestplate', 1], 12, 10)],
        [],
        [t([E, 5], ['leather_helmet', 1], 12, 30)]
    ],
    librarian: [
        [t(['paper', 24], [E, 1], 16, 2), t([E, 9], ['bookshelf', 1], 12, 1)],
        [t(['book', 4], [E, 1], 12, 10)],
        [t([E, 1], ['glass', 4], 12, 10)],
        [],
        []
    ],
    cleric: [
        [t(['rotten_flesh', 32], [E, 1], 16, 2), t([E, 1], ['redstone', 2], 12, 1)],
        [t(['gold_ingot', 3], [E, 1], 12, 10)],
        [t([E, 4], ['glowstone', 1], 12, 10)],
        [t(['glass_bottle', 9], [E, 1], 12, 30)],
        []
    ],
    cartographer: [
        [t(['paper', 24], [E, 1], 16, 2)],
        [], [], [], []
    ],
    shepherd: [
        [t(['white_wool', 18], [E, 1], 16, 2)],
        [t([E, 1], ['white_wool', 1], 16, 5)],
        [], [], []
    ],
    // Minecraft's Novice mason trades in clay and bricks, which an island hasn't got: stone and
    // stone bricks stand in (its Apprentice stone trade, moved down; bricks at the bricks' 10 for 1).
    mason: [
        [t(['stone', 20], [E, 1], 16, 2), t([E, 1], ['stone_bricks', 10], 16, 1)],
        [], [], [], []
    ]
}

/** The names of the five levels. */
export const LEVEL_NAMES = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master']
/** Experience a villager needs to reach each level (Minecraft's). */
export const LEVEL_XP = [0, 10, 70, 150, 250]

/** The level (1 to 5) that `xp` experience makes. */
export function levelFor(xp: number) {
    let level = 1
    for (let i = 1; i < LEVEL_XP.length; i++) if (xp >= LEVEL_XP[i]!) level = i + 1
    return level
}

/** Two offers (or what there are) from a trade's list for `level`, none already offered. */
export function newOffers(profession: string, level: number, have: Offer[], roll: () => number): Offer[] {
    const pool = (TRADES[profession]?.[level - 1] ?? []).filter(d => !have.some(o => o.out.item === d.out[0] && o.a.item === d.a[0]))
    const picked: TradeDef[] = []
    while (picked.length < 2 && pool.length) picked.push(pool.splice(Math.floor(roll() * pool.length), 1)[0]!)
    return picked.map(d => ({
        a: { item: d.a[0], count: d.a[1] },
        ...(d.b ? { b: { item: d.b[0], count: d.b[1] } } : {}),
        out: { item: d.out[0], count: d.out[1] },
        uses: 0,
        max: d.max,
        xp: d.xp
    }))
}

/** How strongly reputation moves prices (Minecraft's 0.05 for these trades). */
const PRICE_MULTIPLIER = 0.05

/**
 * What an offer costs you with this villager: Minecraft takes reputation
 * times the price multiplier off the first thing you give, never below one.
 * Curing a villager earns a lot of it, so most of its trades drop to one.
 */
export function priceOf(o: Offer, reputation: number): ItemStack {
    const off = Math.floor(Math.max(0, reputation) * PRICE_MULTIPLIER)
    return { item: o.a.item, count: Math.max(1, o.a.count - off) }
}

/** Reputation a villager holds for you once you have cured it (Minecraft's major and minor positive gossip). */
export const CURED_REPUTATION = 125
