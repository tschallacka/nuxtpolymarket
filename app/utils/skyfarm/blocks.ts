import { DYE_COLORS } from './dyes'

/*
 * Every block in Skyfarm. Ids are bytes stored in the world's chunk arrays,
 * so they are append-only: never renumber one, or every saved island
 * changes under its owner. Per-block state (fluid level, facing, power,
 * growth) lives in the parallel meta byte, see world.ts.
 */

export const enum B {
    Air = 0,
    Grass = 1,
    Dirt = 2,
    Stone = 3,
    Cobblestone = 4,
    OakLog = 5,
    OakPlanks = 6,
    OakLeaves = 7,
    OakSapling = 8,
    Water = 9,
    Lava = 10,
    Ice = 11,
    Obsidian = 12,
    Sand = 13,
    Glass = 14,
    Farmland = 15,
    Wheat = 16,
    SugarCane = 17,
    Cactus = 18,
    MelonStem = 19,
    Melon = 20,
    PumpkinStem = 21,
    Pumpkin = 22,
    Chest = 23,
    SellChest = 24,
    Furnace = 25,
    CraftingTable = 26,
    Hopper = 27,
    RedstoneDust = 28,
    RedstoneTorch = 29,
    Lever = 30,
    Button = 31,
    Repeater = 32,
    Observer = 33,
    Piston = 34,
    StickyPiston = 35,
    PistonHead = 36,
    Dropper = 37,
    Dispenser = 38,
    BlockBreaker = 39,
    CoalOre = 40,
    IronOre = 41,
    GoldOre = 42,
    DiamondOre = 43,
    Bedrock = 44,
    OakSlab = 45,
    CobblestoneSlab = 46,
    StoneSlab = 47,
    Fire = 48,
    TallGrass = 49,
    Torch = 50,
    JackOLantern = 51,
    Glowstone = 52,
    WhiteWool = 53,
    // Villagers' workstations (and what their recipes need).
    Composter = 54,
    Barrel = 55,
    Smoker = 56,
    BlastFurnace = 57,
    Stonecutter = 58,
    SmithingTable = 59,
    Grindstone = 60,
    FletchingTable = 61,
    CartographyTable = 62,
    BrewingStand = 63,
    Cauldron = 64,
    Lectern = 65,
    Loom = 66,
    SmoothStone = 67,
    StoneBricks = 68,
    StoneBrickSlab = 69,
    Bookshelf = 70,
    EmeraldBlock = 71,
    /** Sends whatever goes into it (by hand, hopper or dropper) to the shop's store. */
    Depot = 72,
    // Flowers: bone meal on grass sprouts the small ones now and then.
    Dandelion = 73,
    Poppy = 74,
    AzureBluet = 75,
    OxeyeDaisy = 76,
    Cornflower = 77,
    RedTulip = 78,
    OrangeTulip = 79,
    WhiteTulip = 80,
    PinkTulip = 81,
    // Two blocks tall (meta bit 0 marks the upper half): bone meal on short grass grows tall grass.
    DoubleTallGrass = 82,
    Sunflower = 83,
    Lilac = 84,
    RoseBush = 85,
    Peony = 86,
    // Dyed wool (white is WhiteWool), in DYE_COLORS order.
    OrangeWool = 87,
    MagentaWool = 88,
    LightBlueWool = 89,
    YellowWool = 90,
    LimeWool = 91,
    PinkWool = 92,
    GrayWool = 93,
    LightGrayWool = 94,
    CyanWool = 95,
    PurpleWool = 96,
    BlueWool = 97,
    GreenWool = 98,
    RedWool = 99,
    BlackWool = 100
}

export type Tool = 'hand' | 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword'

/** How a block is drawn: a full cube, a crossed plant, a flat sheet on the floor, a slab, or a special shape. */
export type Shape = 'cube' | 'cross' | 'flat' | 'fluid' | 'none' | 'slab' | 'special'

export interface BlockDef {
    id: B
    key: string
    name: string
    shape: Shape
    /** Blocks movement and fluids, and occludes neighbouring faces. */
    solid: boolean
    /** Light and faces behind it show through (glass, leaves, plants). */
    transparent: boolean
    /** Seconds to break with the right tool at hand tier; 0 is instant, Infinity never. */
    hardness: number
    tool: Tool
    /** Faces: top, side, bottom, as 0xRRGGBB; the atlas paints them with noise and edges. */
    colors: [number, number, number]
    /** Item dropped when broken (an item key); null drops nothing. */
    drop: string | null
    /** Pushable by pistons. */
    pushable: boolean
}

const titleCase = (key: string) => key.split('_').map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')

