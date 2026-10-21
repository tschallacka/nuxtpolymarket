/*
 * What things are worth on the island, in island coins (not the site's coins:
 * those hook in once the economy is tuned). Sell prices are what the shop
 * pays; buy prices are what it charges, always well above.
 */

/** Price of each more 16x16x16 cube of island: every one costs 1.2x the one before (Q33); the first costs what a second Polytown plot does. */
export const CHUNK_BASE_PRICE = 50_000
export const CHUNK_GROWTH = 1.2

/** What the next chunk costs, given how many you have bought already (the starter chunk is free). */
export function chunkPrice(bought: number) {
    return Math.round(CHUNK_BASE_PRICE * CHUNK_GROWTH ** bought)
}

/** Sale value of one item. */
export const SELL: Record<string, number> = {
    cobblestone: 1,
    stone: 2,
    dirt: 0.5,
    sand: 1,
    glass: 3,
    oak_log: 4,
    oak_planks: 1,
    oak_slab: 0.5,
    cobblestone_slab: 0.5,
    stone_slab: 1,
    oak_sapling: 2,
    coal: 6,
    // Below the log it is burnt from, so smelting logs never makes coins.
    charcoal: 3,
    iron_ore: 15,
    iron_ingot: 20,
    gold_ore: 30,
    gold_ingot: 40,
    diamond: 150,
    obsidian: 25,
    wheat: 3,
    wheat_seeds: 0.5,
    bread: 10,
    apple: 3,
    bone: 2,
    bone_meal: 1,
    sugar_cane: 4,
    cactus: 4,
    melon_slice: 2,
    melon: 18,
    pumpkin: 16,
    redstone: 5,
    // What mobs drop. Cooking meat about doubles it, a little over what the fuel costs.
    leather: 4,
    beef: 2,
    cooked_beef: 4,
    porkchop: 2,
    cooked_porkchop: 4,
    mutton: 2,
    cooked_mutton: 4,
    chicken: 1.5,
    cooked_chicken: 3,
    feather: 1,
    white_wool: 3,
    rotten_flesh: 0.5,
    gunpowder: 6,
    string: 1,
    arrow: 0.5,
    // What witches drop. Below what it costs to make or buy, so crafting and reselling never pays.
    glowstone_dust: 3,
    sugar: 2,
    spider_eye: 2,
    glass_bottle: 0.5,
    // A ninth of an ingot, a little under.
    iron_nugget: 2,
    gold_nugget: 4
}

export interface ShopItem {
    item: string
    price: number
    /** What it is for, one line. */
    hint: string
}

/** What the shop sells, by section. */
export const SHOP: Record<string, ShopItem[]> = {
    Farming: [
        { item: 'wheat_seeds', price: 10, hint: 'Plant on farmland near water' },
        // Above the most one bone meal can grow (a pumpkin sells for 16): bought bone meal can't print coins.
        { item: 'bone_meal', price: 20, hint: 'Grows crops and saplings; sprouts grass and flowers' },
        { item: 'sugar_cane', price: 40, hint: 'Grows three tall beside water' },
        { item: 'cactus', price: 40, hint: 'Grows three tall on sand' },
        { item: 'melon_seeds', price: 80, hint: 'The stem grows melons beside it' },
        { item: 'pumpkin_seeds', price: 80, hint: 'The stem grows pumpkins beside it' },
        { item: 'oak_sapling', price: 15, hint: 'Grows into a tree' },
        // Nothing grows tall flowers: the shop sells them, and bone meal on one drops another.
        { item: 'sunflower', price: 100, hint: 'Two blocks tall; bone meal on it drops another' },
        { item: 'lilac', price: 100, hint: 'Two blocks tall; bone meal on it drops another' },
        { item: 'rose_bush', price: 100, hint: 'Two blocks tall; bone meal on it drops another' },
        { item: 'peony', price: 100, hint: 'Two blocks tall; bone meal on it drops another' },
        { item: 'sand', price: 8, hint: 'For cactus and glass' },
        { item: 'dirt', price: 5, hint: 'More ground to build on' }
    ],
    Storage: [
        { item: 'chest', price: 30, hint: 'Holds 27 stacks' },
        { item: 'hopper', price: 120, hint: 'Pulls items from above and passes them where its spout points' },
        { item: 'store_depot', price: 800, hint: 'Sends what goes in to your store, to sell or spend later' }
    ],
    Redstone: [
        { item: 'redstone', price: 20, hint: 'Carries a signal' },
        { item: 'redstone_torch', price: 30, hint: 'Powers what is around it; turns off when powered' },
        { item: 'lever', price: 20, hint: 'On and off' },
        { item: 'button', price: 15, hint: 'A short pulse' },
        { item: 'repeater', price: 60, hint: 'Delays and strengthens a signal' },
        { item: 'observer', price: 150, hint: 'Pulses when the block it watches changes' },
        { item: 'piston', price: 120, hint: 'Pushes blocks' },
        { item: 'sticky_piston', price: 200, hint: 'Pushes and pulls blocks' },
        { item: 'dropper', price: 90, hint: 'Drops an item when powered' },
        { item: 'dispenser', price: 120, hint: 'Uses an item when powered' },
        { item: 'block_breaker', price: 400, hint: 'Mines the block in front when powered' }
    ],
    // Workstations a skyblock can't craft: no gravel for flint, no Nether for a blaze rod.
    Workstations: [
        { item: 'fletching_table', price: 60, hint: 'A fletcher\'s workstation' },
        { item: 'brewing_stand', price: 250, hint: 'A cleric\'s workstation' }
    ],
    // A skyblock has no Nether, so no blaze powder to brew with: the shop sells it.
    Potions: [
        { item: 'splash_potion_weakness', price: 150, hint: 'Throw at a zombie villager, then give it a golden apple to cure it' }
    ],
    Light: [
        { item: 'glowstone_dust', price: 15, hint: 'Four make a glowstone block, the brightest light' }
    ],
    Tools: [
        { item: 'stone_pickaxe', price: 40, hint: 'Mines stone faster' },
        { item: 'iron_pickaxe', price: 400, hint: 'Mines everything faster' },
        { item: 'diamond_pickaxe', price: 3000, hint: 'The fastest' },
        { item: 'iron_axe', price: 300, hint: 'Chops faster' },
        { item: 'water_bucket', price: 200, hint: 'A water source' },
        { item: 'lava_bucket', price: 400, hint: 'For a second cobblestone generator' }
    ]
}

/** Generator upgrades: the chance a generated block is an ore instead of cobblestone, per level. */
export const ORE_LEVELS = [
    { price: 0, coal: 0, iron: 0, gold: 0, diamond: 0 },
    { price: 1000, coal: 0.08, iron: 0, gold: 0, diamond: 0 },
    { price: 4000, coal: 0.1, iron: 0.04, gold: 0, diamond: 0 },
    { price: 15000, coal: 0.1, iron: 0.06, gold: 0.025, diamond: 0 },
    { price: 60000, coal: 0.12, iron: 0.08, gold: 0.04, diamond: 0.008 }
]

export function sellValue(item: string, count = 1) {
    return (SELL[item] ?? 0) * count
}
