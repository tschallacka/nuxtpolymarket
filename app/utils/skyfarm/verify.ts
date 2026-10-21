import type { SkyfarmIsland } from '#shared/utils/skyfarm/binary'
import { B, block, isFluid, PLANTS } from './blocks'
import type { Island } from './island'
import { GROW_TICKS, MOIST_GROW_CHANCE, SAPLING_TICKS, TICKS_PER_SECOND } from './sim'

/*
 * The server's check on what a player sends to storage, by plain accounting.
 * Every item an island holds is in a known place in its save: chests and other
 * containers, the player's inventory and armour, villagers' slots, and blocks
 * built into the world. So, item by item:
 *
 *   held now + sent to storage  <=  held at the last check + what the island
 *                                   could have produced since (+ a margin)
 *
 * Emptying a full chest into storage passes (the chest goes down by what
 * storage gains); items made up out of nothing don't. What the server last
 * accepted as held is carried forward ("trusted"), never what a save merely
 * claims: items forged into a chest never become trusted, so they can't be
 * sent on later either. Crafted things only become trusted as far as the
 * island could have produced them, so storage takes what an island grows,
 * mines and makes with its machines.
 *
 * What it could have produced comes from two measures, both on the generous
 * side, as a maximum should be:
 *   machines  the island replayed headless for a minute (as the offline
 *             catch-up does): what machines and generators made
 *   growth    from a count of what grows on it and Minecraft's growth rules:
 *             the most each crop, cane, stem and sapling can yield
 */

/** Ticks the machine replay runs. */
export const MEASURE_TICKS = 1200
/**
 * The margin on what the island could produce: half again, and up to a stack
 * for timing (a save landing mid-harvest). The stack is never more than the
 * island made in the time, so an item it can't produce gets nothing: a fixed
 * allowance would renew every save, and pay out forged items forever.
 */
export const PRODUCTION_MARGIN = 1.5
export const PRODUCTION_SLACK = 64
/**
 * The most one bone meal can make grow, by item: a crop finished (a ripe wheat
 * and its seeds), a fruit on a grown stem, a sapling made a tree. Bone meal the
 * island used up (trusted, then neither held nor sent) raises the allowance of
 * each of these the island grows: it is real production, just faster.
 */
export const BONE_MEAL_YIELD: Record<string, number> = {
    wheat: 1, wheat_seeds: 3, melon_slice: 7, pumpkin: 1, oak_log: 7, oak_sapling: 4, stick: 4, apple: 2
}
/** Time between checks counts for at most this long (a week). */
export const MAX_ELAPSED_SECONDS = 7 * 24 * 3600

/** Blocks that grow or flow in the world: not counted as held (they would change between saves by themselves). */
const GROWING = new Set<number>([B.Melon, B.Pumpkin, B.OakLeaves, B.Farmland, B.Water, B.Lava, B.Fire])

const add = (m: Map<string, number>, key: string, n: number) => {
    if (n) m.set(key, (m.get(key) ?? 0) + n)
}

/** Everything a saved island holds, by item key. */
export function holdings(island: SkyfarmIsland): Map<string, number> {
    const held = new Map<string, number>()
    const slots = (list: ({ item: string, count: number } | null)[] | undefined) => {
        for (const s of list ?? []) if (s) add(held, s.item, s.count)
    }
    slots(island.state.inventory)
    slots(island.state.armor)
    for (const m of island.state.mobs ?? []) slots(m.inv)
    const blocks = new Map<number, number>()
    for (const c of island.columns) {
        for (const box of c.containers) slots(box.slots)
        for (let i = 0; i < c.blocks.length; i++) {
            const id = c.blocks[i]!
            if (id) blocks.set(id, (blocks.get(id) ?? 0) + 1)
        }
    }
    for (const [id, n] of blocks) {
        if (PLANTS.has(id) || GROWING.has(id) || isFluid(id)) continue
        const drop = block(id).drop
        if (drop) add(held, drop, n)
    }
    // Older saves kept containers in the state.
    for (const list of Object.values(island.state.containers ?? {})) slots(list)
    return held
}

/**
 * The most what grows on the island can yield a second, by item: every
 * farmland block a wheat plant ripening as fast as the rules allow (seven
 * stages, a check at the shortest interval, the moist chance), every stem a
 * fruit per check, every cane or cactus a block per check, every sapling a tree.
 */