const D = (id: B, key: string, name: string, shape: Shape, solid: boolean, transparent: boolean, hardness: number, tool: Tool,
    colors: [number, number, number], drop: string | null = key, pushable = true): BlockDef =>
    ({ id, key, name, shape, solid, transparent, hardness, tool, colors, drop, pushable })

export const BLOCKS: BlockDef[] = [
    D(B.Air, 'air', 'Air', 'none', false, true, 0, 'hand', [0, 0, 0], null),
    D(B.Grass, 'grass', 'Grass Block', 'cube', true, false, 0.6, 'shovel', [0x5e9c3a, 0x7a6143, 0x7a5a3c], 'dirt'),
    D(B.Dirt, 'dirt', 'Dirt', 'cube', true, false, 0.5, 'shovel', [0x7a5a3c, 0x7a5a3c, 0x7a5a3c]),
    D(B.Stone, 'stone', 'Stone', 'cube', true, false, 1.5, 'pickaxe', [0x7f7f7f, 0x7f7f7f, 0x7f7f7f], 'cobblestone'),
    D(B.Cobblestone, 'cobblestone', 'Cobblestone', 'cube', true, false, 2, 'pickaxe', [0x6e6e6e, 0x6e6e6e, 0x6e6e6e]),
    D(B.OakLog, 'oak_log', 'Oak Log', 'cube', true, false, 2, 'axe', [0xa1834f, 0x6b5232, 0xa1834f]),
    D(B.OakPlanks, 'oak_planks', 'Oak Planks', 'cube', true, false, 2, 'axe', [0xb08d57, 0xb08d57, 0xb08d57]),
    D(B.OakLeaves, 'oak_leaves', 'Oak Leaves', 'cube', true, true, 0.2, 'hand', [0x3f7a2a, 0x3f7a2a, 0x3f7a2a], 'oak_sapling'),
    D(B.OakSapling, 'oak_sapling', 'Oak Sapling', 'cross', false, true, 0, 'hand', [0x4f8a32, 0x4f8a32, 0x4f8a32], 'oak_sapling', false),
    D(B.Water, 'water', 'Water', 'fluid', false, true, Infinity, 'hand', [0x2f5fd0, 0x2f5fd0, 0x2f5fd0], null, false),
    D(B.Lava, 'lava', 'Lava', 'fluid', false, false, Infinity, 'hand', [0xe25a14, 0xe25a14, 0xe25a14], null, false),
    D(B.Ice, 'ice', 'Ice', 'cube', true, true, 0.5, 'pickaxe', [0x9cc3f5, 0x9cc3f5, 0x9cc3f5], null),
    D(B.Obsidian, 'obsidian', 'Obsidian', 'cube', true, false, 15, 'pickaxe', [0x1c1428, 0x1c1428, 0x1c1428], 'obsidian', false),
    D(B.Sand, 'sand', 'Sand', 'cube', true, false, 0.5, 'shovel', [0xdbcf9a, 0xdbcf9a, 0xdbcf9a]),
    D(B.Glass, 'glass', 'Glass', 'cube', true, true, 0.3, 'hand', [0xcfe8f0, 0xcfe8f0, 0xcfe8f0]),
    D(B.Farmland, 'farmland', 'Farmland', 'cube', true, false, 0.6, 'shovel', [0x5a3e26, 0x6e4f33, 0x6e4f33], 'dirt'),
    D(B.Wheat, 'wheat', 'Wheat', 'cross', false, true, 0, 'hand', [0xc9b03c, 0xc9b03c, 0xc9b03c], 'wheat', false),
    D(B.SugarCane, 'sugar_cane', 'Sugar Cane', 'cross', false, true, 0, 'hand', [0x8fc45a, 0x8fc45a, 0x8fc45a], 'sugar_cane', false),
    D(B.Cactus, 'cactus', 'Cactus', 'special', true, false, 0.4, 'hand', [0x5c8f2e, 0x4a7d24, 0x5c8f2e], 'cactus', false),
    D(B.MelonStem, 'melon_stem', 'Melon Stem', 'cross', false, true, 0, 'hand', [0x8db04a, 0x8db04a, 0x8db04a], 'melon_seeds', false),
    D(B.Melon, 'melon', 'Melon', 'cube', true, false, 1, 'axe', [0x9fb53a, 0x6d9a2c, 0x9fb53a], 'melon_slice'),
    D(B.PumpkinStem, 'pumpkin_stem', 'Pumpkin Stem', 'cross', false, true, 0, 'hand', [0x8db04a, 0x8db04a, 0x8db04a], 'pumpkin_seeds', false),
    D(B.Pumpkin, 'pumpkin', 'Pumpkin', 'cube', true, false, 1, 'axe', [0xc77b1c, 0xd98a22, 0xc77b1c]),
    D(B.Chest, 'chest', 'Chest', 'special', true, true, 2.5, 'axe', [0x9a6b30, 0x8a5e28, 0x9a6b30], 'chest', false),
    D(B.SellChest, 'sell_chest', 'Sell Chest', 'special', true, true, 2.5, 'axe', [0xc9a227, 0xb08a1c, 0xc9a227], 'sell_chest', false),
    D(B.Furnace, 'furnace', 'Furnace', 'cube', true, false, 3.5, 'pickaxe', [0x6a6a6a, 0x5c5c5c, 0x6a6a6a], 'furnace', false),
    D(B.CraftingTable, 'crafting_table', 'Crafting Table', 'cube', true, false, 2.5, 'axe', [0x9c6d3c, 0x8b5d32, 0xb08d57]),
    D(B.Hopper, 'hopper', 'Hopper', 'special', true, true, 3, 'pickaxe', [0x48484c, 0x3c3c40, 0x48484c], 'hopper', false),
    D(B.RedstoneDust, 'redstone_dust', 'Redstone Dust', 'flat', false, true, 0, 'hand', [0x8a0d0d, 0x8a0d0d, 0x8a0d0d], 'redstone', false),
    D(B.RedstoneTorch, 'redstone_torch', 'Redstone Torch', 'special', false, true, 0, 'hand', [0xd41e1e, 0x6b4a2a, 0x6b4a2a], 'redstone_torch', false),
    D(B.Lever, 'lever', 'Lever', 'special', false, true, 0.5, 'hand', [0x7a7a7a, 0x6b4a2a, 0x7a7a7a], 'lever', false),
    D(B.Button, 'button', 'Button', 'special', false, true, 0.5, 'hand', [0x8a8a8a, 0x8a8a8a, 0x8a8a8a], 'button', false),
    D(B.Repeater, 'repeater', 'Repeater', 'special', false, true, 0, 'hand', [0xa8a8a8, 0x8a8a8a, 0xa8a8a8], 'repeater', false),
    D(B.Observer, 'observer', 'Observer', 'cube', true, false, 3, 'pickaxe', [0x545454, 0x4a4a4a, 0x545454], 'observer'),
    D(B.Piston, 'piston', 'Piston', 'special', true, false, 1.5, 'pickaxe', [0xb08d57, 0x7a7a7a, 0x7a7a7a], 'piston'),
    D(B.StickyPiston, 'sticky_piston', 'Sticky Piston', 'special', true, false, 1.5, 'pickaxe', [0x7fb04a, 0x7a7a7a, 0x7a7a7a], 'sticky_piston'),
    D(B.PistonHead, 'piston_head', 'Piston Head', 'special', true, true, 1.5, 'pickaxe', [0xb08d57, 0xb08d57, 0xb08d57], null, false),
    D(B.Dropper, 'dropper', 'Dropper', 'cube', true, false, 3.5, 'pickaxe', [0x6a6a6a, 0x5c5c5c, 0x6a6a6a], 'dropper'),
    D(B.Dispenser, 'dispenser', 'Dispenser', 'cube', true, false, 3.5, 'pickaxe', [0x6a6a6a, 0x5c5c5c, 0x6a6a6a], 'dispenser'),
    D(B.BlockBreaker, 'block_breaker', 'Block Breaker', 'cube', true, false, 3.5, 'pickaxe', [0x5a4a6a, 0x4a3c5a, 0x5a4a6a], 'block_breaker'),
    D(B.CoalOre, 'coal_ore', 'Coal Ore', 'cube', true, false, 3, 'pickaxe', [0x6e6e6e, 0x6e6e6e, 0x6e6e6e], 'coal'),
    D(B.IronOre, 'iron_ore', 'Iron Ore', 'cube', true, false, 3, 'pickaxe', [0x8a7a6e, 0x8a7a6e, 0x8a7a6e], 'iron_ore'),
    D(B.GoldOre, 'gold_ore', 'Gold Ore', 'cube', true, false, 3, 'pickaxe', [0x8f8566, 0x8f8566, 0x8f8566], 'gold_ore'),
    D(B.DiamondOre, 'diamond_ore', 'Diamond Ore', 'cube', true, false, 3, 'pickaxe', [0x6e8a8a, 0x6e8a8a, 0x6e8a8a], 'diamond'),
    D(B.Bedrock, 'bedrock', 'Bedrock', 'cube', true, false, Infinity, 'pickaxe', [0x2e2e2e, 0x2e2e2e, 0x2e2e2e], null, false),
    // Slabs: meta (low two bits) 0 is the bottom half, 1 the top half, 2 both (a double slab).
    D(B.OakSlab, 'oak_slab', 'Oak Slab', 'slab', true, false, 2, 'axe', [0xb08d57, 0xb08d57, 0xb08d57]),
    D(B.CobblestoneSlab, 'cobblestone_slab', 'Cobblestone Slab', 'slab', true, false, 2, 'pickaxe', [0x6e6e6e, 0x6e6e6e, 0x6e6e6e]),
    D(B.StoneSlab, 'stone_slab', 'Stone Slab', 'slab', true, false, 2, 'pickaxe', [0x7f7f7f, 0x7f7f7f, 0x7f7f7f]),
    // Fire: meta (low four bits) is its age, 0 to 15. A punch puts it out.
    D(B.Fire, 'fire', 'Fire', 'cross', false, true, 0, 'hand', [0xff8a1c, 0xff8a1c, 0xff8a1c], null, false),
    // Grows from bone meal on grass; breaking it now and then gives wheat seeds (see Island.breakBlock).
    D(B.TallGrass, 'short_grass', 'Short Grass', 'cross', false, true, 0, 'hand', [0x6fa042, 0x6fa042, 0x6fa042], null, false),
    // A torch: meta 0 stands on the floor, 1 to 4 hangs on a wall (see TORCH_WALL).
    D(B.Torch, 'torch', 'Torch', 'special', false, true, 0, 'hand', [0xffd27a, 0x8a6a3c, 0x8a6a3c], 'torch', false),
    // Facing (bits 0-1) as for the furnace: 0 north, 1 east, 2 south, 3 west.
    D(B.JackOLantern, 'jack_o_lantern', 'Jack o\'Lantern', 'cube', true, false, 1, 'axe', [0xc77b1c, 0xd98a22, 0xc77b1c]),
    D(B.Glowstone, 'glowstone', 'Glowstone', 'cube', true, false, 0.3, 'hand', [0xf2d27a, 0xf2d27a, 0xf2d27a]),
    D(B.WhiteWool, 'white_wool', 'White Wool', 'cube', true, false, 0.8, 'hand', [0xeaeaea, 0xeaeaea, 0xeaeaea]),
    // Composter: meta 0 to 7 is how full it is, 8 is bone meal ready to take.
    D(B.Composter, 'composter', 'Composter', 'special', true, true, 0.6, 'axe', [0x8a6a3c, 0x7a5a30, 0x8a6a3c], 'composter', false),
    D(B.Barrel, 'barrel', 'Barrel', 'cube', true, false, 2.5, 'axe', [0x8a6a3c, 0x7a5a30, 0x8a6a3c], 'barrel', false),
    // Smoker and blast furnace: a furnace's meta (facing, bit 3 lit), twice as fast at their own trade.
    D(B.Smoker, 'smoker', 'Smoker', 'cube', true, false, 3.5, 'pickaxe', [0x5a4a3a, 0x4a3a2a, 0x5a4a3a], 'smoker', false),
    D(B.BlastFurnace, 'blast_furnace', 'Blast Furnace', 'cube', true, false, 3.5, 'pickaxe', [0x5a5a60, 0x4a4a50, 0x5a5a60], 'blast_furnace', false),
    D(B.Stonecutter, 'stonecutter', 'Stonecutter', 'special', true, true, 3.5, 'pickaxe', [0x7f7f7f, 0x6e6e6e, 0x7f7f7f]),
    D(B.SmithingTable, 'smithing_table', 'Smithing Table', 'cube', true, false, 2.5, 'axe', [0x3a3a40, 0x5a4a3a, 0x3a3a40]),
    D(B.Grindstone, 'grindstone', 'Grindstone', 'special', true, true, 2, 'pickaxe', [0x8a8a8a, 0x6a5a40, 0x8a8a8a]),
    D(B.FletchingTable, 'fletching_table', 'Fletching Table', 'cube', true, false, 2.5, 'axe', [0xd8c890, 0xb09060, 0xd8c890]),
    D(B.CartographyTable, 'cartography_table', 'Cartography Table', 'cube', true, false, 2.5, 'axe', [0x6a5040, 0x4a3828, 0x6a5040]),
    D(B.BrewingStand, 'brewing_stand', 'Brewing Stand', 'special', false, true, 0.5, 'pickaxe', [0x6a6a6a, 0xd8c04a, 0x6a6a6a]),
    // Cauldron: meta 0 to 3 is how much water it holds.
    D(B.Cauldron, 'cauldron', 'Cauldron', 'special', true, true, 2, 'pickaxe', [0x3a3a3a, 0x4a4a4a, 0x3a3a3a]),
    D(B.Lectern, 'lectern', 'Lectern', 'special', true, true, 2.5, 'axe', [0xa07a48, 0x8a6a3c, 0xa07a48]),
    D(B.Loom, 'loom', 'Loom', 'cube', true, false, 2.5, 'axe', [0xc8b080, 0xa08a60, 0xc8b080]),
    D(B.SmoothStone, 'smooth_stone', 'Smooth Stone', 'cube', true, false, 2, 'pickaxe', [0x9a9a9a, 0x9a9a9a, 0x9a9a9a]),
    D(B.StoneBricks, 'stone_bricks', 'Stone Bricks', 'cube', true, false, 1.5, 'pickaxe', [0x7a7a7a, 0x7a7a7a, 0x7a7a7a]),
    D(B.StoneBrickSlab, 'stone_brick_slab', 'Stone Brick Slab', 'slab', true, false, 2, 'pickaxe', [0x7a7a7a, 0x7a7a7a, 0x7a7a7a]),
    D(B.Bookshelf, 'bookshelf', 'Bookshelf', 'cube', true, false, 1.5, 'axe', [0xb08d57, 0x6a4a2a, 0xb08d57], 'bookshelf'),
    D(B.EmeraldBlock, 'emerald_block', 'Block of Emerald', 'cube', true, false, 5, 'pickaxe', [0x2ad25a, 0x2ad25a, 0x2ad25a]),
    D(B.Depot, 'store_depot', 'Store Depot', 'cube', true, false, 3.5, 'pickaxe', [0x6a6a70, 0x5a5a60, 0x6a6a70], 'store_depot', false),
    D(B.Dandelion, 'dandelion', 'Dandelion', 'cross', false, true, 0, 'hand', [0xf5d81c, 0xf5d81c, 0xf5d81c], 'dandelion', false),
    D(B.Poppy, 'poppy', 'Poppy', 'cross', false, true, 0, 'hand', [0xd8282a, 0xd8282a, 0xd8282a], 'poppy', false),
    D(B.AzureBluet, 'azure_bluet', 'Azure Bluet', 'cross', false, true, 0, 'hand', [0xe0e8f0, 0xe0e8f0, 0xe0e8f0], 'azure_bluet', false),
    D(B.OxeyeDaisy, 'oxeye_daisy', 'Oxeye Daisy', 'cross', false, true, 0, 'hand', [0xf0f0e0, 0xf0f0e0, 0xf0f0e0], 'oxeye_daisy', false),
    D(B.Cornflower, 'cornflower', 'Cornflower', 'cross', false, true, 0, 'hand', [0x4a6ad8, 0x4a6ad8, 0x4a6ad8], 'cornflower', false),
    D(B.RedTulip, 'red_tulip', 'Red Tulip', 'cross', false, true, 0, 'hand', [0xd83a2a, 0xd83a2a, 0xd83a2a], 'red_tulip', false),
    D(B.OrangeTulip, 'orange_tulip', 'Orange Tulip', 'cross', false, true, 0, 'hand', [0xe88a2a, 0xe88a2a, 0xe88a2a], 'orange_tulip', false),
    D(B.WhiteTulip, 'white_tulip', 'White Tulip', 'cross', false, true, 0, 'hand', [0xf0f0f0, 0xf0f0f0, 0xf0f0f0], 'white_tulip', false),
    D(B.PinkTulip, 'pink_tulip', 'Pink Tulip', 'cross', false, true, 0, 'hand', [0xf0a0c0, 0xf0a0c0, 0xf0a0c0], 'pink_tulip', false),
    // Like short grass it is no item (Minecraft wants shears); breaking it now and then gives a seed.
    D(B.DoubleTallGrass, 'tall_grass', 'Tall Grass', 'cross', false, true, 0, 'hand', [0x6fa042, 0x6fa042, 0x6fa042], null, false),
    D(B.Sunflower, 'sunflower', 'Sunflower', 'cross', false, true, 0, 'hand', [0xf5c81c, 0xf5c81c, 0xf5c81c], 'sunflower', false),
    D(B.Lilac, 'lilac', 'Lilac', 'cross', false, true, 0, 'hand', [0xc8a0d8, 0xc8a0d8, 0xc8a0d8], 'lilac', false),
    D(B.RoseBush, 'rose_bush', 'Rose Bush', 'cross', false, true, 0, 'hand', [0xc82a3a, 0xc82a3a, 0xc82a3a], 'rose_bush', false),
    D(B.Peony, 'peony', 'Peony', 'cross', false, true, 0, 'hand', [0xe8b0d0, 0xe8b0d0, 0xe8b0d0], 'peony', false),
    ...DYE_COLORS.slice(1).map(([color, rgb], i) => D(B.OrangeWool + i, `${color}_wool`, `${titleCase(color)} Wool`, 'cube', true, false, 0.8, 'hand', [rgb, rgb, rgb]))
]

