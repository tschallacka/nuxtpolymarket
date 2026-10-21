import { randomFloat } from '#shared/utils/random'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { B, block, FURNACES, isFluid, isSlab, occludesWith, replaceable, SLAB_DOUBLE, TORCH_WALL } from './blocks'
import { FUEL, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, smeltResult } from './furnace'
import { item, type Slots } from './items'
import type { Island } from './island'

/*
 * Redstone, Minecraft's rules. Power runs 0 to 15. Dust carries it, a level
 * less each block, links up with dust around it (and a step up or down), and
 * powers the block under it and the blocks it points into. Solid blocks
 * carry power on to what touches them: strongly (from a lever or button on
 * them, a torch under them, a repeater or observer pointing in) so that dust
 * picks it up too, or weakly (dust pointing in) so that only mechanisms do.
 *
 * Levers, buttons and redstone torches make power; repeaters delay and
 * restore it and lock from the side; observers pulse when what they watch
 * changes; pistons push (and sticky ones pull); droppers, dispensers and the
 * block breaker act on a rising signal; hoppers move items and stop while
 * powered.
 *
 * Changes are queued and settled each tick, in the order they came, until
 * nothing more changes; the things Minecraft delays (torches, repeaters,
 * buttons, observers, droppers) are scheduled ticks later.
 *
 * Meta bytes:
 *   dust        bits 0-3 power, 4-7 which sides it links to (N, E, S, W)
 *   torch       bits 0-2 where it hangs (0 floor, 1-4 a wall, as TORCH_WALL), bit 3 off
 *   lever/button bits 0-2 the face it is on (0 floor, 1-4 a wall, 5 ceiling), bit 3 on
 *   repeater    bits 0-1 which way the signal goes, 2-3 delay - 1, bit 4 powered, bit 5 locked
 *   observer    bits 0-2 which way its face looks (DIRS), bit 3 pulsing (out of its back)
 *   piston      bits 0-2 which way it pushes, bit 3 extended; head: bits 0-2, bit 3 sticky
 *   dropper, dispenser, block breaker: bits 0-2 facing, bit 3 triggered
 *   hopper      bits 0-2 where it outputs (any but up), bit 3 locked (powered)
 */

export type Vec = [number, number, number]

/** The six directions: north, east, south, west, up, down. */
export const DIRS: Vec[] = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
export const UP = 4
export const DOWN = 5
export const opposite = (d: number) => (d < 4 ? (d + 2) % 4 : d === UP ? DOWN : UP)
/** A horizontal direction index (0..3) from a step (dx, dz). */
const dirOf = (dx: number, dz: number) => DIRS.findIndex(([x, , z], i) => i < 4 && x === dx && z === dz)

export const MAX_POWER = 15
/** Repeater meta. */
export const REP_POWERED = 16
export const REP_LOCKED = 32
/** Most blocks a piston pushes. */
export const PUSH_LIMIT = 12
/** A hopper moves an item every 8 ticks. */
export const HOPPER_COOLDOWN = 8
/** Slots: hopper 5, dropper and dispenser 9. */
export const HOPPER_SLOTS = 5
export const DISPENSER_SLOTS = 9

/** Blocks that face one of six ways (bits 0-2 of their meta). */
/** Everything redstone that keeps a state of its own (looked at again after an old island loads). */
const REDSTONE_PARTS = new Set<number>([B.RedstoneDust, B.RedstoneTorch, B.Repeater, B.Observer, B.Button, B.Piston, B.StickyPiston,
    B.Dropper, B.Dispenser, B.BlockBreaker, B.Hopper])
/** What gives off power: a change in one of these reaches through the blocks it powers. */
const EMITTERS = new Set<number>([B.RedstoneDust, B.RedstoneTorch, B.Repeater, B.Observer, B.Lever, B.Button])
export const FACING6 = new Set<number>([B.Observer, B.Piston, B.StickyPiston, B.PistonHead, B.Dropper, B.Dispenser, B.BlockBreaker, B.Hopper])

/** What a piston can't move: these, and anything holding items, and a piston that is out. */
const IMMOVABLE = new Set<number>([B.Obsidian, B.Bedrock, B.PistonHead, B.Chest, B.SellChest, B.Barrel, B.Furnace, B.Smoker, B.BlastFurnace,
    B.Hopper, B.Dropper, B.Dispenser, B.BrewingStand, B.Lectern, B.Depot])

