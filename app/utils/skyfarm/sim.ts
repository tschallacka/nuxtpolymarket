import { randomFloat } from '#shared/utils/random'
import { B, block, DOUBLE_PLANTS, FLAMMABLE, FLOWERS, GRASS_FLOWERS, isFluid, PLANTS, plantSupported, replaceable, TALL_FLOWERS, UPPER } from './blocks'
import { ORE_LEVELS } from './economy'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import type { World } from './world'

/*
 * The island's clock: 20 game ticks a second, as in Minecraft. Block updates
 * are scheduled for a later tick (fluids flow on a delay), and every block
 * change schedules its neighbours, so the world settles one step at a time
 * and runs the same whether it is being played or fast-forwarded.
 *
 * Fluids keep their state in the meta byte: bits 0-2 the level (0 is a
 * source, higher is further from it), bit 3 set when it is falling.
 */

export const TICKS_PER_SECOND = 20

const FALLING = 8

/** Farmland's meta bit: water is near, crops grow twice as fast. */
export const FARMLAND_MOIST = 1
/** A stem's meta: bits 0-2 its age, bit 3 set when it has grown its fruit, bits 4-5 which way that is. */
export const STEM_ATTACHED = 8
/** The four ways a stem can face, as (x, z); the index is kept in its meta bits 4-5. */
export const STEM_DIRS: [number, number][] = [[-1, 0], [0, -1], [1, 0], [0, 1]]

/** Blocks with a growth clock. */
/**
 * Growth timing, shared with the server's production check (verify.ts): how
 * often a crop, a farmland block and a sapling get a growth check, in ticks.
 */
export const GROW_TICKS = { min: 300, spread: 400 }
export const SAPLING_TICKS = { min: 600, spread: 1200 }
export const FARMLAND_TICKS = { min: 200, spread: 200 }
/** The chance a crop on moist farmland grows a stage per check (dry: half that). */
export const MOIST_GROW_CHANCE = 2 / 3
const GROWS = new Set<number>([B.OakSapling, B.Farmland, B.Wheat, B.MelonStem, B.PumpkinStem, B.SugarCane, B.Cactus])

/**
 * What a plant drops when it is broken or pops off: wheat its grain and
 * seeds once ripe, short grass a seed now and then, the rest themselves.
 */
export function plantDrop(id: number, meta: number, roll: () => number): ItemStack | null {
    // A two-block plant drops once, from its lower half.
    if (DOUBLE_PLANTS.has(id) && meta & UPPER) return null
    if (FLOWERS.includes(id) || TALL_FLOWERS.has(id)) return { item: block(id).key, count: 1 }
    switch (id) {
        case B.TallGrass:
        case B.DoubleTallGrass: return roll() < 1 / 8 ? { item: 'wheat_seeds', count: 1 } : null
        case B.Wheat: return { item: 'wheat_seeds', count: 1 }
        case B.MelonStem: return { item: 'melon_seeds', count: 1 }
        case B.PumpkinStem: return { item: 'pumpkin_seeds', count: 1 }
        case B.OakSapling: return { item: 'oak_sapling', count: 1 }
        case B.SugarCane: return { item: 'sugar_cane', count: 1 }
        case B.Cactus: return { item: 'cactus', count: 1 }
        case B.Torch: return { item: 'torch', count: 1 }
        case B.RedstoneTorch: return { item: 'redstone_torch', count: 1 }
        case B.RedstoneDust: return { item: 'redstone', count: 1 }
        case B.Repeater: return { item: 'repeater', count: 1 }
        case B.Lever: return { item: 'lever', count: 1 }
        case B.Button: return { item: 'button', count: 1 }
        default: return null
    }
}

/** Leaves' meta bit for leaves the player placed: those never decay. */
export const LEAVES_PLACED = 1
/** How far (in steps through other leaves) a leaf can be from a log and stay alive, as in Minecraft. */
const LEAF_REACH = 6