/** Every wool block, white first, in DYE_COLORS order. */
export const WOOL = [B.WhiteWool, ...DYE_COLORS.slice(1).map((_, i) => B.OrangeWool + i)]

/** The small flowers. */
export const FLOWERS = [B.Dandelion, B.Poppy, B.AzureBluet, B.OxeyeDaisy, B.Cornflower, B.RedTulip, B.OrangeTulip, B.WhiteTulip, B.PinkTulip]
/**
 * What bone meal on grass sprouts as a flower, weighted the way plains
 * mostly grow them: dandelions and poppies twice as often as the rest.
 */
export const GRASS_FLOWERS: [B, number][] = [[B.Dandelion, 2], [B.Poppy, 2], [B.AzureBluet, 1], [B.OxeyeDaisy, 1], [B.Cornflower, 1],
    [B.RedTulip, 1], [B.OrangeTulip, 1], [B.WhiteTulip, 1], [B.PinkTulip, 1]]
/** Tall flowers: bone meal on one drops another of it (Minecraft's TallFlowerBlock). */
export const TALL_FLOWERS = new Set<number>([B.Sunflower, B.Lilac, B.RoseBush, B.Peony])
/** Plants two blocks tall: the lower half stands on the ground, the upper (meta bit UPPER) on the lower. */
export const DOUBLE_PLANTS = new Set<number>([B.DoubleTallGrass, ...TALL_FLOWERS])
export const UPPER = 1