/** The direction (index into DIRS) a lever, button or wall torch's support is in. */
function supportDir(id: number, meta: number): number {
    const face = meta & 7
    if (id === B.RedstoneTorch) {
        if (face === 0) return DOWN
        const [dx, dz] = TORCH_WALL[(face - 1) & 3]!
        return dirOf(-dx, -dz)
    }
    if (face === 0) return DOWN
    if (face === 5) return UP
    const [dx, dz] = TORCH_WALL[(face - 1) & 3]!
    return dirOf(-dx, -dz)
}

export class Redstone {
    private queue: string[] = []
    private queued = new Set<string>()
    private scheduled = new Map<number, Set<string>>()
    private pending = new Set<string>()
    tick = 0

    /**
     * What is due, for the save: each scheduled tick as [ticks from now, what].
     * Minecraft saves these too: without them a reload drops an observer's
     * pending pulse, and a generator whose block was just formed waits forever.
     */
    toSave(): [number, string][] {
        const out: [number, string][] = []
        for (const [at, keys] of this.scheduled) for (const key of keys) out.push([Math.max(1, at - this.tick), key])
        return out
    }

    /**
     * For an island saved before its redstone ticks were, whose due ticks are
     * lost: every component looks at its inputs again, an observer caught
     * mid-pulse ends it (else it holds power for good, and what it drives
     * never sees the next rising edge), and every other observer pulses once (a
     * generator stalled on a lost pulse starts again).
     */
    restartAfterLoad() {
        for (const chunk of this.world.chunks.values()) {
            for (let i = 0; i < chunk.blocks.length; i++) {
                const id = chunk.blocks[i]!
                if (!REDSTONE_PARTS.has(id)) continue
                const x = chunk.cx * 16 + (i % 16), z = chunk.cz * 16 + (Math.floor(i / 16) % 16), y = Math.floor(i / 256)
                if (id === B.Observer) this.later(x, y, z, chunk.meta[i]! & 8 ? 'unpulse' : 'pulse', 2)
                else this.enqueue(x, y, z)
            }
        }
    }

    load(list: [number, string][] | undefined) {
        for (const [delay, key] of list ?? []) {
            if (!/^[a-z]+:-?\d+,-?\d+,-?\d+$/.test(key) || this.pending.has(key)) continue
            this.pending.add(key)
            const at = this.tick + Math.max(1, delay)
            let set = this.scheduled.get(at)
            if (!set) this.scheduled.set(at, set = new Set())
            set.add(key)
        }
    }

    /** Ticks until each hopper may move its next item. */
    private hopperCooldown = new Map<string, number>()
    /** Recent toggles of each torch, for burning out. */
    private torchToggles = new Map<string, number[]>()

    constructor(private readonly island: Island) {}

    private get world() {
        return this.island.world
    }

    // ── Updates ────────────────────────────────────────────────────────

    /** A block changed: it and its neighbours get a look this tick; an observer watching it notices. */
    changed(x: number, y: number, z: number) {
        this.enqueue(x, y, z)
        // A power source that changed also reaches through the blocks it powers (Minecraft
        // updates those blocks' neighbours too): dust on a block fires the dispenser under it.
        const source = EMITTERS.has(this.world.get(x, y, z))
        for (let d = 0; d < 6; d++) {
            const [dx, dy, dz] = DIRS[d]!
            const nx = x + dx, ny = y + dy, nz = z + dz
            this.enqueue(nx, ny, nz)
            // An observer whose face looks back at the change.
            if (this.world.get(nx, ny, nz) === B.Observer && (this.world.meta(nx, ny, nz) & 7) === opposite(d)) {
                this.later(nx, ny, nz, 'pulse', 2)
            }
            if (source && this.conductor(nx, ny, nz)) {
                for (const [ex, ey, ez] of DIRS) this.enqueue(nx + ex, ny + ey, nz + ez)
            }
        }
    }

    private enqueue(x: number, y: number, z: number) {
        const key = `${x},${y},${z}`
        if (this.queued.has(key)) return
        this.queued.add(key)
        this.queue.push(key)
    }

    /** Schedules `what` at (x, y, z) in `delay` ticks, unless that is already waiting. */
    private later(x: number, y: number, z: number, what: string, delay: number) {
        const key = `${what}:${x},${y},${z}`
        if (this.pending.has(key)) return
        this.pending.add(key)
        const at = this.tick + Math.max(1, delay)
        let set = this.scheduled.get(at)
        if (!set) this.scheduled.set(at, set = new Set())
        set.add(key)
    }

