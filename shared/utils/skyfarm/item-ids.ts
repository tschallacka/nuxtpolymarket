/*
 * Item ids for Skyfarm's save files. The game itself only ever uses item keys
 * ('cobblestone'); a save stores each item as its number here, and loading
 * turns it back. An item's id is its place in this list, counting from 1
 * (0 is an empty slot).
 *
 * ADD ONLY: append new items at the end. Never remove, reorder or rename an
 * entry, or every saved island would read its items back as the wrong ones.
 * An item taken out of the game keeps its line. (A test checks that every item
 * in the game has an id here.)
 */
const ITEM_IDS: readonly string[] = [
    'grass', 'dirt', 'stone', 'cobblestone', 'oak_log', 'oak_planks', 'oak_leaves', 'oak_sapling', 'ice', 'obsidian',
    'sand', 'glass', 'farmland', 'sugar_cane', 'cactus', 'melon', 'pumpkin', 'chest', 'sell_chest', 'furnace',
    'crafting_table', 'hopper', 'redstone_torch', 'lever', 'button', 'repeater', 'observer', 'piston', 'sticky_piston', 'dropper',
    'dispenser', 'block_breaker', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'oak_slab', 'cobblestone_slab', 'stone_slab', 'torch',
    'jack_o_lantern', 'glowstone', 'white_wool', 'composter', 'barrel', 'smoker', 'blast_furnace', 'stonecutter', 'smithing_table', 'grindstone',
    'fletching_table', 'cartography_table', 'brewing_stand', 'cauldron', 'lectern', 'loom', 'smooth_stone', 'stone_bricks', 'stone_brick_slab', 'bookshelf',
    'emerald_block', 'store_depot', 'wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'redstone', 'stick', 'bone', 'bone_meal', 'coal',
    'charcoal', 'glowstone_dust', 'iron_ingot', 'gold_ingot', 'diamond', 'wheat', 'bread', 'apple', 'melon_slice', 'leather',
    'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton', 'chicken', 'cooked_chicken', 'feather', 'rotten_flesh',
    'gunpowder', 'string', 'arrow', 'sugar', 'spider_eye', 'glass_bottle', 'bucket', 'water_bucket', 'lava_bucket', 'wooden_pickaxe',
    'wooden_axe', 'wooden_shovel', 'wooden_hoe', 'wooden_sword', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_hoe', 'stone_sword', 'iron_pickaxe',
    'iron_axe', 'iron_shovel', 'iron_hoe', 'iron_sword', 'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe', 'diamond_sword', 'leather_helmet',
    'leather_chestplate', 'leather_leggings', 'leather_boots', 'golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots', 'chainmail_helmet', 'chainmail_chestplate', 'chainmail_leggings',
    'chainmail_boots', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'golden_apple',
    'paper', 'emerald', 'book', 'splash_potion_weakness', 'iron_nugget', 'gold_nugget',
    'poppy', 'dandelion', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'sunflower',
    'lilac', 'rose_bush', 'peony',
    'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool',
    'blue_wool', 'green_wool', 'red_wool', 'black_wool',
    'white_dye', 'orange_dye', 'magenta_dye', 'light_blue_dye', 'yellow_dye', 'lime_dye', 'pink_dye', 'gray_dye', 'light_gray_dye', 'cyan_dye',
    'purple_dye', 'blue_dye', 'green_dye', 'red_dye', 'black_dye', 'ink_sac', 'shears'
]

const BY_KEY = new Map(ITEM_IDS.map((key, i) => [key, i + 1]))

/** The save id of an item key; 0 if it has none (a bug: add it to the list). */
export function itemId(key: string): number {
    return BY_KEY.get(key) ?? 0
}

/** The item key for a save id, or null if no item has it. */
export function itemKey(id: number): string | null {
    return ITEM_IDS[id - 1] ?? null
}

export const ITEM_ID_COUNT = ITEM_IDS.length