/** Ground a flower or grass can grow on. */
export const plantGround = (id: number) => id === B.Grass || id === B.Dirt || id === B.Farmland

/**
 * The workstation each villager profession works at (Minecraft's job sites):
 * a villager without a job claims a free one nearby and takes up its trade.
 */
export const WORKSTATIONS: Partial<Record<number, string>> = {
    [B.Composter]: 'farmer',
    [B.Barrel]: 'fisherman',
    [B.Smoker]: 'butcher',
    [B.BlastFurnace]: 'armorer',
    [B.Stonecutter]: 'mason',
    [B.SmithingTable]: 'toolsmith',
    [B.Grindstone]: 'weaponsmith',
    [B.FletchingTable]: 'fletcher',
    [B.CartographyTable]: 'cartographer',
    [B.BrewingStand]: 'cleric',
    [B.Cauldron]: 'leatherworker',
    [B.Lectern]: 'librarian',
    [B.Loom]: 'shepherd'
}

/** The furnace and its two quicker kin: they smelt (and keep their slots and fire) the same way. */
export const FURNACES = new Set<number>([B.Furnace, B.Smoker, B.BlastFurnace])

/**
 * How well a block stands up to an explosion (Minecraft's blast resistance):
 * a blast loses (resistance + 0.3) * 0.3 of its strength going through it.
 */