    /** One game tick: what was scheduled for now, the hoppers, then every queued update until it all settles. */
    step() {
        this.tick++
        const due = this.scheduled.get(this.tick)
        if (due) {
            this.scheduled.delete(this.tick)
            for (const key of due) {
                this.pending.delete(key)
                const [what, pos] = key.split(':') as [string, string]
                const [x, y, z] = pos.split(',').map(Number) as Vec
                this.scheduledTick(what, x, y, z)
            }
        }
        this.hoppers()
        this.settle()
    }

    /** Runs queued updates until none are left (bounded, so a broken loop can't hang the game). */
    settle() {
        let guard = 20000
        while (this.queue.length && guard-- > 0) {
            const key = this.queue.shift()!
            this.queued.delete(key)
            const [x, y, z] = key.split(',').map(Number) as Vec
            this.update(x, y, z)
        }
        if (guard <= 0) {
            this.queue = []
            this.queued.clear()
        }
    }

    private update(x: number, y: number, z: number) {
        const w = this.world
        const id = w.get(x, y, z)
        switch (id) {
            case B.RedstoneDust: return this.updateDust(x, y, z)
            case B.RedstoneTorch: {
                const lit = !(w.meta(x, y, z) & 8)
                if (lit === this.torchShouldBeLit(x, y, z)) return
                return this.later(x, y, z, 'torch', 2)
            }
            case B.Repeater: return this.updateRepeater(x, y, z)
            case B.Piston:
            case B.StickyPiston: return this.updatePiston(x, y, z)
            case B.Dropper:
            case B.Dispenser:
            case B.BlockBreaker: {
                const meta = w.meta(x, y, z)
                const on = this.inputPower(x, y, z) > 0
                if (on && !(meta & 8)) {
                    w.setMeta(x, y, z, meta | 8)
                    this.later(x, y, z, 'fire', 4)
                } else if (!on && meta & 8) {
                    w.setMeta(x, y, z, meta & ~8)
                }
                return
            }
            case B.Hopper: {
                const meta = w.meta(x, y, z)
                const locked = this.inputPower(x, y, z) > 0
                if (locked !== !!(meta & 8)) w.setMeta(x, y, z, locked ? meta | 8 : meta & ~8)
            }
        }
    }

    private scheduledTick(what: string, x: number, y: number, z: number) {
        const w = this.world
        const id = w.get(x, y, z)
        const meta = w.meta(x, y, z)
        switch (what) {
            case 'torch': {
                if (id !== B.RedstoneTorch) return
                const lit = this.torchShouldBeLit(x, y, z)
                if (lit === !(meta & 8)) return
                // Flickered more than 8 times in 3 seconds: it burns out for a while (Minecraft's burnout).
                const key = `${x},${y},${z}`
                const times = (this.torchToggles.get(key) ?? []).filter(t => this.tick - t < 60)
                times.push(this.tick)
                this.torchToggles.set(key, times)
                if (lit && times.length > 8) {
                    this.later(x, y, z, 'relight', 160)
                    return
                }
                w.setMeta(x, y, z, lit ? meta & ~8 : meta | 8)
                return
            }
            case 'relight':
                this.torchToggles.delete(`${x},${y},${z}`)
                return this.enqueue(x, y, z)
            case 'repeater': {
                if (id !== B.Repeater || meta & REP_LOCKED) return
                const input = this.repeaterInput(x, y, z) > 0
                const powered = !!(meta & REP_POWERED)
                if (powered && !input) w.setMeta(x, y, z, meta & ~REP_POWERED)
                else if (!powered) {
                    w.setMeta(x, y, z, meta | REP_POWERED)
                    // A pulse shorter than the delay still comes out at least the delay long.
                    if (!input) this.later(x, y, z, 'repeater', this.repeaterDelay(meta))
                }
                return
            }
            case 'button':
                if (id === B.Button && meta & 8) w.setMeta(x, y, z, meta & ~8)
                return
            case 'pulse':
                if (id !== B.Observer) return
                if (!(meta & 8)) {
                    w.setMeta(x, y, z, meta | 8)
                    this.later(x, y, z, 'unpulse', 2)
                }
                return
            case 'unpulse':
                if (id === B.Observer && meta & 8) w.setMeta(x, y, z, meta & ~8)
                return
            case 'fire':
                if (id === B.Dropper) return this.drop(x, y, z, false)
                if (id === B.Dispenser) return this.drop(x, y, z, true)
                if (id === B.BlockBreaker) return this.breakInFront(x, y, z)
        }
    }

