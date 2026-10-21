import { B } from './blocks'
import { Island } from './island'
import { Mob } from './mobs'
import { CHUNK, LAYERS } from './world'

/*
 * A busy test island, for measuring how the game holds up: 100 cubes (a 5x5
 * square of columns, four cubes tall), every cube but the starter one running a
 * machine built to the game's real rules, so the machines actually produce:
 *
 *   cobble    eight generators: lava hardens beside a waterfall, an observer
 *             sees it, a block breaker mines it into a hopper over a store depot
 *   cane      a torch-and-repeater clock pulses pistons that break sugar cane;
 *             the cane tumbles into a stream that carries it to a hopper
 *   melon     the same clock drives pistons pushing down on melons
 *   pistons   clocked sticky pistons dragging stone back and forth (pure churn)
 *   villagers a farmer harvests and resows wheat round its composter and
 *             throws its spare wheat to a villager standing on a hopper
 *   hoppers   full chests emptying through eight-hopper lines into store depots
 *
 * Only for development: the game loads it with ?test=busy and never saves it.
 */

/** Hopper and piston facings (the game's DIRS order) and a wall torch pointing east. */
const NORTH = 0, EAST = 1, SOUTH = 2, WEST = 3, DOWN = 5
const TORCH_EAST = 1
/** A repeater sending east or west, at its longest delay (4). */
const REPEATER_EAST = EAST | 12, REPEATER_WEST = WEST | 12

export const MODULES = ['cobble', 'cane', 'melon', 'pistons', 'villagers', 'hoppers'] as const
export type Module = typeof MODULES[number]

/** Columns either side of the starter column: 2 makes a 5x5 square, 25 columns, 100 cubes. */
const REACH = 2

export function busyIsland(): Island {
    const island = addMachines(Island.fresh())
    island.coins = 1_000_000
    return island
}

/**
 * Your own island with the busy island's machines built round it: everything
 * you have (inventory, coins, chests, your land and what is on it) stays as it
 * is, and every cube of the 5x5 square you don't own yet is bought and gets a
 * machine. A copy: `own` itself is left alone.
 */
export function busyIslandWith(own: Island): Island {
    return addMachines(Island.fromSave(own.toSave()))
}

/** Buys every cube of the square the island doesn't own, and builds a machine in each of them. */
function addMachines(island: Island): Island {
    const w = island.world
    const fresh: [number, number, number][] = []
    for (let cx = -REACH; cx <= REACH; cx++) {
        for (let cz = -REACH; cz <= REACH; cz++) {
            for (let cy = 0; cy < LAYERS; cy++) {
                if (w.ownsCube(cx, cy, cz)) continue
                w.addCube(cx, cy, cz)
                island.chunksBought++
                fresh.push([cx, cy, cz])
            }
        }
    }
    fresh.forEach(([cx, cy, cz], i) => build(island, MODULES[i % MODULES.length]!, cx * CHUNK, cy * CHUNK, cz * CHUNK))
    return island
}