export function blastResistance(id: number): number {
    switch (id) {
        case B.Air:
        case B.Fire: return 0
        case B.Water:
        case B.Lava: return 100
        case B.Obsidian: return 1200
        case B.Bedrock: return 3_600_000
        case B.Stone:
        case B.Cobblestone:
        case B.CobblestoneSlab:
        case B.StoneSlab:
        case B.Piston:
        case B.StickyPiston:
        case B.PistonHead: return 6
        case B.Hopper: return 4.8
        case B.SmoothStone:
        case B.StoneBricks:
        case B.StoneBrickSlab:
        case B.Grindstone: return 6
        case B.SmithingTable:
        case B.Lectern:
        case B.Loom:
        case B.FletchingTable:
        case B.CartographyTable:
        case B.Barrel: return 2.5
        case B.Cauldron: return 2
        case B.Smoker:
        case B.BlastFurnace:
        case B.Stonecutter: return 3.5
        case B.Bookshelf: return 1.5
        case B.Composter: return 0.6
        case B.BrewingStand: return 0.5
        case B.Furnace:
        case B.Dropper:
        case B.Dispenser:
        case B.BlockBreaker:
        case B.Observer: return 3.5
        case B.CoalOre:
        case B.IronOre:
        case B.GoldOre:
        case B.DiamondOre: return 3
        case B.OakLog:
        case B.OakPlanks:
        case B.OakSlab: return 3
        case B.Chest:
        case B.SellChest:
        case B.CraftingTable: return 2.5
        case B.Melon:
        case B.Pumpkin:
        case B.JackOLantern: return 1
        case B.WhiteWool: return 0.8
        case B.OrangeWool:
        case B.MagentaWool:
        case B.LightBlueWool:
        case B.YellowWool:
        case B.LimeWool:
        case B.PinkWool:
        case B.GrayWool:
        case B.LightGrayWool:
        case B.CyanWool:
        case B.PurpleWool:
        case B.BlueWool:
        case B.GreenWool:
        case B.RedWool:
        case B.BlackWool: return 0.8
        case B.Grass:
        case B.Farmland: return 0.6
        case B.Dirt:
        case B.Sand:
        case B.Ice: return 0.5
        case B.Cactus: return 0.4
        case B.Glass:
        case B.Glowstone: return 0.3
        case B.OakLeaves: return 0.2
        default: return 0
    }
}