    // ── Power ──────────────────────────────────────────────────────────

    /** Whether a block carries power on (an opaque full block, not a piston, observer or the like). */
    conductor(x: number, y: number, z: number) {
        const id = this.world.get(x, y, z)
        if (id === B.Piston || id === B.StickyPiston || id === B.Observer || id === B.Hopper) return false
        return occludesWith(id, this.world.meta(x, y, z))
    }

    /**
     * The power the block at (x, y, z) gives the neighbour in direction `d`.
     * `strong`: only what powers that neighbour strongly (so that dust beyond it picks it up).
     */
    emits(x: number, y: number, z: number, d: number, strong: boolean): number {
        const w = this.world
        const id = w.get(x, y, z)
        const meta = w.meta(x, y, z)
        switch (id) {
            case B.Lever:
            case B.Button:
                if (!(meta & 8)) return 0
                return !strong || d === supportDir(id, meta) ? MAX_POWER : 0
            case B.RedstoneTorch:
                if (meta & 8) return 0
                // Not into what it hangs on; strongly only into the block above.
                if (d === supportDir(id, meta)) return 0
                return !strong || d === UP ? MAX_POWER : 0
            case B.Repeater:
                return meta & REP_POWERED && d === (meta & 3) ? MAX_POWER : 0
            case B.Observer:
                return meta & 8 && d === opposite(meta & 7) ? MAX_POWER : 0
            case B.RedstoneDust:
                if (strong || d === UP) return 0
                return d === DOWN || this.dustPoints(meta, d) ? meta & 15 : 0
            default:
                return 0
        }
    }

    /**
     * Power a solid block at (x, y, z) holds, Minecraft's way: strongly from
     * what powers it so (a lever or button on it, a torch under it, a repeater
     * or observer pointing in), or, unless `strongOnly`, from dust pointing
     * into it too (which mechanisms feel, but dust doesn't pick up again). A
     * lever beside a block, not on it, doesn't power it.
     */
    blockPower(x: number, y: number, z: number, strongOnly: boolean): number {
        if (!this.conductor(x, y, z)) return 0
        let best = 0
        for (let d = 0; d < 6; d++) {
            const [dx, dy, dz] = DIRS[d]!
            const nx = x + dx, ny = y + dy, nz = z + dz
            let q = this.emits(nx, ny, nz, opposite(d), true)
            if (!strongOnly && this.world.get(nx, ny, nz) === B.RedstoneDust) q = Math.max(q, this.emits(nx, ny, nz, opposite(d), false))
            if (q > best) best = q
        }
        return best
    }

    /**
     * The power a mechanism at (x, y, z) receives (a piston, a dropper, a
     * hopper): from anything next to it that gives power that way, or a solid
     * block next to it that is powered.
     */
    inputPower(x: number, y: number, z: number, skip = -1): number {
        let best = 0
        for (let d = 0; d < 6; d++) {
            if (d === skip) continue
            const [dx, dy, dz] = DIRS[d]!
            const nx = x + dx, ny = y + dy, nz = z + dz
            best = Math.max(best, this.emits(nx, ny, nz, opposite(d), false), this.blockPower(nx, ny, nz, false))
            if (best >= MAX_POWER) break
        }
        return best
    }

    /** A redstone torch is lit unless the block it is on is powered. */
    private torchShouldBeLit(x: number, y: number, z: number) {
        const meta = this.world.meta(x, y, z)
        const [dx, dy, dz] = DIRS[supportDir(B.RedstoneTorch, meta)]!
        return this.blockPower(x + dx, y + dy, z + dz, false) === 0
    }

    // ── Dust ───────────────────────────────────────────────────────────

    /** Which of the four sides dust powers: the sides it links to (a line both ways, nothing linked: all four). */
    private dustPoints(meta: number, d: number) {
        if (d >= 4) return false
        const mask = (meta >> 4) & 15
        if (mask === 0) return true
        const bits = [1, 2, 4, 8].filter(b => mask & b)
        if (bits.length === 1) return bits[0] === 1 << d || bits[0] === 1 << opposite(d)
        return !!(mask & (1 << d))
    }