/** Whether a log is within `reach` steps of (x, y, z), walking only through leaves. */
function logWithin(world: World, x: number, y: number, z: number, reach: number) {
    const seen = new Set<string>([`${x},${y},${z}`])
    let frontier: [number, number, number][] = [[x, y, z]]
    for (let step = 0; step < reach && frontier.length; step++) {
        const next: [number, number, number][] = []
        for (const [cx, cy, cz] of frontier) {
            for (const [dx, dy, dz] of AROUND) {
                const nx = cx + dx, ny = cy + dy, nz = cz + dz
                const key = `${nx},${ny},${nz}`
                if (seen.has(key)) continue
                seen.add(key)
                const id = world.get(nx, ny, nz)
                if (id === B.OakLog) return true
                if (id === B.OakLeaves) next.push([nx, ny, nz])
            }
        }
        frontier = next
    }
    return false
}

/**
 * Grows an oak from the sapling at (x, y, z), Minecraft's way: a trunk of 4 to
 * 6 logs, two wide layers of leaves (radius 2) around the top of the trunk and
 * two narrow ones (radius 1) above, each layer's corners trimmed at random.
 * Needs open air for the whole trunk; leaves only fill empty cells, on owned
 * land. Returns false (and grows nothing) when there is no room.
 */
export function growOak(world: World, x: number, y: number, z: number, roll: () => number): boolean {
    const height = 4 + Math.floor(roll() * 3)
    for (let dy = 1; dy <= height; dy++) {
        const id = world.get(x, y + dy, z)
        if (id !== B.Air && id !== B.OakLeaves && !replaceable(id)) return false
        if (y + dy >= 64) return false
    }
    const top = y + height - 1
    for (let ly = top - 2; ly <= top + 1; ly++) {
        const wide = ly <= top - 1
        const r = wide ? 2 : 1
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                const corner = Math.abs(dx) === r && Math.abs(dz) === r
                // Corners: the top layer always loses them, the others half the time.
                if (corner && (ly === top + 1 || roll() < 0.5)) continue
                if (dx === 0 && dz === 0 && ly <= top) continue
                if (world.get(x + dx, ly, z + dz) === B.Air) world.set(x + dx, ly, z + dz, B.OakLeaves)
            }
        }
    }
    for (let ly = y; ly <= top; ly++) world.set(x, ly, z, B.OakLog)
    return true
}

/**
 * What an oak leaf drops when it decays or is broken without shears, at
 * Minecraft's odds: a sapling 1 in 20, one or two sticks 1 in 50, an apple 1 in 200.
 */
export function leafDrops(roll: () => number): ItemStack[] {
    const out: ItemStack[] = []
    if (roll() < 1 / 20) out.push({ item: 'oak_sapling', count: 1 })
    if (roll() < 1 / 50) out.push({ item: 'stick', count: roll() < 0.5 ? 1 : 2 })
    if (roll() < 1 / 200) out.push({ item: 'apple', count: 1 })
    return out
}

/** How full a fluid cell is (0..1): a source fills 8/9, each level down less; with the same fluid above, all of it. */
export function fluidHeight(world: World, id: number, meta: number, x: number, y: number, z: number) {
    if (world.get(x, y + 1, z) === id) return 1
    const level = meta & FALLING ? 0 : meta & 7
    return (8 - level) / 9
}

/**
 * Which way a fluid flows at (x, y, z), as a unit vector in x/z (or zero):
 * downhill toward lower neighbours of the same fluid and toward open cells it
 * could spill into, as Minecraft works it out. Drives the flow texture's
 * direction and the push on whoever stands in it.
 */
export function fluidFlow(world: World, x: number, y: number, z: number): [number, number] {
    const id = world.get(x, y, z)
    if (!isFluid(id)) return [0, 0]
    const h = fluidHeight(world, id, world.meta(x, y, z), x, y, z)
    let fx = 0, fz = 0
    for (const [dx, , dz] of SIDES) {
        const nx = x + dx, nz = z + dz
        const nb = world.get(nx, y, nz)
        let diff = 0
        if (nb === id) diff = h - fluidHeight(world, id, world.meta(nx, y, nz), nx, y, nz)
        else if (replaceable(nb) && world.ownsAt(nx, y, nz)) diff = h
        fx += dx * diff
        fz += dz * diff
    }
    const len = Math.hypot(fx, fz)
    return len < 1e-6 ? [0, 0] : [fx / len, fz / len]
}

interface FluidRule {
    /** Ticks between updates. */
    delay: number
    /** Level added per block of horizontal spread, and the furthest level it reaches. */
    step: number
    max: number
}