/**
 * Whether a mob can spawn standing on this block: the full, solid top of an
 * opaque block or of an upper or double slab. Not glass, leaves, ice, a
 * lower slab, or bedrock (which Minecraft rules out by name).
 */
export function spawnableOn(id: number, meta: number) {
    if (id === B.Bedrock) return false
    if (isSlab(id)) return (meta & 3) !== SLAB_BOTTOM
    return occludes(id)
}

/** A wall torch's meta: 1 to 4, the way it leans out (east, south, west, north); the wall is behind it. */
export const TORCH_WALL: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]]

/**
 * Whether a plant can stand at (x, y, z) given what is under it (and beside
 * it, for sugar cane). Plants without support pop off as items.
 */
export function plantSupported(id: number, get: (x: number, y: number, z: number) => number, x: number, y: number, z: number, meta = 0) {
    const below = get(x, y - 1, z)
    switch (id) {
        // A torch needs a solid block under it, or behind it on a wall.
        case B.Torch:
        case B.RedstoneTorch: {
            const wall = meta & 7
            if (!wall) return block(below).solid
            const [dx, dz] = TORCH_WALL[(wall - 1) & 3]!
            return block(get(x - dx, y, z - dz)).solid
        }
        // Dust and repeaters need a floor.
        case B.RedstoneDust:
        case B.Repeater: return block(below).solid
        // A lever or button needs the block it is on: floor, wall, or ceiling.
        case B.Lever:
        case B.Button: {
            const face = meta & 7
            if (face === 0) return block(below).solid
            if (face === 5) return block(get(x, y + 1, z)).solid
            const [dx, dz] = TORCH_WALL[(face - 1) & 3]!
            return block(get(x - dx, y, z - dz)).solid
        }
        case B.OakSapling:
        case B.TallGrass:
        case B.Dandelion:
        case B.Poppy:
        case B.AzureBluet:
        case B.OxeyeDaisy:
        case B.Cornflower:
        case B.RedTulip:
        case B.OrangeTulip:
        case B.WhiteTulip:
        case B.PinkTulip: return plantGround(below)
        // Two blocks tall: the lower half needs ground and its upper half, the upper half its lower one.
        case B.DoubleTallGrass:
        case B.Sunflower:
        case B.Lilac:
        case B.RoseBush:
        case B.Peony: return meta & UPPER ? below === id : plantGround(below) && get(x, y + 1, z) === id
        case B.Wheat:
        case B.MelonStem:
        case B.PumpkinStem: return below === B.Farmland
        case B.SugarCane: {
            if (below === B.SugarCane) return true
            if (below !== B.Grass && below !== B.Dirt && below !== B.Sand) return false
            // Minecraft: the bottom of a cane needs water right beside its ground.
            return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => get(x + dx!, y - 1, z + dz!) === B.Water)
        }
        case B.Cactus: return below === B.Cactus || below === B.Sand
        default: return true
    }
}