    /** Dust next to dust: on the same level, a step down past an open side, or a step up when nothing sits on it. */
    private dustNeighbours(x: number, y: number, z: number): Vec[] {
        const w = this.world
        const out: Vec[] = []
        const roofed = this.conductor(x, y + 1, z)
        for (let d = 0; d < 4; d++) {
            const [dx, , dz] = DIRS[d]!
            const nx = x + dx, nz = z + dz
            if (w.get(nx, y, nz) === B.RedstoneDust) out.push([nx, y, nz])
            else if (!this.conductor(nx, y, nz) && w.get(nx, y - 1, nz) === B.RedstoneDust) out.push([nx, y - 1, nz])
            else if (!roofed && this.conductor(nx, y, nz) && w.get(nx, y + 1, nz) === B.RedstoneDust) out.push([nx, y + 1, nz])
        }
        return out
    }

    /** Which sides dust links to, for its look and for what it powers. */
    private dustMask(x: number, y: number, z: number) {
        const w = this.world
        let mask = 0
        const roofed = this.conductor(x, y + 1, z)
        for (let d = 0; d < 4; d++) {
            const [dx, , dz] = DIRS[d]!
            const nx = x + dx, nz = z + dz
            const id = w.get(nx, y, nz)
            const meta = w.meta(nx, y, nz)
            const links = id === B.RedstoneDust
                || (!this.conductor(nx, y, nz) && w.get(nx, y - 1, nz) === B.RedstoneDust)
                || (!roofed && this.conductor(nx, y, nz) && w.get(nx, y + 1, nz) === B.RedstoneDust)
                || id === B.RedstoneTorch || id === B.Lever || id === B.Button
                || (id === B.Repeater && ((meta & 3) === d || (meta & 3) === opposite(d)))
                || (id === B.Observer && opposite(meta & 7) === opposite(d))
            if (links) mask |= 1 << d
        }
        return mask
    }

    /** Power coming into a piece of dust from anything but other dust. */
    private dustInput(x: number, y: number, z: number) {
        let best = 0
        for (let d = 0; d < 6; d++) {
            const [dx, dy, dz] = DIRS[d]!
            const nx = x + dx, ny = y + dy, nz = z + dz
            if (this.world.get(nx, ny, nz) === B.RedstoneDust) continue
            best = Math.max(best, this.emits(nx, ny, nz, opposite(d), false), this.blockPower(nx, ny, nz, true))
        }
        return best
    }

    /**
     * Re-works the power of the whole stretch of dust (x, y, z) belongs to:
     * each piece takes what feeds it directly or one less than its brightest
     * neighbour, whichever is more.
     */
    private updateDust(x: number, y: number, z: number) {
        const w = this.world
        const net = new Map<string, Vec>()
        const stack: Vec[] = [[x, y, z]]
        while (stack.length && net.size < 4096) {
            const p = stack.pop()!
            const key = p.join(',')
            if (net.has(key) || w.get(...p) !== B.RedstoneDust) continue
            net.set(key, p)
            for (const n of this.dustNeighbours(...p)) if (!net.has(n.join(','))) stack.push(n)
        }
        const power = new Map<string, number>()
        for (const [key, p] of net) power.set(key, this.dustInput(...p))
        // Spread from the brightest down, a level per step.
        const order = [...net.keys()].sort((a, b) => power.get(b)! - power.get(a)!)
        const queue = [...order]
        while (queue.length) {
            const key = queue.shift()!
            const level = power.get(key)!
            if (level <= 1) continue
            for (const n of this.dustNeighbours(...net.get(key)!)) {
                const nk = n.join(',')
                if (!net.has(nk) || power.get(nk)! >= level - 1) continue
                power.set(nk, level - 1)
                queue.push(nk)
            }
        }
        for (const [key, p] of net) {
            const meta = (this.dustMask(...p) << 4) | power.get(key)!
            if (w.meta(...p) !== meta) w.setMeta(...p, meta)
        }
    }

    // ── Repeaters ──────────────────────────────────────────────────────

    /** Game ticks of delay (1 to 4 redstone ticks, 2 game ticks each). */
    private repeaterDelay(meta: number) {
        return (((meta >> 2) & 3) + 1) * 2
    }

    /** Power coming into a repeater's back. */
    private repeaterInput(x: number, y: number, z: number) {
        const back = opposite(this.world.meta(x, y, z) & 3)
        const [dx, , dz] = DIRS[back]!
        const bx = x + dx, bz = z + dz
        return Math.max(this.emits(bx, y, bz, opposite(back), false), this.blockPower(bx, y, bz, false))
    }