const RULES: Record<number, FluidRule> = {
    [B.Water]: { delay: 5, step: 1, max: 7 },
    [B.Lava]: { delay: 30, step: 2, max: 6 }
}

const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const
const AROUND = [...SIDES, [0, 1, 0], [0, -1, 0]] as const

/** A fluid's meta for a source block: level 0, not falling. */
function isSource(meta: number) {
    return (meta & 7) === 0 && !(meta & FALLING)
}

function packKey(x: number, y: number, z: number) {
    return `${x},${y},${z}`
}

export class Sim {
    tick = 0
    /** Generator upgrade level (an index into ORE_LEVELS). */
    oreLevel = 0
    /** Counts what the generators made, for the away report and tests. */
    readonly formed = new Map<number, number>()
    private scheduled = new Map<number, Set<string>>()

    /**
     * Whether fire spreads and burns, and lava starts fires. Off while catching
     * up on time away (Q42): you can't lose a farm to fire while not playing.
     */
    fireEnabled = true
    /** Rain is falling: fire with open sky above goes out (set by the island's weather). */
    raining = false
    /** Blocks that may be on fire (pruned as they go out). */
    readonly fires = new Set<string>()
    /** Fire and lava-heat checks already waiting, so each block has one clock, not several. */
    private pending = new Set<string>()

    constructor(readonly world: World, private roll: () => number = randomFloat) {
        world.onChange = (x, y, z) => this.neighbourChanged(x, y, z)
    }

    /** Schedules `key` (a block, or `h:` and a block for lava heat) unless it is already waiting. */
    private scheduleOnce(key: string, delay: number) {
        if (this.pending.has(key)) return
        this.pending.add(key)
        const at = this.tick + Math.max(1, delay)
        let set = this.scheduled.get(at)
        if (!set) {
            set = new Set()
            this.scheduled.set(at, set)
        }
        set.add(key)
    }

    // ── Fire ───────────────────────────────────────────────────────────

    /** Nothing at all above (x, y, z): rain reaches it. */
    openSky(x: number, y: number, z: number) {
        for (let ay = y + 1; ay < 64; ay++) if (this.world.get(x, ay, z) !== B.Air) return false
        return true
    }

    private flammable(x: number, y: number, z: number) {
        return FLAMMABLE[this.world.get(x, y, z)]
    }

    private fuelAround(x: number, y: number, z: number) {
        return AROUND.some(([dx, dy, dz]) => !!this.flammable(x + dx, y + dy, z + dz))
    }

    /** Something caught fire at (x, y, z) (for the sound). */
    onIgnite: ((x: number, y: number, z: number) => void) | null = null

    private ignite(x: number, y: number, z: number, age: number) {
        if (!this.world.set(x, y, z, B.Fire, Math.min(15, age))) return
        this.onIgnite?.(x, y, z)
        this.fires.add(packKey(x, y, z))
        this.scheduleOnce(packKey(x, y, z), 30 + Math.floor(this.roll() * 10))
    }