/** Plants that need the block under them (and pop off without it). */
export const PLANTS = new Set<number>([B.OakSapling, B.TallGrass, B.Wheat, B.MelonStem, B.PumpkinStem, B.SugarCane, B.Cactus, B.Torch,
    B.RedstoneTorch, B.RedstoneDust, B.Repeater, B.Lever, B.Button, ...FLOWERS, ...DOUBLE_PLANTS])

/** Blocks that face a way (meta bits 0-1: north, east, south, west), set from where the player stands. */
export const FACING = new Set<number>([B.Furnace, B.JackOLantern, B.Smoker, B.BlastFurnace, B.Stonecutter, B.Grindstone, B.Lectern, B.Loom])

/** A furnace's meta bit for burning. */
export const FURNACE_LIT = 8

/**
 * The facing (0 north, 1 east, 2 south, 3 west) that turns a block's front
 * towards a player looking along `yaw` (0 looks north, towards -z).
 */
export function facingToward(yaw: number) {
    const dx = Math.sin(yaw), dz = Math.cos(yaw)
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3
    return dz > 0 ? 2 : 0
}

/**
 * How readily a block catches fire, Minecraft's numbers: `catches` is how
 * eagerly fire spreads into the air next to it, `burns` how quickly it burns
 * away once alight. Blocks not listed never burn.
 */