    private updateRepeater(x: number, y: number, z: number) {
        const w = this.world
        const meta = w.meta(x, y, z)
        // Locked by a powered repeater pointing into its side: it holds what it has.
        const facing = meta & 3
        const locked = [(facing + 1) % 4, (facing + 3) % 4].some((s) => {
            const [dx, , dz] = DIRS[s]!
            const nm = w.meta(x + dx, y, z + dz)
            return w.get(x + dx, y, z + dz) === B.Repeater && nm & REP_POWERED && (nm & 3) === opposite(s)
        })
        if (locked !== !!(meta & REP_LOCKED)) {
            w.setMeta(x, y, z, locked ? meta | REP_LOCKED : meta & ~REP_LOCKED)
            return
        }
        if (locked) return
        const input = this.repeaterInput(x, y, z) > 0
        if (input !== !!(meta & REP_POWERED)) this.later(x, y, z, 'repeater', this.repeaterDelay(meta))
    }

    /** Right click: the next delay (1, 2, 3, 4 redstone ticks, then back to 1). */
    cycleRepeater(x: number, y: number, z: number) {
        const meta = this.world.meta(x, y, z)
        const delay = (((meta >> 2) & 3) + 1) & 3
        this.world.setMeta(x, y, z, (meta & ~12) | (delay << 2))
        this.settle()
    }

    // ── Levers and buttons ─────────────────────────────────────────────

    /** Flips a lever (what it powers reacts at once, as in Minecraft). */
    toggleLever(x: number, y: number, z: number) {
        const meta = this.world.meta(x, y, z)
        this.world.setMeta(x, y, z, meta ^ 8)
        this.poweredAround(x, y, z)
        this.settle()
    }

    /** Presses a button: on for a second (a stone button's 20 ticks). */
    pressButton(x: number, y: number, z: number) {
        const meta = this.world.meta(x, y, z)
        if (meta & 8) return
        this.world.setMeta(x, y, z, meta | 8)
        this.later(x, y, z, 'button', 20)
        this.poweredAround(x, y, z)
        this.settle()
    }

    /** A lever or button also wakes what is around the block it sits on (it powers that block strongly). */
    private poweredAround(x: number, y: number, z: number) {
        const [dx, dy, dz] = DIRS[supportDir(this.world.get(x, y, z), this.world.meta(x, y, z))]!
        this.changed(x + dx, y + dy, z + dz)
    }

    // ── Pistons ────────────────────────────────────────────────────────

    private updatePiston(x: number, y: number, z: number) {
        const w = this.world
        const meta = w.meta(x, y, z)
        const facing = meta & 7
        // Powered from any side but its face, or (quasi-connectivity) as if it stood a block higher.
        const powered = this.inputPower(x, y, z, facing) > 0 || this.inputPower(x, y + 1, z, DOWN) > 0
        const extended = !!(meta & 8)
        if (powered && !extended) this.extend(x, y, z)
        else if (!powered && extended) this.retract(x, y, z)
    }

    /** What a piston does to a block in its way: push it, break it (plants, torches, dust), or stop. */
    private pushReaction(x: number, y: number, z: number): 'empty' | 'push' | 'break' | 'stop' {
        const id = this.world.get(x, y, z)
        if (id === B.Air) return 'empty'
        if (y < 0 || y >= 64 || !this.world.ownsAt(x, y, z)) return 'stop'
        if (isFluid(id) || id === B.Fire) return 'break'
        if (IMMOVABLE.has(id)) return 'stop'
        if ((id === B.Piston || id === B.StickyPiston) && this.world.meta(x, y, z) & 8) return 'stop'
        const def = block(id)
        if (replaceable(id) || def.shape === 'cross' || def.shape === 'flat' || id === B.Torch || id === B.RedstoneTorch
            || id === B.Lever || id === B.Button || id === B.Repeater || id === B.Cactus || id === B.SugarCane
            // Melons and pumpkins break when pushed: how a melon farm harvests.
            || id === B.Melon || id === B.Pumpkin) return 'break'
        return def.pushable || isSlab(id) ? 'push' : 'stop'
    }

