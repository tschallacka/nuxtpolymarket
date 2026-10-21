import { B, block, solidRange } from './blocks'
import { fluidFlow } from './sim'
import type { World } from './world'

/*
 * The player as Minecraft has it: a 0.6 x 1.8 box, eyes at 1.62, gravity,
 * a jump of a little over a block, slower in water. Collision sweeps the box
 * against the voxel grid one axis at a time, sampling the world directly, so
 * placing or breaking a block needs no collision rebuild.
 */

export const HALF_WIDTH = 0.3
export const HEIGHT = 1.8
export const EYE = 1.62
const GRAVITY = 32
const JUMP = 9
const WALK = 4.3
const SPRINT = 5.6
const SWIM = 2.2
const SNEAK = 1.3
/** The upward kick that lifts you out of water onto a bank (Minecraft's 0.3 a tick). */
const WATER_HOP = 6
/** How fast flowing water carries you, blocks a second. */
const FLOW_PUSH = 1.4
/** Creative flight, Minecraft's: about 10.9 blocks a second, twice that sprinting, 7.5 up or down. */
const FLY = 10.9
const FLY_SPRINT = 21.8
const FLY_RISE = 7.5
const FLY_ACCEL = 6
/** How far down a sneaking player still counts as standing on something (Minecraft's step height). */
const SNEAK_DROP = 0.6
/** Eye height while sneaking. */
export const SNEAK_EYE = 1.27

export interface Body {
    x: number
    y: number
    z: number
    vx: number
    vy: number
    vz: number
    onGround: boolean
    inWater: boolean
    /** Last step ran into a wall, in this direction (x, z): for climbing out of water. */
    hitWall?: [number, number] | null
}

/** The solid part of a cell as world heights [y0, y1], or null (a slab fills only half its cell). */
function solidSpan(world: World, x: number, y: number, z: number): [number, number] | null {
    const r = solidRange(world.get(x, y, z), world.meta(x, y, z))
    return r ? [y + r[0], y + r[1]] : null
}

/** Whether the body's box at (x, y, z) overlaps any solid block. */
export function overlaps(world: World, x: number, y: number, z: number) {
    for (let bx = Math.floor(x - HALF_WIDTH); bx <= Math.floor(x + HALF_WIDTH - 1e-6); bx++) {
        for (let by = Math.floor(y); by <= Math.floor(y + HEIGHT - 1e-6); by++) {
            for (let bz = Math.floor(z - HALF_WIDTH); bz <= Math.floor(z + HALF_WIDTH - 1e-6); bz++) {
                const s = solidSpan(world, bx, by, bz)
                if (s && s[0] < y + HEIGHT - 1e-6 && s[1] > y + 1e-6) return true
            }
        }
    }
    return false
}

/** Minecraft's step height: walking into something this low lifts you onto it. */
const STEP = 0.6

/** Whether there is something solid under the body's feet within `drop` blocks. */
function standsOn(world: World, x: number, y: number, z: number, drop: number) {
    for (let bx = Math.floor(x - HALF_WIDTH); bx <= Math.floor(x + HALF_WIDTH - 1e-6); bx++) {
        for (let bz = Math.floor(z - HALF_WIDTH); bz <= Math.floor(z + HALF_WIDTH - 1e-6); bz++) {
            for (let by = Math.floor(y - drop); by <= Math.floor(y - 1e-3); by++) {
                const s = solidSpan(world, bx, by, bz)
                if (s && s[1] >= y - drop && s[0] < y) return true
            }
        }
    }
    return false
}

/**
 * One physics step. `wish` is the desired horizontal direction (unit or zero)
 * in world x/z; `jump` holds the jump key; `sprint` runs; `sneak` creeps, and
 * a sneaking player on the ground won't step off an edge (Minecraft's sneak).
 */
/**
 * One step of the body. `fly`: creative flight (development only): no gravity,
 * jump rises and sneak sinks, and you go a good deal faster; still blocked by
 * walls like walking.
 */