export const FLAMMABLE: Partial<Record<number, { catches: number, burns: number }>> = {
    [B.OakPlanks]: { catches: 5, burns: 20 },
    [B.OakSlab]: { catches: 5, burns: 20 },
    [B.CraftingTable]: { catches: 5, burns: 20 },
    [B.OakLog]: { catches: 5, burns: 5 },
    [B.OakLeaves]: { catches: 30, burns: 60 },
    ...Object.fromEntries(WOOL.map(id => [id, { catches: 30, burns: 60 }])),
    [B.Bookshelf]: { catches: 30, burns: 20 },
    [B.Composter]: { catches: 5, burns: 20 },
    [B.Lectern]: { catches: 30, burns: 20 },
    [B.Barrel]: { catches: 5, burns: 20 },
    [B.FletchingTable]: { catches: 5, burns: 20 },
    [B.CartographyTable]: { catches: 5, burns: 20 },
    [B.SmithingTable]: { catches: 5, burns: 20 },
    [B.Loom]: { catches: 5, burns: 20 },
    [B.OakSapling]: { catches: 60, burns: 100 },
    [B.Wheat]: { catches: 60, burns: 100 },
    [B.SugarCane]: { catches: 60, burns: 100 },
    [B.TallGrass]: { catches: 60, burns: 100 },
    ...Object.fromEntries([...FLOWERS, ...DOUBLE_PLANTS].map(id => [id, { catches: 60, burns: 100 }]))
}

const BY_ID: BlockDef[] = []
for (const b of BLOCKS) BY_ID[b.id] = b
const BY_KEY = new Map(BLOCKS.map(b => [b.key, b]))

export function block(id: number): BlockDef {
    return BY_ID[id] ?? BY_ID[B.Air]!
}

export function blockByKey(key: string): BlockDef | undefined {
    return BY_KEY.get(key)
}

/** Solid opaque cubes hide the faces of their neighbours. */
export function occludes(id: number) {
    const b = block(id)
    return b.shape === 'cube' && !b.transparent
}

export function isSlab(id: number) {
    return block(id).shape === 'slab'
}

/** Slab halves, in the slab's meta byte. */
export const SLAB_BOTTOM = 0
export const SLAB_TOP = 1
export const SLAB_DOUBLE = 2

/** The block's solid part in its cell, as a vertical range [y0, y1] (0..1), or null if nothing is solid. */
export function solidRange(id: number, meta: number): [number, number] | null {
    const b = block(id)
    if (!b.solid) return null
    if (b.shape !== 'slab') return [0, 1]
    const half = meta & 3
    return half === SLAB_BOTTOM ? [0, 0.5] : half === SLAB_TOP ? [0.5, 1] : [0, 1]
}

/** Whether a block hides the faces next to it, given its meta (a double slab does; a half slab doesn't). */
export function occludesWith(id: number, meta: number) {
    return isSlab(id) ? (meta & 3) === SLAB_DOUBLE : occludes(id)
}

/** How much light a block gives off, 0 to 15 (Minecraft's levels). */
export function lightOf(id: number, meta: number): number {
    switch (id) {
        case B.Lava:
        case B.Fire:
        case B.Glowstone:
        case B.JackOLantern: return 15
        case B.Torch: return 14
        // A furnace (or smoker, or blast furnace) only while it burns; a brewing stand a little.
        case B.Furnace:
        case B.Smoker:
        case B.BlastFurnace: return meta & FURNACE_LIT ? 13 : 0
        case B.BrewingStand: return 1
        // A redstone torch only while lit (bit 3 set means burnt out).
        case B.RedstoneTorch: return meta & 8 ? 0 : 7
        default: return 0
    }
}

/** How much a block holds light back: 15 stops it, 1 dims it a step more, 0 lets it through. */
export function opacityOf(id: number, meta: number): number {
    if (id === B.Air) return 0
    if (id === B.OakLeaves || id === B.Water || id === B.Ice) return 1
    if (isSlab(id)) return (meta & 3) === SLAB_DOUBLE ? 15 : 0
    const b = block(id)
    return b.shape === 'cube' && !b.transparent ? 15 : 0
}

export function isFluid(id: number) {
    return id === B.Water || id === B.Lava
}

/** A fluid can flow into air, plants and dust (washing them away), never into solids. */
export function replaceable(id: number) {
    const b = block(id)
    return id === B.Air || b.shape === 'cross' || b.shape === 'flat'
}