export function growthCapacity(island: SkyfarmIsland): Map<string, number> {
    const cap = new Map<string, number>()
    let farmland = 0, stems = 0, pumpkinStems = 0, canes = 0, cacti = 0, saplings = 0
    for (const c of island.columns) {
        const b = c.blocks
        for (let i = 0; i < b.length; i++) {
            const id = b[i]!
            if (id === B.Farmland) farmland++
            else if (id === B.MelonStem) stems++
            else if (id === B.PumpkinStem) pumpkinStems++
            else if (id === B.OakSapling) saplings++
            // A cane or cactus base (nothing of its kind below it) grows the column.
            else if (id === B.SugarCane && (i < 256 || b[i - 256] !== B.SugarCane)) canes++
            else if (id === B.Cactus && (i < 256 || b[i - 256] !== B.Cactus)) cacti++
        }
    }
    const perSecond = (ticks: number) => TICKS_PER_SECOND / ticks
    const check = perSecond(GROW_TICKS.min)
    const ripe = check * MOIST_GROW_CHANCE / 7
    add(cap, 'wheat', farmland * ripe)
    add(cap, 'wheat_seeds', farmland * ripe * 3)
    add(cap, 'melon_slice', stems * check * MOIST_GROW_CHANCE * 7)
    add(cap, 'pumpkin', pumpkinStems * check * MOIST_GROW_CHANCE)
    add(cap, 'sugar_cane', canes * check * 0.5)
    add(cap, 'cactus', cacti * check * 0.5)
    // A sapling grows in two stages, half a chance a check: a tree, its logs and what its leaves drop.
    const trees = saplings * perSecond(SAPLING_TICKS.min) * 0.5 / 2
    add(cap, 'oak_log', trees * 7)
    add(cap, 'oak_sapling', trees * 4)
    add(cap, 'stick', trees * 4)
    add(cap, 'apple', trees * 2)
    return cap
}

/**
 * What the island's machines and generators make a second, by item: the island
 * replayed headless (no player, no monsters about), counting what it drops by
 * itself and what its generators form. Runs the island on: give it a copy.
 */
export function measureMachines(island: Island, ticks = MEASURE_TICKS): Map<string, number> {
    const made = new Map<string, number>()
    const ledger = island.ledger
    const produce = ledger.produce.bind(ledger)
    ledger.produce = (key: string, n: number) => {
        add(made, key, n)
        produce(key, n)
    }
    const formedBefore = new Map(island.sim.formed)
    island.mobs.target = { x: island.player.x, y: island.player.y, z: island.player.z, active: false, held: null }
    try {
        for (let i = 0; i < ticks; i++) island.step()
    } finally {
        ledger.produce = produce
    }
    for (const [id, n] of island.sim.formed) {
        const drop = block(id).drop
        if (drop) add(made, drop, n - (formedBefore.get(id) ?? 0))
    }
    const seconds = ticks / TICKS_PER_SECOND
    return new Map([...made].filter(([, n]) => n > 0).map(([k, n]) => [k, n / seconds]))
}

/** The most an island can produce a second, by item: machines and growth together. */
export function productionRates(island: Island, saved: SkyfarmIsland): Record<string, number> {
    const rates = measureMachines(island)
    for (const [k, n] of growthCapacity(saved)) add(rates, k, n)
    return Object.fromEntries(rates)
}

export interface Accounting {
    /** What storage takes of what was sent, by item. */
    accepted: Record<string, number>
    /** What the island is now trusted to hold, by item (for the next check). */
    trusted: Record<string, number>
}

/**
 * The check. `trusted`: held at the last check; `held`: held now (the save);
 * `sent`: sent to storage since; `rates`: the most it can produce a second;
 * `seconds`: since the last check. Storage takes what fits; the rest is turned
 * away (it stays pending on the island, to try again).
 */
export function account(opts: { trusted: Record<string, number>, held: Map<string, number>, sent: Record<string, number>, rates: Record<string, number>, seconds: number }): Accounting {
    const seconds = Math.max(0, Math.min(MAX_ELAPSED_SECONDS, opts.seconds))
    const keys = new Set([...Object.keys(opts.trusted), ...opts.held.keys(), ...Object.keys(opts.sent)])
    const accepted: Record<string, number> = {}
    const trusted: Record<string, number> = {}
    // Trusted bone meal that is gone (not held, not sent): used on the island's crops.
    const boneMeal = Math.max(0, (opts.trusted.bone_meal ?? 0) - (opts.held.get('bone_meal') ?? 0) - (opts.sent.bone_meal ?? 0))
    for (const key of keys) {
        const made = (opts.rates[key] ?? 0) * seconds
        const grown = (opts.rates[key] ?? 0) > 0 ? boneMeal * (BONE_MEAL_YIELD[key] ?? 0) : 0
        const budget = (opts.trusted[key] ?? 0) + made * PRODUCTION_MARGIN + Math.min(PRODUCTION_SLACK, made) + grown
        const held = opts.held.get(key) ?? 0
        const take = Math.max(0, Math.min(Math.floor(opts.sent[key] ?? 0), Math.floor(budget - held)))
        if (take > 0) accepted[key] = take
        const keep = Math.max(0, Math.min(held, budget - take))
        if (keep > 0) trusted[key] = Math.floor(keep)
    }
    return { accepted, trusted }
}