    /**
     * A fire's tick, Minecraft's rules: it ages; it burns the flammable blocks
     * around it away (sometimes leaving fire in their place); it spreads to air
     * near other flammable blocks, more eagerly upward; and with nothing left
     * to burn it goes out.
     */
    private updateFire(x: number, y: number, z: number) {
        const w = this.world
        if (w.get(x, y, z) !== B.Fire) {
            this.fires.delete(packKey(x, y, z))
            return
        }
        const again = () => this.scheduleOnce(packKey(x, y, z), 30 + Math.floor(this.roll() * 10))
        if (!this.fireEnabled) return again()
        const fuel = this.fuelAround(x, y, z)
        if (!fuel && !block(w.get(x, y - 1, z)).solid) {
            w.set(x, y, z, B.Air)
            return
        }
        const age = Math.min(15, (w.meta(x, y, z) & 15) + Math.floor(this.roll() * 3))
        // Rain puts out fire open to the sky, older fires more surely (Minecraft's odds).
        if (this.raining && this.openSky(x, y, z) && this.roll() < 0.2 + age * 0.03) {
            w.set(x, y, z, B.Air)
            return
        }
        // Burn the neighbours: the more flammable, the likelier it goes.
        for (const [dx, dy, dz] of AROUND) {
            const f = this.flammable(x + dx, y + dy, z + dz)
            if (!f || this.roll() * (dy !== 0 ? 250 : 300) >= f.burns) continue
            if (this.roll() * (age + 10) < 5) this.ignite(x + dx, y + dy, z + dz, age + Math.floor(this.roll() * 5 / 4))
            else w.set(x + dx, y + dy, z + dz, B.Air)
        }
        // Spread to the air around: up to four above, one below and to the sides.
        for (let dy = -1; dy <= 4; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    if (!dx && !dy && !dz) continue
                    const nx = x + dx, ny = y + dy, nz = z + dz
                    if (w.get(nx, ny, nz) !== B.Air || !w.ownsAt(nx, ny, nz)) continue
                    let catches = 0
                    for (const [ax, ay, az] of AROUND) catches = Math.max(catches, this.flammable(nx + ax, ny + ay, nz + az)?.catches ?? 0)
                    if (!catches) continue
                    const odds = (catches + 40) / (age + 30)
                    if (this.roll() * (dy > 1 ? 100 + (dy - 1) * 100 : 100) <= odds) this.ignite(nx, ny, nz, age + Math.floor(this.roll() * 5 / 4))
                }
            }
        }
        // Burn out: quickly with nothing to burn, now and then once old.
        if ((!this.fuelAround(x, y, z) && age > 3) || (age === 15 && !this.flammable(x, y - 1, z) && this.roll() < 0.25)) {
            w.set(x, y, z, B.Air)
            return
        }
        if ((w.meta(x, y, z) & 15) !== age) w.setMeta(x, y, z, age)
        again()
    }

    /**
     * Lava's heat, Minecraft's rule: now and then it tries a few spots around
     * and above it, and sets fire to air beside anything flammable.
     */
    private lavaHeat(x: number, y: number, z: number) {
        const w = this.world
        if (w.get(x, y, z) !== B.Lava) return
        if (this.fireEnabled) {
            const tries = Math.floor(this.roll() * 3)
            let px = x, py = y, pz = z
            for (let i = 0; i < tries; i++) {
                px += Math.floor(this.roll() * 3) - 1
                py += 1
                pz += Math.floor(this.roll() * 3) - 1
                const id = w.get(px, py, pz)
                if (id === B.Air) {
                    if (this.fuelAround(px, py, pz)) {
                        this.ignite(px, py, pz, 0)
                        break
                    }
                } else if (block(id).solid) {
                    break
                }
            }
            if (tries === 0) {
                // Or it lights the top of a flammable block right beside it.
                for (let i = 0; i < 3; i++) {
                    const ax = x + Math.floor(this.roll() * 3) - 1, az = z + Math.floor(this.roll() * 3) - 1
                    if (w.get(ax, y + 1, az) === B.Air && this.flammable(ax, y, az)) this.ignite(ax, y + 1, az, 0)
                }
            }
        }
        this.scheduleOnce(`h:${x},${y},${z}`, 60 + Math.floor(this.roll() * 140))
    }

    /** Asks for (x, y, z) to be updated `delay` ticks from now. */
    schedule(x: number, y: number, z: number, delay: number) {
        const at = this.tick + Math.max(1, delay)
        let set = this.scheduled.get(at)
        if (!set) {
            set = new Set()
            this.scheduled.set(at, set)
        }
        set.add(packKey(x, y, z))
    }

    /** A block changed: wake every fluid around it (and the block itself). */
    private neighbourChanged(x: number, y: number, z: number) {
        for (const [dx, dy, dz] of [[0, 0, 0], ...AROUND] as const) {
            const nx = x + dx, ny = y + dy, nz = z + dz
            const id = this.world.get(nx, ny, nz)
            const rule = RULES[id]
            if (rule) this.schedule(nx, ny, nz, rule.delay)
            else if (id === B.OakLeaves && !(this.world.meta(nx, ny, nz) & LEAVES_PLACED)) this.schedule(nx, ny, nz, this.leafDelay())
            // A plant next to a change checks next tick that it still has something to stand on.
            else if (PLANTS.has(id)) this.schedule(nx, ny, nz, 1)
            // A fire (however it was lit) keeps its clock going; it also notices a neighbour burning away.
            else if (id === B.Fire) {
                this.fires.add(packKey(nx, ny, nz))
                this.scheduleOnce(packKey(nx, ny, nz), 30 + Math.floor(this.roll() * 10))
            }
            // New lava starts giving off heat; anything that grows starts its growth clock.
            if (dx === 0 && dy === 0 && dz === 0) {
                if (id === B.Lava) this.scheduleOnce(`h:${nx},${ny},${nz}`, 60 + Math.floor(this.roll() * 140))
                this.startGrowing(id, nx, ny, nz)
            }
        }
    }

    // ── Growing things ─────────────────────────────────────────────────

    /** Starts the growth clock of a block that grows (once per block; it keeps itself going). */
    private startGrowing(id: number, x: number, y: number, z: number) {
        if (GROWS.has(id)) this.scheduleOnce(`g:${x},${y},${z}`, this.growDelay(id))
    }

    /** Ticks between growth checks: saplings 30 to 90 seconds, crops 15 to 35, farmland 10 to 20. */
    private growDelay(id: number) {
        const t = id === B.OakSapling ? SAPLING_TICKS : id === B.Farmland ? FARMLAND_TICKS : GROW_TICKS
        return t.min + Math.floor(this.roll() * t.spread)
    }

    /** A plant whose ground is gone pops off as an item (and so does everything stacked on it). */
    private checkSupport(id: number, x: number, y: number, z: number) {
        const w = this.world
        const meta = w.meta(x, y, z)
        if (plantSupported(id, (a, b, c) => w.get(a, b, c), x, y, z, meta)) {
            // A stem whose fruit was taken goes back to growing one.
            if ((id === B.MelonStem || id === B.PumpkinStem) && w.meta(x, y, z) & STEM_ATTACHED) {
                const [dx, dz] = STEM_DIRS[(w.meta(x, y, z) >> 4) & 3]!
                const fruit = id === B.MelonStem ? B.Melon : B.Pumpkin
                if (w.get(x + dx, y, z + dz) !== fruit) {
                    w.setMeta(x, y, z, 7)
                    this.startGrowing(id, x, y, z)
                }
            }
            return
        }
        w.set(x, y, z, B.Air)
        const drop = plantDrop(id, meta, this.roll)
        if (drop) this.onDrop?.(x, y, z, drop)
    }

    /** A growth check for whatever grows at (x, y, z); it schedules the next one while it lives. */
    private grow(x: number, y: number, z: number) {
        const w = this.world
        const id = w.get(x, y, z)
        if (!GROWS.has(id)) return
        const again = () => this.scheduleOnce(`g:${x},${y},${z}`, this.growDelay(id))
        const meta = w.meta(x, y, z)
        switch (id) {
            case B.OakSapling:
                // Half the time it grows a stage; at its second stage it becomes a tree, if there is room.
                if (this.roll() < 0.5) {
                    if (!(meta & 1)) w.setMeta(x, y, z, meta | 1)
                    else if (growOak(w, x, y, z, this.roll)) return
                }
                return again()
            case B.Farmland:
                // Moist with water within four blocks around, at its level or one up.
                this.updateMoisture(x, y, z)
                return again()
            case B.Wheat:
            case B.MelonStem:
            case B.PumpkinStem: {
                const age = meta & 7
                // Moist farmland grows crops twice as fast as dry.
                const chance = w.meta(x, y - 1, z) & FARMLAND_MOIST ? MOIST_GROW_CHANCE : MOIST_GROW_CHANCE / 2
                if (age < 7) {
                    if (this.roll() < chance) w.setMeta(x, y, z, (meta & ~7) | (age + 1))
                } else if (id !== B.Wheat && !(meta & STEM_ATTACHED) && this.roll() < chance) {
                    this.growFruit(id, x, y, z)
                }
                if (id === B.Wheat && (w.meta(x, y, z) & 7) === 7) return
                return again()
            }
            case B.SugarCane:
            case B.Cactus: {
                // Up to three tall: the top block grows the next one into the air above it.
                if (w.get(x, y + 1, z) === id) return
                let height = 1
                while (w.get(x, y - height, z) === id) height++
                if (height >= 3) return again()
                if (w.get(x, y + 1, z) === B.Air && this.roll() < 0.5) w.set(x, y + 1, z, id)
                return again()
            }
        }
    }

    private updateMoisture(x: number, y: number, z: number) {
        const w = this.world
        let wet = false
        for (let dx = -4; dx <= 4 && !wet; dx++) {
            for (let dz = -4; dz <= 4 && !wet; dz++) {
                for (let dy = 0; dy <= 1 && !wet; dy++) if (w.get(x + dx, y + dy, z + dz) === B.Water) wet = true
            }
        }
        const meta = w.meta(x, y, z)
        const next = wet ? meta | FARMLAND_MOIST : meta & ~FARMLAND_MOIST
        if (next !== meta) w.setMeta(x, y, z, next)
    }

    /** A grown stem puts a melon or pumpkin on a free spot beside it, and turns toward it. */
    private growFruit(id: number, x: number, y: number, z: number) {
        const w = this.world
        const d = Math.floor(this.roll() * 4)
        const [dx, dz] = STEM_DIRS[d]!
        const fx = x + dx, fz = z + dz
        const below = w.get(fx, y - 1, fz)
        if (w.get(fx, y, fz) !== B.Air || ![B.Dirt, B.Grass, B.Farmland].includes(below)) return
        if (!w.set(fx, y, fz, id === B.MelonStem ? B.Melon : B.Pumpkin)) return
        w.setMeta(x, y, z, 7 | STEM_ATTACHED | (d << 4))
    }

    /**
     * Bone meal on the block at (x, y, z), Minecraft's effects: a sapling may
     * grow a stage (or into a tree), a crop jumps two to five stages, a grown
     * stem tries for a fruit, grass sprouts short grass and flowers around it,
     * short grass grows into tall grass, and a tall flower drops another of
     * itself. Returns whether it did anything (only then is the bone meal used up).
     */
    boneMeal(x: number, y: number, z: number): boolean {
        const w = this.world
        const id = w.get(x, y, z)
        const meta = w.meta(x, y, z)
        switch (id) {
            case B.OakSapling:
                if (this.roll() < 0.45) {
                    if (!(meta & 1)) w.setMeta(x, y, z, meta | 1)
                    else growOak(w, x, y, z, this.roll)
                }
                return true
            case B.Wheat:
            case B.MelonStem:
            case B.PumpkinStem: {
                const age = meta & 7
                if (age < 7) {
                    w.setMeta(x, y, z, (meta & ~7) | Math.min(7, age + 2 + Math.floor(this.roll() * 4)))
                    return true
                }
                if (id !== B.Wheat && !(meta & STEM_ATTACHED)) {
                    this.growFruit(id, x, y, z)
                    return true
                }
                return false
            }
            case B.Grass: {
                if (w.get(x, y + 1, z) !== B.Air) return false
                // Short grass sprouts on grass around the spot clicked (always on the spot itself),
                // one time in eight a flower instead (GrassBlock.performBonemeal), and short grass
                // already there now and then grows tall.
                for (let i = 0; i < 24; i++) {
                    const gx = i === 0 ? x : x + Math.floor(this.roll() * 7) - 3
                    const gz = i === 0 ? z : z + Math.floor(this.roll() * 7) - 3
                    const gy = i === 0 ? y : y + Math.floor(this.roll() * 3) - 1
                    if (w.get(gx, gy, gz) !== B.Grass) continue
                    const above = w.get(gx, gy + 1, gz)
                    if (above === B.TallGrass && i > 0 && this.roll() < 0.1) this.growTallGrass(gx, gy + 1, gz)
                    if (above !== B.Air || (i > 0 && this.roll() >= 0.5)) continue
                    w.set(gx, gy + 1, gz, this.roll() < 1 / 8 ? this.grassFlower() : B.TallGrass)
                }
                return true
            }
            // Short grass grows into tall grass, given room above.
            case B.TallGrass:
                return this.growTallGrass(x, y, z)
            // A tall flower drops another of itself (from its lower half).
            case B.Sunflower:
            case B.Lilac:
            case B.RoseBush:
            case B.Peony:
                this.onDrop?.(x, meta & UPPER ? y - 1 : y, z, { item: block(id).key, count: 1 })
                return true
            default:
                return false
        }
    }

    /** Short grass at (x, y, z) becomes tall grass, if there is room above. Returns whether it did. */
    private growTallGrass(x: number, y: number, z: number) {
        const w = this.world
        if (w.get(x, y + 1, z) !== B.Air || !w.ownsAt(x, y + 1, z)) return false
        w.set(x, y + 1, z, B.DoubleTallGrass, UPPER)
        w.set(x, y, z, B.DoubleTallGrass, 0)
        return true
    }

    /** A flower for bone meal on grass, by the plains' weights. */
    private grassFlower(): B {
        const total = GRASS_FLOWERS.reduce((s, [, n]) => s + n, 0)
        let r = this.roll() * total
        for (const [id, n] of GRASS_FLOWERS) if ((r -= n) < 0) return id
        return B.Dandelion
    }

    /** Leaves decay a few at a time, not all on one tick: between half a second and three seconds. */
    private leafDelay() {
        return 10 + Math.floor(this.roll() * 50)
    }


    /** Called when a block comes apart by itself (a leaf decaying), with what it drops at (x, y, z). */
    onDrop: ((x: number, y: number, z: number, stack: ItemStack) => void) | null = null

    /** A natural leaf with no log within reach of it, through other leaves, decays. */
    private updateLeaf(x: number, y: number, z: number) {
        const w = this.world
        if (w.get(x, y, z) !== B.OakLeaves || w.meta(x, y, z) & LEAVES_PLACED) return
        if (logWithin(w, x, y, z, LEAF_REACH)) return
        w.set(x, y, z, B.Air)
        for (const stack of leafDrops(this.roll)) this.onDrop?.(x, y, z, stack)
    }

    /** Wakes every fluid on the island, e.g. after loading a save. */
    wakeAll() {
        for (const chunk of this.world.chunks.values()) {
            for (let i = 0; i < chunk.blocks.length; i++) {
                const id = chunk.blocks[i]!
                const rule = RULES[id]
                const leaf = id === B.OakLeaves && !(chunk.meta[i]! & LEAVES_PLACED)
                if (!rule && !leaf && !GROWS.has(id) && id !== B.Fire) continue
                const lx = i % 16, lz = Math.floor(i / 16) % 16, y = Math.floor(i / 256)
                const x = chunk.cx * 16 + lx, z = chunk.cz * 16 + lz
                if (id === B.Fire) {
                    this.fires.add(packKey(x, y, z))
                    this.scheduleOnce(packKey(x, y, z), 30 + Math.floor(this.roll() * 10))
                    continue
                }
                if (GROWS.has(id)) {
                    this.startGrowing(id, x, y, z)
                    continue
                }
                if (id === B.Lava) this.scheduleOnce(`h:${x},${y},${z}`, 60 + Math.floor(this.roll() * 140))
                this.schedule(x, y, z, rule ? rule.delay : this.leafDelay())
            }
        }
    }

    /** Runs one game tick. */
    step() {
        this.tick++
        const due = this.scheduled.get(this.tick)
        if (!due) return
        this.scheduled.delete(this.tick)
        for (const key of due) {
            this.pending.delete(key)
            if (key.startsWith('h:')) {
                const [hx, hy, hz] = key.slice(2).split(',').map(Number) as [number, number, number]
                this.lavaHeat(hx, hy, hz)
                continue
            }
            if (key.startsWith('g:')) {
                const [gx, gy, gz] = key.slice(2).split(',').map(Number) as [number, number, number]
                this.grow(gx, gy, gz)
                continue
            }
            const [x, y, z] = key.split(',').map(Number) as [number, number, number]
            const id = this.world.get(x, y, z)
            if (id === B.Fire) this.updateFire(x, y, z)
            else if (id === B.OakLeaves) this.updateLeaf(x, y, z)
            else if (PLANTS.has(id)) this.checkSupport(id, x, y, z)
            else this.updateFluid(x, y, z)
        }
    }

    /** Runs `ticks` game ticks as fast as possible (offline catch-up, tests). */
    run(ticks: number) {
        for (let i = 0; i < ticks; i++) this.step()
    }

    /** The block a generator forms: cobblestone, or an ore with the upgrade's odds. */
    private generated(): number {
        const odds = ORE_LEVELS[Math.min(this.oreLevel, ORE_LEVELS.length - 1)]!
        let r = this.roll()
        const pick: [number, number][] = [[B.DiamondOre, odds.diamond], [B.GoldOre, odds.gold], [B.IronOre, odds.iron], [B.CoalOre, odds.coal]]
        for (const [id, chance] of pick) {
            if (r < chance) return id
            r -= chance
        }
        return B.Cobblestone
    }

    /** Lava hardened at (x, y, z) into `id` (the generator's fizz). Not fired while catching up offline. */
    onForm: ((x: number, y: number, z: number, id: number) => void) | null = null

    private form(x: number, y: number, z: number, id: number) {
        this.world.set(x, y, z, id)
        this.formed.set(id, (this.formed.get(id) ?? 0) + 1)
        this.onForm?.(x, y, z, id)
    }

    private touchesWater(x: number, y: number, z: number) {
        for (const [dx, dy, dz] of AROUND) if (this.world.get(x + dx, y + dy, z + dz) === B.Water) return true
        return false
    }

    private updateFluid(x: number, y: number, z: number) {
        const w = this.world
        const id = w.get(x, y, z)
        if (!isFluid(id)) return
        const rule = RULES[id]!
        let meta = w.meta(x, y, z)

        // Lava meeting water hardens: a source into obsidian, flowing lava into cobblestone.
        if (id === B.Lava && this.touchesWater(x, y, z)) {
            if ((meta & 7) === 0 && !(meta & FALLING)) {
                w.set(x, y, z, B.Obsidian)
                this.onForm?.(x, y, z, B.Obsidian)
            } else {
                this.form(x, y, z, this.generated())
            }
            return
        }

        // A flowing block re-reads its level from what feeds it, and dries up without a feed.
        const source = (meta & 7) === 0 && !(meta & FALLING)
        if (!source) {
            let next: number
            if (w.get(x, y + 1, z) === id) {
                next = FALLING
            } else {
                let best = Infinity, sources = 0
                for (const [dx, , dz] of SIDES) {
                    if (w.get(x + dx, y, z + dz) !== id) continue
                    const m = w.meta(x + dx, y, z + dz)
                    if ((m & 7) === 0 && !(m & FALLING)) sources++
                    best = Math.min(best, m & FALLING ? 0 : m & 7)
                }
                // Two water sources side by side fill the gap between them (infinite water).
                const below = w.get(x, y - 1, z)
                if (id === B.Water && sources >= 2 && (below !== B.Air && !replaceable(below))) {
                    next = 0
                } else {
                    next = best + rule.step
                    if (next > rule.max) {
                        w.set(x, y, z, B.Air)
                        return
                    }
                }
            }
            if (next !== meta) {
                w.setMeta(x, y, z, next)
                meta = next
            }
        }

        // Down first: an open drop takes the flow (sources keep spreading sideways too).
        const below = w.get(x, y - 1, z)
        const canFall = y > 0 && w.ownsAt(x, y - 1, z) && (replaceable(below) || (below === id && !isSource(w.meta(x, y - 1, z))))
        if (canFall && below !== id) {
            this.flowInto(x, y - 1, z, id, FALLING)
            if (!source) return
        } else if (canFall) {
            if (!source) return
        }

        // Over the void (the bottom of the world, or a cube you don't own) flowing
        // fluid drains away instead of pooling there, and a source doesn't spread.
        if (y === 0 || !w.ownsAt(x, y - 1, z)) {
            if (!source) w.set(x, y, z, B.Air)
            return
        }

        // Then sideways, one level weaker per block.
        const level = meta & FALLING ? 0 : meta & 7
        const next = level + rule.step
        if (next > rule.max) return
        for (const [dx, , dz] of SIDES) {
            const nx = x + dx, nz = z + dz
            const there = w.get(nx, y, nz)
            if (there === id) {
                const m = w.meta(nx, y, nz)
                if (!(m & FALLING) && (m & 7) > next) w.setMeta(nx, y, nz, next)
            } else if (replaceable(there) && w.ownsAt(nx, y, nz)) {
                this.flowInto(nx, y, nz, id, next)
            }
        }
    }

    /** Fluid moves into a cell; lava flowing in beside water forms stone there instead (the generator). */
    private flowInto(x: number, y: number, z: number, id: number, meta: number) {
        if (id === B.Lava && this.touchesWater(x, y, z)) {
            this.form(x, y, z, this.generated())
            return
        }
        if (id === B.Water && this.world.get(x, y, z) === B.Lava) return
        this.world.set(x, y, z, id, meta)
    }
}