export function stepBody(world: World, b: Body, dt: number, wish: [number, number], jump: boolean, sprint: boolean, sneak = false, fly = false) {
    const feet = world.get(Math.floor(b.x), Math.floor(b.y + 0.2), Math.floor(b.z))
    const chest = world.get(Math.floor(b.x), Math.floor(b.y + 1.1), Math.floor(b.z))
    b.inWater = feet === B.Water || chest === B.Water || feet === B.Lava
    if (fly) {
        const k = Math.min(1, dt * FLY_ACCEL)
        const speed = sprint ? FLY_SPRINT : FLY
        b.vx += (wish[0] * speed - b.vx) * k
        b.vz += (wish[1] * speed - b.vz) * k
        b.vy += ((jump ? FLY_RISE : 0) - (sneak ? FLY_RISE : 0) - b.vy) * k
        sneak = false
    }

    const speed = b.inWater ? SWIM : sneak ? SNEAK : sprint ? SPRINT : WALK
    // Flowing water (or lava) carries you along with it, about Minecraft's 1.4 blocks a second;
    // swimming against it still gets you somewhere.
    let carryX = 0, carryZ = 0
    if (b.inWater) {
        for (const cy of [Math.floor(b.y + 0.2), Math.floor(b.y + 1.1)]) {
            const [fx, fz] = fluidFlow(world, Math.floor(b.x), cy, Math.floor(b.z))
            carryX += fx
            carryZ += fz
        }
        const len = Math.hypot(carryX, carryZ)
        if (len > 0) {
            carryX = (carryX / len) * FLOW_PUSH
            carryZ = (carryZ / len) * FLOW_PUSH
        }
    }
    // Snappy on the ground, a little drift in the air.
    const accel = b.onGround ? 14 : 4
    const k = Math.min(1, dt * accel)
    if (!fly) {
        b.vx += (wish[0] * speed + carryX - b.vx) * k
        b.vz += (wish[1] * speed + carryZ - b.vz) * k
    }

    if (fly) {
        // Flying: no gravity, no swimming; the velocities were set above.
    } else if (b.inWater) {
        b.vy = jump ? Math.min(b.vy + 20 * dt, 3) : Math.max(b.vy - 10 * dt, -2.5)
        // Swimming into a bank with jump held: Minecraft's hop out of the water onto the
        // land above (0.3 a tick), when there is room for you 0.6 higher.
        if (jump && b.hitWall && !overlaps(world, b.x + b.hitWall[0] * 0.05, b.y + 0.6, b.z + b.hitWall[1] * 0.05)) b.vy = WATER_HOP
    } else {
        b.vy -= GRAVITY * dt
        if (jump && b.onGround) b.vy = JUMP
        b.vy = Math.max(b.vy, -60)
    }

    // Sweep each axis on its own, so you slide along walls.
    b.onGround = false
    b.hitWall = null
    const moveAxis = (axis: 'x' | 'y' | 'z', delta: number) => {
        const steps = Math.ceil(Math.abs(delta) / 0.4)
        for (let i = 0; i < steps; i++) {
            const d = delta / steps
            const before = b[axis]
            b[axis] += d
            // Sneaking on the ground: a sideways step that leaves nothing underfoot is refused.
            const offEdge = sneak && axis !== 'y' && b.onGround && !b.inWater && !standsOn(world, b.x, b.y, b.z, SNEAK_DROP)
            // Walking into a slab or another low step: lift onto it instead of stopping.
            if (!offEdge && axis !== 'y' && b.onGround && overlaps(world, b.x, b.y, b.z)) {
                for (let lift = 1 / 16; lift <= STEP + 1e-6; lift += 1 / 16) {
                    if (!overlaps(world, b.x, b.y + lift, b.z)) {
                        b.y += lift
                        break
                    }
                }
            }
            if (offEdge || overlaps(world, b.x, b.y, b.z)) {
                b[axis] = before
                if (axis === 'y') {
                    if (d < 0) b.onGround = true
                    b.vy = 0
                } else if (axis === 'x') {
                    if (!offEdge) b.hitWall = [Math.sign(d), 0]
                    b.vx = 0
                } else {
                    if (!offEdge) b.hitWall = [0, Math.sign(d)]
                    b.vz = 0
                }
                return
            }
        }
    }
    moveAxis('y', b.vy * dt)
    moveAxis('x', b.vx * dt)
    moveAxis('z', b.vz * dt)
}

export interface Hit {
    x: number
    y: number
    z: number
    /** The face it was hit on: place a block at (x + nx, y + ny, z + nz). */
    nx: number
    ny: number
    nz: number
    id: number
    /** Where exactly the ray hit (picks the slab half to place). */
    px: number
    py: number
    pz: number
}

/**
 * The first block along a ray (Amanatides & Woo voxel walk), skipping air
 * and, unless `fluids`, water and lava.
 */
export function pick(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number, fluids = false): Hit | null {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz)
    const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz)
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity
    let tx = dx !== 0 ? ((sx > 0 ? x + 1 - ox : ox - x) * tdx) : Infinity
    let ty = dy !== 0 ? ((sy > 0 ? y + 1 - oy : oy - y) * tdy) : Infinity
    let tz = dz !== 0 ? ((sz > 0 ? z + 1 - oz : oz - z) * tdz) : Infinity
    let nx = 0, ny = 0, nz = 0
    let t = 0
    const at = (u: number) => ({ px: ox + dx * u, py: oy + dy * u, pz: oz + dz * u })
    while (t <= reach) {
        const id = world.get(x, y, z)
        const def = block(id)
        if (id !== B.Air && (fluids || def.shape !== 'fluid')) {
            if (def.shape !== 'slab') return { x, y, z, nx, ny, nz, id, ...at(t) }
            // A slab: the ray may pass through its empty half; find where it meets the solid one.
            const r = solidRange(id, world.meta(x, y, z))!
            const lo = y + r[0], hi = y + r[1]
            const out = Math.min(tx, ty, tz)
            let enter = t, leave = out
            if (dy !== 0) {
                const a = (lo - oy) / dy, b = (hi - oy) / dy
                enter = Math.max(t, Math.min(a, b))
                leave = Math.min(out, Math.max(a, b))
            } else if (oy < lo || oy > hi) {
                enter = Infinity
            }
            if (enter <= leave && enter <= reach) {
                // Entered through the slab's flat face inside the cell, or through the cell's own face.
                return enter > t + 1e-9 ? { x, y, z, nx: 0, ny: -sy, nz: 0, id, ...at(enter) } : { x, y, z, nx, ny, nz, id, ...at(t) }
            }
        }
        if (tx < ty && tx < tz) {
            x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0
        } else if (ty < tz) {
            y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0
        } else {
            z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz
        }
    }
    return null
}