    private extend(x: number, y: number, z: number) {
        const w = this.world
        const meta = w.meta(x, y, z)
        const facing = meta & 7
        const [dx, dy, dz] = DIRS[facing]!
        const line: Vec[] = []
        let end: Vec | null = null
        for (let i = 1; i <= PUSH_LIMIT + 1; i++) {
            const p: Vec = [x + dx * i, y + dy * i, z + dz * i]
            const r = this.pushReaction(...p)
            if (r === 'stop') return
            if (r === 'empty' || r === 'break') {
                end = p
                break
            }
            line.push(p)
        }
        if (!end || line.length > PUSH_LIMIT) return
        // Whatever breaks at the end of the line drops as it would (fluids just go).
        if (w.get(...end) !== B.Air) {
            const id = w.get(...end)
            if (!isFluid(id) && id !== B.Fire) for (const s of this.island.breakBlock(...end, null, false)) this.island.drop(...end, s)
            else w.set(...end, B.Air)
        }
        for (let i = line.length - 1; i >= 0; i--) {
            const [px, py, pz] = line[i]!
            w.set(px + dx, py + dy, pz + dz, w.get(px, py, pz), w.meta(px, py, pz))
        }
        w.setMeta(x, y, z, meta | 8)
        w.set(x + dx, y + dy, z + dz, B.PistonHead, facing | (w.get(x, y, z) === B.StickyPiston ? 8 : 0))
    }

    private retract(x: number, y: number, z: number) {
        const w = this.world
        const meta = w.meta(x, y, z)
        const facing = meta & 7
        const [dx, dy, dz] = DIRS[facing]!
        const hx = x + dx, hy = y + dy, hz = z + dz
        w.setMeta(x, y, z, meta & ~8)
        if (w.get(hx, hy, hz) === B.PistonHead) w.set(hx, hy, hz, B.Air)
        // A sticky piston pulls back the block its head touched.
        if (w.get(x, y, z) !== B.StickyPiston) return
        const fx = hx + dx, fy = hy + dy, fz = hz + dz
        if (this.pushReaction(fx, fy, fz) !== 'push' || w.get(hx, hy, hz) !== B.Air) return
        w.set(hx, hy, hz, w.get(fx, fy, fz), w.meta(fx, fy, fz))
        w.set(fx, fy, fz, B.Air)
    }

    /** A piston head broken: its piston goes back in; a piston broken while out takes its head with it. */
    pistonPartBroken(x: number, y: number, z: number, id: number, meta: number) {
        const w = this.world
        const facing = meta & 7
        const [dx, dy, dz] = DIRS[facing]!
        if (id === B.PistonHead) {
            const bx = x - dx, by = y - dy, bz = z - dz
            const base = w.get(bx, by, bz)
            if ((base === B.Piston || base === B.StickyPiston) && w.meta(bx, by, bz) & 8) w.setMeta(bx, by, bz, w.meta(bx, by, bz) & ~8)
        } else if ((id === B.Piston || id === B.StickyPiston) && meta & 8 && w.get(x + dx, y + dy, z + dz) === B.PistonHead) {
            w.set(x + dx, y + dy, z + dz, B.Air)
        }
    }

    // ── Droppers, dispensers, the block breaker ────────────────────────

    /** Fires a dropper or dispenser: one item out of a random filled slot. */
    private drop(x: number, y: number, z: number, dispenser: boolean) {
        const box = this.island.containerAt(x, y, z)
        if (!box) return
        const filled = box.slots.map((s, i) => (s ? i : -1)).filter(i => i >= 0)
        if (!filled.length) return
        const i = filled[Math.floor(randomFloat() * filled.length)]!
        const stack = box.slots[i]!
        const facing = this.world.meta(x, y, z) & 7
        const [dx, dy, dz] = DIRS[facing]!
        const fx = x + dx, fy = y + dy, fz = z + dz
        if (dispenser && this.dispense(box, i, stack, fx, fy, fz, facing)) return
        // A dropper (or a dispenser with nothing special to do) passes one on into a container, or throws it out.
        if (!dispenser || !this.island.containerAt(fx, fy, fz)) {
            if (this.island.insert(fx, fy, fz, { item: stack.item, count: 1 }, opposite(facing)) === 0) {
                box.useOne(i)
                return
            }
            if (!dispenser && this.island.containerAt(fx, fy, fz)) return
        }
        box.useOne(i)
        this.island.drop(fx, fy, fz, { item: stack.item, count: 1 })
    }