/** Builds one machine in the cube whose lowest corner is (ox, oy, oz). */
export function build(island: Island, module: Module, ox: number, oy: number, oz: number) {
    const put = (x: number, y: number, z: number, id: number, meta = 0) => island.world.set(ox + x, oy + y, oz + z, id, meta)
    const fill = (x0: number, x1: number, y: number, z0: number, z1: number, id: number) => {
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(x, y, z, id)
    }
    /**
     * A torch clock (a redstone torch on a block, fed back to that block through
     * two slow repeaters): its output dust is at (px, y, pz) and it reaches a
     * dust line starting at (px, y, pz + 1). It sits on stone one below.
     */
    const clock = (px: number, y: number, pz: number) => {
        fill(px, px + 3, y - 1, pz - 1, pz, B.Stone)
        put(px, y, pz, B.RedstoneDust)
        put(px, y, pz - 1, B.RedstoneDust)
        put(px + 1, y, pz - 1, B.Repeater, REPEATER_EAST)
        put(px + 2, y, pz - 1, B.Stone)
        put(px + 3, y, pz - 1, B.RedstoneTorch, TORCH_EAST)
        put(px + 3, y, pz, B.RedstoneDust)
        put(px + 2, y, pz, B.Repeater, REPEATER_WEST)
        put(px + 1, y, pz, B.RedstoneDust)
    }
    const fillChest = (x: number, y: number, z: number, item: string) => {
        const box = island.containerAt(ox + x, oy + y, oz + z)
        if (box) for (let i = 0; i < 27; i++) box.add(item, 64)
    }

    switch (module) {
        case 'cobble':
            for (const x0 of [0, 8]) for (const zg of [1, 5, 9, 13]) cobbleGenerator(x0, zg)
            return
        case 'cane': {
            // Cane on sand along x, a stream on its south side running east to a hopper.
            fill(0, 13, 1, 3, 8, B.Stone)
            put(8, 1, 7, B.Hopper, DOWN)
            put(8, 0, 7, B.Chest)
            for (let x = 0; x <= 9; x++) put(x, 2, 8, B.Stone)
            put(0, 2, 7, B.Stone)
            put(9, 2, 7, B.Stone)
            put(1, 2, 7, B.Water)
            put(1, 2, 6, B.Stone)
            put(8, 2, 6, B.Stone)
            // The cane's own water: still sources north of the sand, wet from the start
            // (the stream south of it takes a moment to flow, and only carries the harvest).
            for (let x = 1; x <= 8; x++) put(x, 2, 4, B.Stone)
            put(1, 2, 5, B.Stone)
            put(8, 2, 5, B.Stone)
            for (let x = 2; x <= 7; x++) put(x, 2, 5, B.Water)
            for (let x = 2; x <= 7; x++) {
                put(x, 2, 6, B.Sand)
                put(x, 3, 6, B.SugarCane)
                put(x, 3, 5, B.Stone)
                put(x, 4, 5, B.Piston, SOUTH)
            }
            put(8, 4, 5, B.Stone)
            put(9, 4, 5, B.Stone)
            for (let x = 2; x <= 9; x++) put(x, 5, 5, B.RedstoneDust)
            clock(9, 5, 4)
            return
        }
        case 'melon': {
            // Stems on farmland, melon spots on dirt south of them, a stream south of those.
            fill(0, 13, 1, 3, 8, B.Stone)
            put(9, 1, 7, B.Hopper, DOWN)
            put(9, 0, 7, B.Chest)
            for (let x = 1; x <= 10; x++) put(x, 2, 8, B.Stone)
            put(1, 2, 7, B.Stone)
            put(10, 2, 7, B.Stone)
            put(2, 2, 7, B.Water)
            for (let x = 1; x <= 9; x++) {
                put(x, 2, 4, B.Stone)
                put(x, 3, 4, B.Stone)
            }
            for (const x of [1, 9]) for (const z of [5, 6]) {
                put(x, 2, z, B.Stone)
                put(x, 3, z, B.Stone)
            }
            for (let x = 2; x <= 8; x++) {
                put(x, 2, 5, B.Farmland)
                put(x, 3, 5, x % 2 ? B.MelonStem : B.PumpkinStem, 7)
                put(x, 2, 6, B.Dirt)
                put(x, 4, 6, B.Piston, DOWN)
                put(x, 5, 6, B.RedstoneDust)
            }
            put(9, 4, 6, B.Stone)
            put(10, 4, 6, B.Stone)
            put(9, 5, 6, B.RedstoneDust)
            put(10, 5, 6, B.RedstoneDust)
            clock(10, 5, 5)
            return
        }
        case 'pistons':
            // Two walls of sticky pistons dragging stone back and forth.
            for (const y of [1, 7]) {
                fill(0, 15, y, 4, 8, B.Stone)
                for (let x = 1; x <= 11; x++) {
                    put(x, y + 1, 6, B.StickyPiston, SOUTH)
                    put(x, y + 1, 7, B.Stone)
                    put(x, y + 2, 6, B.RedstoneDust)
                }
                put(12, y + 1, 6, B.Stone)
                put(12, y + 2, 6, B.RedstoneDust)
                clock(12, y + 2, 5)
            }
            return
        case 'villagers': {
            // A wheat field round a composter (water under it), walled in; a second
            // villager in a booth beside it stands on a hopper.
            fill(0, 15, 1, 0, 12, B.Stone)
            for (let x = 2; x <= 10; x++) {
                for (let z = 2; z <= 10; z++) {
                    put(x, 2, z, B.Farmland)
                    put(x, 3, z, B.Wheat, (x * 7 + z * 3) % 8)
                }
            }
            put(6, 2, 6, B.Water)
            put(6, 3, 6, B.Composter)
            for (let i = 1; i <= 11; i++) {
                for (const y of [2, 3, 4]) {
                    put(i, y, 1, B.Stone)
                    put(i, y, 11, B.Stone)
                    put(1, y, i, B.Stone)
                    put(11, y, i, B.Stone)
                }
            }
            put(13, 2, 6, B.Hopper, DOWN)
            put(13, 1, 6, B.Chest)
            for (const y of [3, 4]) {
                put(12, y, 6, B.Glass)
                put(14, y, 6, B.Glass)
                put(13, y, 5, B.Glass)
                put(13, y, 7, B.Glass)
            }
            put(13, 5, 6, B.Glass)
            const farmer = new Mob('villager', ox + 4.5, oy + 3, oz + 4.5)
            farmer.profession = 'farmer'
            farmer.site = [ox + 6, oy + 3, oz + 6]
            farmer.inv.add('wheat_seeds', 16)
            island.mobs.list.push(farmer, new Mob('villager', ox + 13.5, oy + 3, oz + 6.5))
            return
        }
        case 'hoppers':
            // Four full chests, each emptying east through eight hoppers into a store depot.
            fill(0, 15, 1, 1, 12, B.Stone)
            for (const z of [2, 5, 8, 11]) {
                put(1, 3, z, B.Chest)
                fillChest(1, 3, z, 'cobblestone')
                for (let x = 1; x <= 8; x++) put(x, 2, z, B.Hopper, EAST)
                put(9, 2, z, B.Depot)
            }
            return
    }

    /**
     * A cobblestone generator along x from x0, centred on row zg: lava (x0+1)
     * flows into the gap (x0+2) beside a waterfall (x0+3, fed from x0+4) and
     * hardens. The observer above the gap fires the breaker beside it, which
     * mines the block into the hopper under the gap, over a store depot.
     */
    function cobbleGenerator(x0: number, zg: number) {
        fill(x0, x0 + 5, 1, zg - 1, zg + 1, B.Stone)
        fill(x0, x0 + 5, 0, zg - 1, zg + 1, B.Stone)
        put(x0 + 2, 1, zg, B.Hopper, DOWN)
        put(x0 + 2, 0, zg, B.Depot)
        put(x0 + 3, 1, zg, B.Air)
        for (const x of [x0, x0 + 5]) put(x, 2, zg, B.Stone)
        for (let x = x0 + 1; x <= x0 + 4; x++) put(x, 2, zg - 1, B.Stone)
        for (const x of [x0 + 1, x0 + 3, x0 + 4]) put(x, 2, zg + 1, B.Stone)
        put(x0 + 2, 2, zg + 1, B.BlockBreaker, NORTH)
        put(x0 + 2, 3, zg + 1, B.Stone)
        put(x0 + 2, 3, zg, B.Observer, DOWN)
        put(x0 + 2, 4, zg, B.RedstoneDust)
        put(x0 + 2, 4, zg + 1, B.RedstoneDust)
        put(x0 + 1, 2, zg, B.Lava)
        put(x0 + 4, 2, zg, B.Water)
    }
}
