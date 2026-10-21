import { B, lightOf, opacityOf } from './blocks'
import { CHUNK, HEIGHT, type World } from './world'

export { lightOf, opacityOf }

/*
 * Light, as Minecraft has it: levels 0 to 15 in two kinds. Sky light pours
 * straight down from open sky at 15 and spreads sideways and into hollows,
 * one level less per block; block light spreads the same way from what
 * glows (torches, lava, fire, glowstone). The renderer shows the brighter of
 * the two, with sky light dimmed by the time of day.
 *
 * Worked out per chunk with a margin of 15 blocks around it (as far as light
 * reaches), so a chunk's light is right without keeping light for the whole
 * island in step with every change.
 */

export const MAX_LIGHT = 15
const MARGIN = 15

/** Light for a chunk and the margin around it: sky and block levels per cell. */
export class LightField {
    readonly w = CHUNK + 2 * MARGIN
    readonly sky: Uint8Array
    readonly block: Uint8Array
    readonly ox: number
    readonly oz: number

    constructor(readonly cx: number, readonly cz: number) {
        this.ox = cx * CHUNK - MARGIN
        this.oz = cz * CHUNK - MARGIN
        this.sky = new Uint8Array(this.w * this.w * HEIGHT)
        this.block = new Uint8Array(this.w * this.w * HEIGHT)
    }

    /** Index of world cell (x, y, z), or -1 outside the field. */
    index(x: number, y: number, z: number) {
        const lx = x - this.ox, lz = z - this.oz
        if (lx < 0 || lz < 0 || lx >= this.w || lz >= this.w || y < 0 || y >= HEIGHT) return -1
        return (y * this.w + lz) * this.w + lx
    }

    /** Sky and block light at (x, y, z); above the world is open sky, outside the field unknown (full sky). */
    at(x: number, y: number, z: number): [number, number] {
        if (y >= HEIGHT) return [MAX_LIGHT, 0]
        const i = this.index(x, y, z)
        return i < 0 ? [MAX_LIGHT, 0] : [this.sky[i]!, this.block[i]!]
    }
}

const STEPS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

/** Works out the light for chunk (cx, cz) and its margin. */
export function computeLight(world: World, cx: number, cz: number): LightField {
    const f = new LightField(cx, cz)
    const { w } = f
    const n = w * w * HEIGHT
    const opacity = new Uint8Array(n)
    // One pass over the region: what holds light back, and what gives it off.
    const queue = new Int32Array(n)
    let head = 0, tail = 0
    for (let y = 0; y < HEIGHT; y++) {
        for (let lz = 0; lz < w; lz++) {
            for (let lx = 0; lx < w; lx++) {
                const x = f.ox + lx, z = f.oz + lz
                const id = world.get(x, y, z)
                if (id === B.Air) continue
                const meta = world.meta(x, y, z)
                const i = (y * w + lz) * w + lx
                opacity[i] = opacityOf(id, meta)
                const glow = lightOf(id, meta)
                if (glow) f.block[i] = glow
            }
        }
    }
    // Sky light: straight down each column, at full strength until something holds it back.
    for (let lz = 0; lz < w; lz++) {
        for (let lx = 0; lx < w; lx++) {
            let level = MAX_LIGHT
            for (let y = HEIGHT - 1; y >= 0 && level > 0; y--) {
                const i = (y * w + lz) * w + lx
                level = Math.max(0, level - opacity[i]!)
                f.sky[i] = level
            }
        }
    }
    // Then both spread, one level less per step (plus whatever dims them on the way).
    for (const levels of [f.sky, f.block]) {
        // A ring buffer: a cell can be queued again when it gets brighter, so wrap both ends.
        head = tail = 0
        for (let i = 0; i < n; i++) if (levels[i]! > 1) queue[tail++] = i
        while (head < tail) {
            const i = queue[head++ % n]!
            const level = levels[i]!
            const lx = i % w, lz = Math.floor(i / w) % w, y = Math.floor(i / (w * w))
            for (const [dx, dy, dz] of STEPS) {
                const nx = lx + dx, ny = y + dy, nz = lz + dz
                if (nx < 0 || nz < 0 || nx >= w || nz >= w || ny < 0 || ny >= HEIGHT) continue
                const j = (ny * w + nz) * w + nx
                const op = opacity[j]!
                if (op >= MAX_LIGHT) continue
                const next = level - 1 - op
                if (next > levels[j]!) {
                    levels[j] = next
                    if (next > 1) queue[tail++ % n] = j
                }
            }
        }
    }
    return f
}

/**
 * Light for the simulation (mob spawning, grass, burning undead): each
 * chunk's field, worked out when first asked for and again only after the
 * chunk (or a light change next to it) moved its revision.
 */
export class LightCache {
    private fields = new Map<string, { rev: number, field: LightField }>()

    constructor(private readonly world: World) {}

    /**
     * Sky and block light at (x, y, z). `slack` lets a field that many changes
     * out of date stand (grass spreading doesn't need the light exact, and a
     * busy generator would otherwise have its chunk's light redone every tick).
     */
    at(x: number, y: number, z: number, slack = 0): [number, number] {
        if (y >= HEIGHT) return [MAX_LIGHT, 0]
        const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK)
        const key = `${cx},${cz}`
        // Outside owned land is open void: daylight, nothing glowing.
        if (!this.world.chunks.has(key)) return [MAX_LIGHT, 0]
        const rev = this.world.revisions.get(key) ?? 0
        let entry = this.fields.get(key)
        if (!entry || rev - entry.rev > slack) {
            entry = { rev, field: computeLight(this.world, cx, cz) }
            this.fields.set(key, entry)
        }
        return entry.field.at(x, y, z)
    }
}