    /** What a dispenser does with some items: pours and fills buckets, bone-meals, shoots arrows and throws potions. */
    private dispense(box: Slots, i: number, stack: ItemStack, fx: number, fy: number, fz: number, facing: number): boolean {
        const w = this.world
        const front = w.get(fx, fy, fz)
        if (stack.item === 'water_bucket' || stack.item === 'lava_bucket') {
            if (!w.ownsAt(fx, fy, fz) || !(front === B.Air || replaceable(front) || isFluid(front))) return false
            w.set(fx, fy, fz, stack.item === 'water_bucket' ? B.Water : B.Lava, 0)
            box.slots[i] = { item: 'bucket', count: 1 }
            return true
        }
        if (stack.item === 'bucket') {
            if (!isFluid(front) || (w.meta(fx, fy, fz) & 15) !== 0) return false
            w.set(fx, fy, fz, B.Air)
            box.useOne(i)
            const filled = front === B.Water ? 'water_bucket' : 'lava_bucket'
            if (box.add(filled, 1) > 0) this.island.drop(fx, fy, fz, { item: filled, count: 1 })
            return true
        }
        if (stack.item === 'bone_meal') {
            if (this.island.sim.boneMeal(fx, fy, fz)) box.useOne(i)
            return true
        }
        const [dx, dy, dz] = DIRS[facing]!
        const cx = fx + 0.5 - dx * 0.3, cy = fy + 0.5 - dy * 0.3, cz = fz + 0.5 - dz * 0.3
        if (stack.item === 'arrow') {
            this.island.mobs.launchArrow(cx, cy, cz, dx, dy + 0.1, dz, 1.1, 6)
            box.useOne(i)
            return true
        }
        if (stack.item.startsWith('splash_potion_')) {
            this.island.mobs.launch(stack.item.slice('splash_potion_'.length) as never, cx, cy, cz, dx, dy + 0.1, dz, 1.375, -2)
            box.useOne(i)
            return true
        }
        return false
    }

    /** The block breaker: mines what is in front of it as an iron pickaxe would, and drops it there. */
    private breakInFront(x: number, y: number, z: number) {
        const facing = this.world.meta(x, y, z) & 7
        const [dx, dy, dz] = DIRS[facing]!
        const fx = x + dx, fy = y + dy, fz = z + dz
        const id = this.world.get(fx, fy, fz)
        if (id === B.Air || isFluid(id) || !Number.isFinite(block(id).hardness) || this.island.containerAt(fx, fy, fz)) return
        for (const s of this.island.breakBlock(fx, fy, fz, 'iron_pickaxe', false)) this.island.drop(fx, fy, fz, s)
    }

    // ── Hoppers ────────────────────────────────────────────────────────

    /** Every hopper not locked by power moves one item every 8 ticks: in from above, out where it points. */
    private hoppers() {
        for (const key of this.island.hopperSites) {
            const left = (this.hopperCooldown.get(key) ?? 0) - 1
            if (left > 0) {
                this.hopperCooldown.set(key, left)
                continue
            }
            this.hopperCooldown.delete(key)
            const [x, y, z] = key.split(',').map(Number) as Vec
            const meta = this.world.meta(x, y, z)
            if (meta & 8) continue
            const box = this.island.containerAt(x, y, z)
            if (!box) continue
            let moved = false
            // Out: the first item it holds, one at a time, into what it points at.
            const out = meta & 7
            const [dx, dy, dz] = DIRS[out]!
            for (let i = 0; i < box.slots.length; i++) {
                const s = box.slots[i]
                if (!s) continue
                if (this.island.insert(x + dx, y + dy, z + dz, { item: s.item, count: 1 }, opposite(out)) === 0) {
                    box.useOne(i)
                    moved = true
                    break
                }
            }
            // In: one item from what sits above.
            const taken = this.island.extract(x, y + 1, z, DOWN, box)
            if (taken) moved = true
            if (moved) this.hopperCooldown.set(key, HOPPER_COOLDOWN)
        }
    }
}

/**
 * Where an item goes into a container from a given side (Minecraft's
 * rules): into a furnace from above to smelt, from the side as fuel; a
 * composter composts. Returns the slot to put it in, or -1 for any slot.
 */
export function furnaceSlotFor(kind: Parameters<typeof smeltResult>[0], key: string, fromSide: number) {
    if (fromSide === UP) return smeltResult(kind, key) ? FURNACE_INPUT : null
    if (fromSide === DOWN) return null
    return FUEL[key] ? FURNACE_FUEL : null
}

export { FURNACE_OUTPUT, FURNACES, SLAB_DOUBLE, item }
