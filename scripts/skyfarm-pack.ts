// Builds Skyfarm's block pack from an unzipped Minecraft resource pack.
//
//   bun scripts/skyfarm-pack.ts <unzipped pack dir>
//
// Reads the pack's blockstates and block models (Minecraft's JSON format:
// parent chains, texture variables, elements with per-face UVs and rotation,
// weighted random variants), resolves everything Skyfarm's blocks need, and
// writes public/skyfarm/pack/blocks.json plus the textures it uses. Where a
// pack leans on a vanilla model it doesn't ship (levers, repeaters, pistons,
// hoppers, the chest), a generic shape of our own below stands in, still
// painted with the pack's textures.
//
// The source pack is Pixel Perfection Legacy (XSSheep, continued by
// Nova_Wostra), CC BY-SA 4.0: public/skyfarm/pack/LICENSE.txt carries the
// credit, and the output is under the same license. The output was built from
// version 26.3-97.1, "Pixel Perfection 26.3-97.1.zip" on
// https://modrinth.com/resourcepack/pixel-perfection-legacy (sha512 starts 7e85d3c92706f329).

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { allItems } from '../app/utils/skyfarm/items'

// ── PNG, just enough to dye leather ─────────────────────────────────────

/** Decodes an 8-bit RGBA, non-interlaced PNG (what the pack's armour textures are). */
function readRgba(path: string) {
    const b = readFileSync(path)
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20)
    if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error(`${path}: not an 8-bit RGBA PNG`)
    const chunks: Buffer[] = []
    for (let i = 8; i < b.length;) {
        const len = b.readUInt32BE(i)
        if (b.toString('ascii', i + 4, i + 8) === 'IDAT') chunks.push(b.subarray(i + 8, i + 8 + len))
        i += 12 + len
    }
    const raw = inflateSync(Buffer.concat(chunks))
    const stride = w * 4
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)]!
        for (let x = 0; x < stride; x++) {
            const v = raw[y * (stride + 1) + 1 + x]!
            const a = x >= 4 ? data[y * stride + x - 4]! : 0
            const up = y > 0 ? data[(y - 1) * stride + x]! : 0
            const c = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0
            const p = a + up - c
            const pred = f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : f === 4 ? (Math.abs(p - a) <= Math.abs(p - up) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - up) <= Math.abs(p - c) ? up : c) : 0
            data[y * stride + x] = (v + pred) & 255
        }
    }
    return { w, h, data }
}

function crc32(buf: Buffer) {
    let c = ~0
    for (const byte of buf) {
        c ^= byte
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
}

function writeRgba(path: string, { w, h, data }: { w: number, h: number, data: Uint8Array }) {
    const raw = Buffer.alloc(h * (w * 4 + 1))
    for (let y = 0; y < h; y++) Buffer.from(data.subarray(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1)
    const chunk = (type: string, body: Buffer) => {
        const len = Buffer.alloc(4)
        len.writeUInt32BE(body.length)
        const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crc32(typed))
        return Buffer.concat([len, typed, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr.set([8, 6, 0, 0, 0], 8)
    writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

/**
 * Leather as Minecraft shows it undyed: the grey base multiplied by its
 * default brown, with the overlay (stitching, buckles) laid over undyed.
 */
const LEATHER = [0xa0, 0x65, 0x40]
function dyeLeather(base: string, overlay: string | null, to: string) {
    const img = readRgba(base)
    const top = overlay && existsSync(overlay) ? readRgba(overlay) : null
    for (let i = 0; i < img.data.length; i += 4) {
        for (let c = 0; c < 3; c++) img.data[i + c] = Math.round((img.data[i + c]! * LEATHER[c]!) / 255)
        const a = top ? top.data[i + 3]! / 255 : 0
        if (a > 0) {
            for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(top!.data[i + c]! * a + img.data[i + c]! * (1 - a))
            img.data[i + 3] = Math.max(img.data[i + 3]!, top!.data[i + 3]!)
        }
    }
    writeRgba(to, img)
}

type Vec3 = [number, number, number]
type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east'

interface FaceJson {
    texture: string
    uv?: [number, number, number, number]
    cullface?: Dir
    tintindex?: number
    rotation?: number
}

interface ElementJson {
    from: Vec3
    to: Vec3
    rotation?: { origin: Vec3, axis: 'x' | 'y' | 'z', angle: number, rescale?: boolean }
    shade?: boolean
    shade_direction_override?: string
    faces: Partial<Record<Dir, FaceJson>>
}

interface ModelJson {
    parent?: string
    ambientocclusion?: boolean
    textures?: Record<string, string>
    elements?: ElementJson[]
}

interface VariantJson {
    model: string
    x?: number
    y?: number
    weight?: number
}

/** A resolved face: texture index, uv in pixels (0..16), cull side, tint slot, uv rotation. */
interface OutFace {
    t: number
    uv: [number, number, number, number]
    cull?: Dir
    tint?: number
    rot?: number
}

interface OutElement {
    from: Vec3
    to: Vec3
    rot?: { origin: Vec3, axis: 'x' | 'y' | 'z', angle: number, rescale: boolean }
    /** False: lit from above whatever the face points at (plants). */
    shade: boolean
    faces: Partial<Record<Dir, OutFace>>
}

interface OutModel {
    ao: boolean
    elements: OutElement[]
}

interface OutVariant {
    model: number
    x: number
    y: number
    weight: number
}

const src = process.argv[2]
if (!src) {
    console.error('usage: bun scripts/skyfarm-pack.ts <unzipped pack dir>')
    process.exit(1)
}
const root = join(src, 'assets/minecraft')
const out = join(import.meta.dir, '../public/skyfarm/pack')

const strip = (name: string) => name.replace(/^minecraft:/, '')

function readJson<T>(path: string): T | null {
    if (!existsSync(path)) return null
    // Some pack files carry tabs and trailing commas; tolerate the commas.
    return JSON.parse(readFileSync(path, 'utf8').replace(/,(\s*[}\]])/g, '$1')) as T
}

// ── Our own shapes, for blocks whose vanilla model the pack doesn't ship ──

const box = (from: Vec3, to: Vec3, faces: Partial<Record<Dir, FaceJson>>, extra: Partial<ElementJson> = {}): ElementJson => ({ from, to, faces, ...extra })
const allSides = (texture: string, cull = true, tintindex?: number): Partial<Record<Dir, FaceJson>> => {
    const f: Partial<Record<Dir, FaceJson>> = {}
    for (const d of ['down', 'up', 'north', 'south', 'west', 'east'] as Dir[]) f[d] = { texture, ...(cull ? { cullface: d } : {}), ...(tintindex !== undefined ? { tintindex } : {}) }
    return f
}
const cubeAll = (tex: string, tintindex?: number): ModelJson => ({ textures: { all: tex }, elements: [box([0, 0, 0], [16, 16, 16], allSides('#all', true, tintindex))] })
const cube = (t: Record<Dir, string>, tintindex?: number): ModelJson => ({
    elements: [box([0, 0, 0], [16, 16, 16], Object.fromEntries((Object.keys(t) as Dir[]).map(d => [d, { texture: t[d], cullface: d, ...(tintindex !== undefined ? { tintindex } : {}) }])))]
})
const cross = (tex: string, tintindex?: number): ModelJson => ({
    ambientocclusion: false,
    elements: [
        box([0.8, 0, 8], [15.2, 16, 8], { north: { texture: tex, tintindex }, south: { texture: tex, tintindex } }, { rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false }),
        box([8, 0, 0.8], [8, 16, 15.2], { west: { texture: tex, tintindex }, east: { texture: tex, tintindex } }, { rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false })
    ]
})

/**
 * A sunflower's upper half (Minecraft's sunflower_top): the top of the stem,
 * crossed, and the flower head on a plane tilted 22.5 degrees to face east,
 * its back to the west.
 */
const sunflowerTop: ModelJson = {
    ambientocclusion: false,
    elements: [
        ...cross('block/sunflower_top').elements!,
        box([9.6, -1, 1], [9.6, 15, 15], { west: { texture: 'block/sunflower_back' }, east: { texture: 'block/sunflower_front' } },
            { rotation: { origin: [8, 8, 8], axis: 'z', angle: 22.5, rescale: true }, shade: false })
    ]
}

/**
 * The chest, from the entity texture (64x64; Minecraft's box unwrap). UVs are
 * in the 0..16 space of the whole sheet, so pixels are divided by 4.
 */
function chestModel(tex: string, tintindex?: number): ModelJson {
    const q = (u0: number, v0: number, u1: number, v1: number): [number, number, number, number] => [u0 / 4, v0 / 4, u1 / 4, v1 / 4]
    // Box at texture offset (u, v), w wide (x), h tall (y), d deep (z).
    const unwrap = (u: number, v: number, w: number, h: number, d: number): Partial<Record<Dir, FaceJson>> => ({
        up: { texture: tex, uv: q(u + d + w, v + d, u + d + 2 * w, v), tintindex },
        down: { texture: tex, uv: q(u + d, v, u + d + w, v + d), tintindex },
        north: { texture: tex, uv: q(u + 2 * d + 2 * w, v + d + h, u + 2 * d + w, v + d), tintindex },
        south: { texture: tex, uv: q(u + d + w, v + d + h, u + d, v + d), tintindex },
        west: { texture: tex, uv: q(u + d, v + d + h, u, v + d), tintindex },
        east: { texture: tex, uv: q(u + 2 * d + w, v + d + h, u + d + w, v + d), tintindex }
    })
    return {
        elements: [
            box([1, 0, 1], [15, 10, 15], unwrap(0, 19, 14, 10, 14)),
            box([1, 10, 1], [15, 15, 15], unwrap(0, 0, 14, 5, 14)),
            box([7, 7, 15], [9, 11, 16], unwrap(0, 0, 2, 4, 1))
        ]
    }
}

/** A crop: four planes in a # shape. */
function crop(tex: string): ModelJson {
    const plane = (from: Vec3, to: Vec3, a: Dir, b: Dir) => box(from, to, { [a]: { texture: tex }, [b]: { texture: tex } }, { shade: false })
    return {
        ambientocclusion: false,
        elements: [
            plane([4, -1, 0], [4, 15, 16], 'west', 'east'),
            plane([12, -1, 0], [12, 15, 16], 'west', 'east'),
            plane([0, -1, 4], [16, 15, 4], 'north', 'south'),
            plane([0, -1, 12], [16, 15, 12], 'north', 'south')
        ]
    }
}

/**
 * Fire: flames on all four sides of the cell (drawn from both sides) and two
 * crossed through the middle, Minecraft's two animated fire textures.
 */
function fireModel(): ModelJson {
    const both = (tex: string, a: Dir, b: Dir) => ({ [a]: { texture: tex }, [b]: { texture: tex } })
    return {
        ambientocclusion: false,
        elements: [
            box([0.1, 0, 0], [0.1, 16, 16], both('block/fire_1', 'west', 'east'), { shade: false }),
            box([15.9, 0, 0], [15.9, 16, 16], both('block/fire_1', 'west', 'east'), { shade: false }),
            box([0, 0, 0.1], [16, 16, 0.1], both('block/fire_1', 'north', 'south'), { shade: false }),
            box([0, 0, 15.9], [16, 16, 15.9], both('block/fire_1', 'north', 'south'), { shade: false }),
            ...cross('block/fire_0').elements!
        ]
    }
}

const SMOOTH = 'block/smooth_stone'

function repeater(on: boolean): ModelJson {
    const torch = on ? 'block/redstone_torch' : 'block/redstone_torch_off'
    const pin = (z: number) => box([7, 2, z], [9, 7, z + 2], {
        up: { texture: torch, uv: [7, 6, 9, 8] }, north: { texture: torch, uv: [7, 6, 9, 11] }, south: { texture: torch, uv: [7, 6, 9, 11] },
        west: { texture: torch, uv: [7, 6, 9, 11] }, east: { texture: torch, uv: [7, 6, 9, 11] }
    })
    return {
        ambientocclusion: false,
        elements: [
            box([0, 0, 0], [16, 2, 16], {
                down: { texture: SMOOTH, cullface: 'down' }, up: { texture: on ? 'block/repeater_on' : 'block/repeater' },
                north: { texture: SMOOTH, uv: [0, 14, 16, 16], cullface: 'north' }, south: { texture: SMOOTH, uv: [0, 14, 16, 16], cullface: 'south' },
                west: { texture: SMOOTH, uv: [0, 14, 16, 16], cullface: 'west' }, east: { texture: SMOOTH, uv: [0, 14, 16, 16], cullface: 'east' }
            }),
            pin(2),
            pin(10)
        ]
    }
}

function lever(on: boolean): ModelJson {
    return {
        ambientocclusion: false,
        elements: [
            box([5, 0, 4], [11, 3, 12], {
                up: { texture: 'block/cobblestone', uv: [5, 4, 11, 12] }, down: { texture: 'block/cobblestone', uv: [5, 4, 11, 12], cullface: 'down' },
                north: { texture: 'block/cobblestone', uv: [5, 0, 11, 3] }, south: { texture: 'block/cobblestone', uv: [5, 0, 11, 3] },
                west: { texture: 'block/cobblestone', uv: [4, 0, 12, 3] }, east: { texture: 'block/cobblestone', uv: [4, 0, 12, 3] }
            }),
            box([7, 1, 7], [9, 11, 9], {
                up: { texture: 'block/lever', uv: [7, 6, 9, 8] }, north: { texture: 'block/lever', uv: [7, 6, 9, 16] }, south: { texture: 'block/lever', uv: [7, 6, 9, 16] },
                west: { texture: 'block/lever', uv: [7, 6, 9, 16] }, east: { texture: 'block/lever', uv: [7, 6, 9, 16] }
            }, { rotation: { origin: [8, 1, 8], axis: 'x', angle: on ? 45 : -45 } })
        ]
    }
}

const button = (pressed: boolean): ModelJson => ({
    elements: [box([5, 0, 6], [11, pressed ? 1 : 2, 10], {
        up: { texture: 'block/stone', uv: [5, 6, 11, 10] }, down: { texture: 'block/stone', uv: [5, 6, 11, 10], cullface: 'down' },
        north: { texture: 'block/stone', uv: [5, 14, 11, 16] }, south: { texture: 'block/stone', uv: [5, 14, 11, 16] },
        west: { texture: 'block/stone', uv: [6, 14, 10, 16] }, east: { texture: 'block/stone', uv: [6, 14, 10, 16] }
    })]
})

function piston(sticky: boolean, extended: boolean): ModelJson {
    const top = extended ? 'block/piston_inner' : sticky ? 'block/piston_top_sticky' : 'block/piston_top'
    const h = extended ? 12 : 16
    return {
        elements: [box([0, 0, 0], [16, h, 16], {
            down: { texture: 'block/piston_bottom', cullface: 'down' }, up: { texture: top, ...(extended ? {} : { cullface: 'up' as Dir }) },
            north: { texture: 'block/piston_side', uv: [0, 16 - h, 16, 16], cullface: 'north' }, south: { texture: 'block/piston_side', uv: [0, 16 - h, 16, 16], cullface: 'south' },
            west: { texture: 'block/piston_side', uv: [0, 16 - h, 16, 16], cullface: 'west' }, east: { texture: 'block/piston_side', uv: [0, 16 - h, 16, 16], cullface: 'east' }
        })]
    }
}

const pistonHead: ModelJson = {
    elements: [
        box([0, 12, 0], [16, 16, 16], {
            up: { texture: 'block/piston_top', cullface: 'up' }, down: { texture: 'block/piston_top' },
            north: { texture: 'block/piston_side', uv: [0, 0, 16, 4], cullface: 'north' }, south: { texture: 'block/piston_side', uv: [0, 0, 16, 4], cullface: 'south' },
            west: { texture: 'block/piston_side', uv: [0, 0, 16, 4], cullface: 'west' }, east: { texture: 'block/piston_side', uv: [0, 0, 16, 4], cullface: 'east' }
        }),
        box([6, 0, 6], [10, 12, 10], {
            north: { texture: 'block/piston_side', uv: [0, 4, 4, 16] }, south: { texture: 'block/piston_side', uv: [0, 4, 4, 16] },
            west: { texture: 'block/piston_side', uv: [0, 4, 4, 16] }, east: { texture: 'block/piston_side', uv: [0, 4, 4, 16] }
        })
    ]
}

const hopper: ModelJson = {
    elements: [
        box([0, 10, 0], [16, 11, 16], { down: { texture: 'block/hopper_outside' }, up: { texture: 'block/hopper_inside' } }),
        box([0, 11, 0], [2, 16, 16], { up: { texture: 'block/hopper_top', cullface: 'up' }, north: { texture: 'block/hopper_outside', cullface: 'north' }, south: { texture: 'block/hopper_outside', cullface: 'south' }, west: { texture: 'block/hopper_outside', cullface: 'west' }, east: { texture: 'block/hopper_outside' } }),
        box([14, 11, 0], [16, 16, 16], { up: { texture: 'block/hopper_top', cullface: 'up' }, north: { texture: 'block/hopper_outside', cullface: 'north' }, south: { texture: 'block/hopper_outside', cullface: 'south' }, west: { texture: 'block/hopper_outside' }, east: { texture: 'block/hopper_outside', cullface: 'east' } }),
        box([2, 11, 0], [14, 16, 2], { up: { texture: 'block/hopper_top', cullface: 'up' }, north: { texture: 'block/hopper_outside', cullface: 'north' }, south: { texture: 'block/hopper_outside' } }),
        box([2, 11, 14], [14, 16, 16], { up: { texture: 'block/hopper_top', cullface: 'up' }, north: { texture: 'block/hopper_outside' }, south: { texture: 'block/hopper_outside', cullface: 'south' } }),
        box([4, 4, 4], [12, 10, 12], { down: { texture: 'block/hopper_outside' }, north: { texture: 'block/hopper_outside' }, south: { texture: 'block/hopper_outside' }, west: { texture: 'block/hopper_outside' }, east: { texture: 'block/hopper_outside' } }),
        box([6, 0, 6], [10, 4, 10], { down: { texture: 'block/hopper_outside', cullface: 'down' }, north: { texture: 'block/hopper_outside' }, south: { texture: 'block/hopper_outside' }, west: { texture: 'block/hopper_outside' }, east: { texture: 'block/hopper_outside' } })
    ]
}

const farmland = (moist: boolean): ModelJson => ({
    elements: [box([0, 0, 0], [16, 15, 16], {
        down: { texture: 'block/dirt', cullface: 'down' }, up: { texture: moist ? 'block/farmland_moist' : 'block/farmland' },
        north: { texture: 'block/dirt', uv: [0, 1, 16, 16], cullface: 'north' }, south: { texture: 'block/dirt', uv: [0, 1, 16, 16], cullface: 'south' },
        west: { texture: 'block/dirt', uv: [0, 1, 16, 16], cullface: 'west' }, east: { texture: 'block/dirt', uv: [0, 1, 16, 16], cullface: 'east' }
    })]
})

const cactus: ModelJson = {
    elements: [
        box([0, 0, 0], [16, 16, 16], { down: { texture: 'block/cactus_bottom', cullface: 'down' }, up: { texture: 'block/cactus_top', cullface: 'up' } }),
        box([0, 0, 1], [16, 16, 15], { north: { texture: 'block/cactus_side' }, south: { texture: 'block/cactus_side' } }),
        box([1, 0, 0], [15, 16, 16], { west: { texture: 'block/cactus_side' }, east: { texture: 'block/cactus_side' } })
    ]
}

/**
 * Minecraft's torch (template_torch), which the pack doesn't ship: two crossed
 * planes of the texture and a 2x2 cap. On a wall it leans 22.5 degrees out to
 * the east, its foot against the west wall (template_torch_wall).
 */
function torchModel(wall: boolean): ModelJson {
    const lean = wall ? { rotation: { origin: [0, 3.5, 8] as Vec3, axis: 'z' as const, angle: -22.5 }, shade: false } : { shade: false }
    const [x0, y0] = wall ? [-1, 3.5] : [7, 0]
    const plane: FaceJson = { texture: '#torch', uv: [0, 0, 16, 16] }
    return {
        ambientocclusion: false,
        textures: { torch: 'block/torch' },
        elements: [
            box([x0, y0, 7], [x0 + 2, y0 + 10, 9], { down: { texture: '#torch', uv: [7, 13, 9, 15] }, up: { texture: '#torch', uv: [7, 6, 9, 8] } }, lean),
            box([x0, y0, 0], [x0 + 2, y0 + 16, 16], { west: plane, east: plane }, lean),
            box([x0 - 7, y0, 7], [x0 + 9, y0 + 16, 9], { north: plane, south: plane }, lean)
        ]
    }
}

/**
 * A jack o'lantern: the pack carves the face out of the front (it is see-through
 * there) and lays the candle glow in a sheet flush with it, which would flicker
 * against the face. Our glow sits half a pixel inside instead, seen through the
 * carving.
 */
const jackOLantern: ModelJson = {
    elements: [
        ...cube({ down: 'block/pumpkin_top', up: 'block/pumpkin_top', north: 'block/jack_o_lantern', south: 'block/pumpkin_side', west: 'block/pumpkin_side', east: 'block/pumpkin_side' }).elements!,
        box([0, 0, 0.5], [16, 16, 0.5], { north: { texture: 'block/jack_o_lantern_e' } }, { shade: false })
    ]
}

/**
 * A box textured top, bottom and sides (`side`, or per face), each face
 * culled against its neighbour where it lies on the block's edge.
 */
function part(from: Vec3, to: Vec3, t: { up: string, down: string, side: string } & Partial<Record<Dir, string>>, extra: Partial<ElementJson> = {}): ElementJson {
    const edge: Record<Dir, boolean> = { up: to[1] === 16, down: from[1] === 0, north: from[2] === 0, south: to[2] === 16, west: from[0] === 0, east: to[0] === 16 }
    const faces: Partial<Record<Dir, FaceJson>> = {}
    for (const d of ['down', 'up', 'north', 'south', 'west', 'east'] as Dir[]) {
        const texture = t[d] ?? (d === 'up' ? t.up : d === 'down' ? t.down : t.side)
        faces[d] = { texture, ...(edge[d] ? { cullface: d } : {}) }
    }
    return box(from, to, faces, extra)
}

/** A composter (Minecraft's): a hollow wooden box, filled `level` (0 to 7) layers deep, or ready (8). */
function composter(level: number): ModelJson {
    const t = { up: 'block/composter_top', down: 'block/composter_bottom', side: 'block/composter_side' }
    const elements = [
        part([0, 0, 0], [16, 2, 16], { ...t, up: 'block/composter_bottom' }),
        part([0, 0, 0], [2, 16, 16], t), part([14, 0, 0], [16, 16, 16], t),
        part([2, 0, 0], [14, 16, 2], t), part([2, 0, 14], [14, 16, 16], t)
    ]
    if (level > 0) {
        const top = level >= 8 ? 15 : 1 + level * 2
        elements.push(box([2, 2, 2], [14, top, 14], { up: { texture: level >= 8 ? 'block/composter_ready' : 'block/composter_compost' } }))
    }
    return { elements }
}

/** A cauldron (Minecraft's): iron walls on four stubby legs, with water `level` (0 to 3) thirds full. */
function cauldron(level: number): ModelJson {
    const t = { up: 'block/cauldron_top', down: 'block/cauldron_bottom', side: 'block/cauldron_side' }
    const elements = [
        part([2, 3, 2], [14, 4, 14], { ...t, up: 'block/cauldron_inner' }),
        part([0, 3, 0], [2, 16, 16], t), part([14, 3, 0], [16, 16, 16], t),
        part([2, 3, 0], [14, 16, 2], t), part([2, 3, 14], [14, 16, 16], t),
        part([0, 0, 0], [4, 3, 4], t), part([12, 0, 0], [16, 3, 4], t),
        part([0, 0, 12], [4, 3, 16], t), part([12, 0, 12], [16, 3, 16], t)
    ]
    if (level > 0) elements.push(box([2, 4, 2], [14, [9, 12, 15][level - 1]!, 14], { up: { texture: 'block/water_still', tintindex: 0 } }))
    return { elements }
}

/** A stonecutter: a low stone base with the saw blade standing up across it (facing north). */
const stonecutter: ModelJson = {
    elements: [
        part([0, 0, 0], [16, 9, 16], { up: 'block/stonecutter_top', down: 'block/stonecutter_bottom', side: 'block/stonecutter_side' }),
        box([1, 9, 8], [15, 16, 8], { north: { texture: 'block/stonecutter_saw', uv: [1, 9, 15, 16] }, south: { texture: 'block/stonecutter_saw', uv: [1, 9, 15, 16] } }, { shade: false })
    ]
}

/** A grindstone: the wheel between two posts on two legs (its axle runs east to west). */
const grindstone: ModelJson = {
    elements: [
        part([4, 4, 2], [12, 16, 14], { up: 'block/grindstone_round', down: 'block/grindstone_round', side: 'block/grindstone_round', east: 'block/grindstone_side', west: 'block/grindstone_side' }),
        part([2, 7, 5], [4, 13, 11], { up: 'block/grindstone_pivot', down: 'block/grindstone_pivot', side: 'block/grindstone_pivot' }),
        part([12, 7, 5], [14, 13, 11], { up: 'block/grindstone_pivot', down: 'block/grindstone_pivot', side: 'block/grindstone_pivot' }),
        part([2, 0, 6], [4, 7, 10], { up: 'block/dark_oak_planks', down: 'block/dark_oak_planks', side: 'block/dark_oak_planks' }),
        part([12, 0, 6], [14, 7, 10], { up: 'block/dark_oak_planks', down: 'block/dark_oak_planks', side: 'block/dark_oak_planks' })
    ]
}

/** A lectern: a base, a post, and the reading board sloping toward the reader (front north). */
const lectern: ModelJson = {
    elements: [
        part([0, 0, 0], [16, 2, 16], { up: 'block/lectern_base', down: 'block/oak_planks', side: 'block/lectern_base' }),
        part([4, 2, 4], [12, 15, 12], { up: 'block/oak_planks', down: 'block/oak_planks', side: 'block/lectern_sides', north: 'block/lectern_front', south: 'block/lectern_front' }),
        part([0.0125, 12, 3], [15.9875, 16, 16], { up: 'block/lectern_top', down: 'block/oak_planks', side: 'block/lectern_sides' }, { rotation: { origin: [8, 8, 8], axis: 'x', angle: -22.5 } })
    ]
}

// ── Redstone ───────────────────────────────────────────────────────────

/** How far our repeater model is turned from sending north (checked in the game). */
const REPEATER_TURN = 0

/** A piston's head; a sticky one's face is slimed. */
const pistonHeadModel = (sticky: boolean): ModelJson => ({
    elements: pistonHead.elements!.map((e, i) => (i === 0 ? { ...e, faces: { ...e.faces, up: { texture: sticky ? 'block/piston_top_sticky' : 'block/piston_top', cullface: 'up' as Dir } } } : e))
})

/** A hopper whose spout points north (sideways), from the one pointing down. */
const hopperSide: ModelJson = {
    elements: [
        ...hopper.elements!.slice(0, -1),
        box([6, 4, 0], [10, 8, 4], { up: { texture: 'block/hopper_outside' }, down: { texture: 'block/hopper_outside' }, north: { texture: 'block/hopper_outside', cullface: 'north' }, west: { texture: 'block/hopper_outside' }, east: { texture: 'block/hopper_outside' } })
    ]
}

/** A state: a model (ours, or the pack's by name) turned by Minecraft's blockstate rotations. */
type Turned = { model: ModelJson | string, x?: number, y?: number }

/**
 * The six facings (north, east, south, west, up, down, as the game's DIRS) of a
 * model whose front points north (an observer, a dropper), Minecraft's way.
 */
const sixOfNorth = (model: ModelJson | string, vertical: ModelJson | string = model): Turned[] => [
    { model }, { model, y: 90 }, { model, y: 180 }, { model, y: 270 },
    vertical === model ? { model, x: 270 } : { model: vertical }, vertical === model ? { model, x: 90 } : { model: vertical, x: 180 }
]
/** The six facings of a model that points up (a piston). */
const sixOfUp = (model: ModelJson | string): Turned[] => [
    { model, x: 90 }, { model, x: 90, y: 90 }, { model, x: 90, y: 180 }, { model, x: 90, y: 270 }, { model }, { model, x: 180 }
]
/**
 * Where a lever or button sits (the game's meta 0 to 5: floor, a wall with it
 * pointing east, south, west or north, ceiling), for a model made on the floor.
 */
const sixAttached = (model: ModelJson): Turned[] => [
    { model }, { model, x: 90, y: 90 }, { model, x: 90, y: 180 }, { model, x: 90, y: 270 }, { model, x: 90 }, { model, x: 180 }
]

/**
 * Redstone dust linking to the sides in `mask` (north 1, east 2, south 4,
 * west 8): a dot, and a line to each linked side (one link runs right
 * across); nothing linked is a cross. Drawn flat on the floor, tinted by power.
 */
function dustModel(mask: number): ModelJson {
    const sides = mask === 0 ? 15 : [1, 2, 4, 8].includes(mask) ? mask | ((mask << 2) | (mask >> 2)) & 15 : mask
    // Half a line takes half the texture (the line runs along it, so either half).
    const flat = (from: Vec3, to: Vec3, texture: string, rotation?: number): ElementJson => {
        const uv: [number, number, number, number] = texture.endsWith('dot') ? [0, 0, 16, 16] : [0, 0, 16, 8]
        return box(from, to, {
            up: { texture, uv, tintindex: 0, ...(rotation ? { rotation } : {}) },
            down: { texture, uv, tintindex: 0, ...(rotation ? { rotation } : {}) }
        }, { shade: false })
    }
    // A straight run has no dot in the middle.
    const elements: ElementJson[] = sides === 5 || sides === 10 ? [] : [flat([0, 0.25, 0], [16, 0.25, 16], 'block/redstone_dust_dot')]
    if (sides & 1) elements.push(flat([0, 0.26, 0], [16, 0.26, 8], 'block/redstone_dust_line0'))
    if (sides & 4) elements.push(flat([0, 0.26, 8], [16, 0.26, 16], 'block/redstone_dust_line0'))
    if (sides & 2) elements.push(flat([8, 0.27, 0], [16, 0.27, 16], 'block/redstone_dust_line0', 90))
    if (sides & 8) elements.push(flat([0, 0.27, 0], [8, 0.27, 16], 'block/redstone_dust_line0', 90))
    return { ambientocclusion: false, elements }
}

/** A dropper, dispenser or the block breaker: its front on the north side, or (vertical) on top. */
function frontBlock(front: string, vertical: string, tintindex?: number): [ModelJson, ModelJson] {
    const t = (n: string) => n
    return [
        cube({ down: 'block/furnace_top', up: 'block/furnace_top', north: t(front), south: 'block/furnace_side', west: 'block/furnace_side', east: 'block/furnace_side' }, tintindex),
        cube({ down: 'block/furnace_top', up: t(vertical), north: 'block/furnace_side', south: 'block/furnace_side', west: 'block/furnace_side', east: 'block/furnace_side' }, tintindex)
    ]
}

/** An observer: its face north, the red-dot back south (lit while it pulses). */
const observerModel = (on: boolean) => cube({
    down: 'block/observer_top', up: 'block/observer_top', north: 'block/observer_front',
    south: on ? 'block/observer_back_on' : 'block/observer_back', west: 'block/observer_side', east: 'block/observer_side'
})

/** A furnace, its front on the north face; lit, the front glows. */
const furnaceModel = (lit: boolean, name = 'furnace') => cube({ down: `block/${name}_bottom`, up: `block/${name}_top`, north: lit ? `block/${name}_front_on` : `block/${name}_front`, south: `block/${name}_side`, west: `block/${name}_side`, east: `block/${name}_side` })

/**
 * How each Skyfarm block gets its look, by block key. `states` lists the
 * blockstate variant to use for each of the block's states (indexed by its
 * meta state, see stateOf in mesher.ts); `inline` is one of our shapes, one
 * per state; `tints` are the colours for the models' tint indexes.
 */
interface Spec {
    blockstate?: string
    states?: string[]
    inline?: ModelJson[]
    /** Our shape for a state whose model the pack doesn't ship. */
    fallback?: (state: number) => ModelJson
    /** A stem's attached model: four more states after `states`, turned to face west, north, east and south. */
    attached?: string
    /** Turned to face north, east, south and west: every state becomes four (state * 4 + facing). */
    facings?: boolean
    /** More states after the others: a model turned `y` degrees (a wall torch, one per wall). */
    turned?: { model: ModelJson, y: number }[]
    /** Every state spelled out: a model (ours, or the pack's by name) and its turn. */
    list?: Turned[]
    tints?: number[]
}

const ages = (n: number) => Array.from({ length: n }, (_, i) => `age=${i}`)

const SPECS: Record<string, Spec> = {
    grass: { blockstate: 'grass_block', states: ['snowy=false'], tints: [0x91bd59] },
    dirt: {},
    stone: {},
    cobblestone: {},
    oak_log: { states: ['axis=y'] },
    oak_planks: {},
    oak_leaves: { tints: [0x77ab2f] },
    oak_sapling: { inline: [cross('block/oak_sapling')] },
    // Fluids: the still texture on top and bottom, the flowing one on the sides
    // (the mesher reads them from there: up is still, north is flowing).
    water: { inline: [cube({ down: 'block/water_still', up: 'block/water_still', north: 'block/water_flow', south: 'block/water_flow', west: 'block/water_flow', east: 'block/water_flow' }, 0)], tints: [0x3f76e4] },
    lava: { inline: [cube({ down: 'block/lava_still', up: 'block/lava_still', north: 'block/lava_flow', south: 'block/lava_flow', west: 'block/lava_flow', east: 'block/lava_flow' })] },
    ice: {},
    obsidian: {},
    sand: {},
    glass: {},
    // Dry, then moist (meta bit 0).
    farmland: { inline: [farmland(false), farmland(true)] },
    short_grass: { states: [''], tints: [0x91bd59] },
    // Flowers (the pack ships their textures, not their models), and the two-block
    // plants: lower half, then upper.
    ...Object.fromEntries(['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip']
        .map(k => [k, { inline: [cross(`block/${k}`)] }])),
    tall_grass: { inline: [cross('block/tall_grass_bottom', 0), cross('block/tall_grass_top', 0)], tints: [0x91bd59] },
    ...Object.fromEntries(['lilac', 'rose_bush', 'peony'].map(k => [k, { inline: [cross(`block/${k}_bottom`), cross(`block/${k}_top`)] }])),
    sunflower: { inline: [cross('block/sunflower_bottom'), sunflowerTop] },
    wheat: { states: ages(8), fallback: i => crop(`block/wheat_stage${i}`) },
    sugar_cane: { states: ['age=0'] },
    cactus: { inline: [cactus] },
    // Stems: the eight ages, then grown and attached to a fruit to the west, north, east, south.
    melon_stem: { states: ages(8), attached: 'block/attached_melon_stem', tints: [0x8fb03c] },
    melon: { inline: [cube({ down: 'block/melon_top', up: 'block/melon_top', north: 'block/melon_side', south: 'block/melon_side', west: 'block/melon_side', east: 'block/melon_side' })] },
    pumpkin_stem: { states: ages(8), attached: 'block/attached_pumpkin_stem', tints: [0x8fb03c] },
    pumpkin: { inline: [cube({ down: 'block/pumpkin_top', up: 'block/pumpkin_top', north: 'block/pumpkin_side', south: 'block/pumpkin_side', west: 'block/pumpkin_side', east: 'block/pumpkin_side' })] },
    chest: { inline: [chestModel('entity/chest/normal')] },
    sell_chest: { inline: [chestModel('entity/chest/normal', 0)], tints: [0xffd35a] },
    // Unlit, then lit (meta bit 3), each facing north, east, south and west (bits 0-1).
    furnace: { inline: [furnaceModel(false), furnaceModel(true)], facings: true },
    crafting_table: {},
    // Redstone, every facing (state order matches stateOf in mesher.ts).
    // Hopper: out north, east, south, west, (unused), down.
    hopper: { list: [{ model: hopperSide }, { model: hopperSide, y: 90 }, { model: hopperSide, y: 180 }, { model: hopperSide, y: 270 }, { model: hopper }, { model: hopper }] },
    // Dust: by which sides it links to.
    redstone_dust: { list: Array.from({ length: 16 }, (_, mask) => ({ model: dustModel(mask) })) },
    // Torch: floor lit, floor out, then each wall (leaning east, south, west, north) lit and out.
    redstone_torch: {
        list: [{ model: 'block/redstone_torch' }, { model: 'block/redstone_torch_off' },
            ...[0, 90, 180, 270].flatMap(y => [{ model: 'block/redstone_wall_torch', y }, { model: 'block/redstone_wall_torch_off', y }])]
    },
    // Levers and buttons: where they sit (floor, four walls, ceiling), off and on.
    lever: { list: sixAttached(lever(false)).flatMap((off, i) => [off, sixAttached(lever(true))[i]!]) },
    button: { list: sixAttached(button(false)).flatMap((off, i) => [off, sixAttached(button(true))[i]!]) },
    // Repeater: sending north, east, south, west; off and on.
    repeater: { list: [0, 90, 180, 270].flatMap(y => [{ model: repeater(false), y: (y + REPEATER_TURN) % 360 }, { model: repeater(true), y: (y + REPEATER_TURN) % 360 }]) },
    // Observer: face each of six ways; resting and pulsing.
    observer: { list: [0, 1, 2, 3, 4, 5].flatMap(i => [sixOfNorth(observerModel(false))[i]!, sixOfNorth(observerModel(true))[i]!]) },
    // Pistons: pushing each of six ways; in and out. The head: each way; plain and sticky.
    piston: { list: [0, 1, 2, 3, 4, 5].flatMap(i => [sixOfUp(piston(false, false))[i]!, sixOfUp(piston(false, true))[i]!]) },
    sticky_piston: { list: [0, 1, 2, 3, 4, 5].flatMap(i => [sixOfUp(piston(true, false))[i]!, sixOfUp(piston(true, true))[i]!]) },
    piston_head: { list: [0, 1, 2, 3, 4, 5].flatMap(i => [sixOfUp(pistonHeadModel(false))[i]!, sixOfUp(pistonHeadModel(true))[i]!]) },
    // Dropper, dispenser, block breaker: facing each of six ways.
    dropper: { list: sixOfNorth(...frontBlock('block/dropper_front', 'block/dropper_front_vertical')) },
    dispenser: { list: sixOfNorth(...frontBlock('block/dispenser_front', 'block/dispenser_front_vertical')) },
    block_breaker: { list: sixOfNorth(...frontBlock('block/dropper_front', 'block/dropper_front_vertical', 0)), tints: [0xc4a8ff] },
    // The store depot: a lodestone-like block that sends things away.
    store_depot: { inline: [cube({ down: 'block/lodestone_top', up: 'block/lodestone_top', north: 'block/lodestone_side', south: 'block/lodestone_side', west: 'block/lodestone_side', east: 'block/lodestone_side' })] },
    // Slabs: bottom, top and double, from the pack's blockstates (stone has none: our shape, its texture).
    oak_slab: { states: ['type=bottom', 'type=top', 'type=double'] },
    cobblestone_slab: { states: ['type=bottom', 'type=top', 'type=double'] },
    stone_slab: {
        inline: [
            { ...slabShape(false), textures: { bottom: 'block/stone', top: 'block/stone', side: 'block/stone' } },
            { ...slabShape(true), textures: { bottom: 'block/stone', top: 'block/stone', side: 'block/stone' } },
            cubeAll('block/stone')
        ]
    },
    fire: { inline: [fireModel()] },
    // On the floor, then on a wall leaning out east, south, west and north (meta 1 to 4).
    torch: { inline: [torchModel(false)], turned: [0, 90, 180, 270].map(y => ({ model: torchModel(true), y })) },
    jack_o_lantern: { inline: [jackOLantern], facings: true },
    glowstone: {},
    white_wool: {},
    ...Object.fromEntries(['orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'green', 'red', 'black']
        .map(c => [`${c}_wool`, {}])),
    // Workstations.
    composter: { inline: Array.from({ length: 9 }, (_, i) => composter(i)) },
    barrel: { inline: [cube({ down: 'block/barrel_bottom', up: 'block/barrel_top', north: 'block/barrel_side', south: 'block/barrel_side', west: 'block/barrel_side', east: 'block/barrel_side' })] },
    smoker: { inline: [furnaceModel(false, 'smoker'), furnaceModel(true, 'smoker')], facings: true },
    blast_furnace: { inline: [furnaceModel(false, 'blast_furnace'), furnaceModel(true, 'blast_furnace')], facings: true },
    stonecutter: { inline: [stonecutter], facings: true },
    smithing_table: { inline: [cube({ down: 'block/smithing_table_bottom', up: 'block/smithing_table_top', north: 'block/smithing_table_front', south: 'block/smithing_table_front', west: 'block/smithing_table_side', east: 'block/smithing_table_side' })] },
    grindstone: { inline: [grindstone], facings: true },
    fletching_table: { inline: [cube({ down: 'block/birch_planks', up: 'block/fletching_table_top', north: 'block/fletching_table_front', south: 'block/fletching_table_front', west: 'block/fletching_table_side', east: 'block/fletching_table_side' })] },
    cartography_table: { inline: [cube({ down: 'block/dark_oak_planks', up: 'block/cartography_table_top', north: 'block/cartography_table_side3', south: 'block/cartography_table_side1', west: 'block/cartography_table_side2', east: 'block/cartography_table_side2' })] },
    brewing_stand: {},
    cauldron: { inline: [0, 1, 2, 3].map(cauldron), tints: [0x3f76e4] },
    lectern: { inline: [lectern], facings: true },
    loom: { inline: [cube({ down: 'block/loom_bottom', up: 'block/loom_top', north: 'block/loom_front', south: 'block/loom_side', west: 'block/loom_side', east: 'block/loom_side' })], facings: true },
    smooth_stone: {},
    stone_bricks: {},
    stone_brick_slab: { states: ['type=bottom', 'type=top', 'type=double'] },
    bookshelf: {},
    emerald_block: {},
    coal_ore: {},
    iron_ore: {},
    gold_ore: {},
    diamond_ore: {},
    bedrock: {}
}

// ── Resolution ─────────────────────────────────────────────────────────

const textures: string[] = []
const textureIndex = new Map<string, number>()
const models: OutModel[] = []
const warnings: string[] = []

function useTexture(name: string): number {
    let i = textureIndex.get(name)
    if (i === undefined) {
        if (!existsSync(join(root, 'textures', `${name}.png`))) warnings.push(`missing texture ${name}`)
        i = textures.length
        textures.push(name)
        textureIndex.set(name, i)
    }
    return i
}

/** A half-height slab, bottom or top, with Minecraft's #bottom, #top and #side textures. */
function slabShape(top: boolean): ModelJson {
    const [y0, y1] = top ? [8, 16] : [0, 8]
    const side = (d: Dir): FaceJson => ({ texture: '#side', uv: [0, 16 - y1, 16, 16 - y0], cullface: d })
    return {
        elements: [box([0, y0, 0], [16, y1, 16], {
            down: { texture: '#bottom', ...(top ? {} : { cullface: 'down' as Dir }) },
            up: { texture: '#top', ...(top ? { cullface: 'up' as Dir } : {}) },
            north: side('north'), south: side('south'), west: side('west'), east: side('east')
        })]
    }
}

/**
 * Vanilla parents a pack's models build on but packs don't ship (they live in
 * the game itself): generic shapes of our own, so the pack's models resolve.
 */
const BUILTIN_PARENTS: Record<string, ModelJson> = {
    'block/slab': slabShape(false),
    'block/slab_top': slabShape(true),
    'block/tinted_cross': cross('#cross', 0),
    'block/unshaded_cube_all': cubeAll('#all')
}

/** A model with its parent chain merged: the nearest elements and ao win; textures merge child over parent. */
function loadModel(name: string, seen = new Set<string>()): ModelJson | null {
    const n = strip(name)
    if (seen.has(n)) return null
    seen.add(n)
    const json = readJson<ModelJson>(join(root, 'models', `${n}.json`)) ?? BUILTIN_PARENTS[n] ?? null
    if (!json) return null
    if (!json.parent) return json
    const parent = loadModel(json.parent, seen) ?? {}
    return {
        ambientocclusion: json.ambientocclusion ?? parent.ambientocclusion,
        textures: { ...parent.textures, ...json.textures },
        elements: json.elements ?? parent.elements
    }
}

function resolveTexture(ref: string, vars: Record<string, string>): string | null {
    let t = ref
    for (let i = 0; i < 8 && t.startsWith('#'); i++) t = vars[t.slice(1)] ?? ''
    return t && !t.startsWith('#') ? strip(t) : null
}

/** Minecraft's default uv for a face, from the element's bounds. */
function defaultUv(dir: Dir, from: Vec3, to: Vec3): [number, number, number, number] {
    switch (dir) {
        case 'up':
        case 'down': return [from[0], from[2], to[0], to[2]]
        case 'north':
        case 'south': return [from[0], 16 - to[1], to[0], 16 - from[1]]
        default: return [from[2], 16 - to[1], to[2], 16 - from[1]]
    }
}

/**
 * Turns a model into the compact form the game reads. `fromPack`: a model the
 * pack ships. Some of those draw a glow overlay (an `_e` texture: the embers
 * in a brewing stand's bottle rests, its glowing rod) on a second copy of a
 * box, exactly over the first; flush, the two fight and flicker, so the
 * glowing copy is pushed out a hair to sit on top.
 */
function compile(json: ModelJson, fromPack = false): number | null {
    if (!json.elements?.length) return null
    const vars = json.textures ?? {}
    const elements: OutElement[] = []
    for (const raw of json.elements) {
        const glow = fromPack && Object.values(raw.faces).some(f => /_e(_s)?$/.test(resolveTexture(f!.texture, vars) ?? ''))
        const e = glow ? { ...raw, from: raw.from.map(v => v - 0.02) as Vec3, to: raw.to.map(v => v + 0.02) as Vec3 } : raw
        const faces: Partial<Record<Dir, OutFace>> = {}
        for (const [dir, f] of Object.entries(e.faces) as [Dir, FaceJson][]) {
            const tex = resolveTexture(f.texture, vars)
            if (!tex) {
                warnings.push(`unresolved ${f.texture}`)
                continue
            }
            faces[dir] = {
                t: useTexture(tex),
                uv: f.uv ?? defaultUv(dir, e.from, e.to),
                ...(f.cullface ? { cull: f.cullface } : {}),
                ...(f.tintindex !== undefined ? { tint: f.tintindex } : {}),
                ...(f.rotation ? { rot: f.rotation } : {})
            }
        }
        elements.push({
            from: e.from,
            to: e.to,
            ...(e.rotation ? { rot: { ...e.rotation, rescale: !!e.rotation.rescale } } : {}),
            shade: e.shade !== false && e.shade_direction_override !== 'up',
            faces
        })
    }
    models.push({ ao: json.ambientocclusion !== false, elements })
    return models.length - 1
}

const compiled = new Map<string, number | null>()
function modelIndex(name: string): number | null {
    const n = strip(name)
    if (!compiled.has(n)) {
        const m = loadModel(n)
        compiled.set(n, m ? compile(m, true) : null)
    }
    return compiled.get(n)!
}

function variantsFor(key: string, spec: Spec, state: string, stateIndex: number): OutVariant[] {
    const bs = readJson<{ variants?: Record<string, VariantJson | VariantJson[]> }>(join(root, 'blockstates', `${spec.blockstate ?? key}.json`))
    const entry = bs?.variants?.[state] ?? (state === '' ? bs?.variants?.[Object.keys(bs?.variants ?? {})[0] ?? ''] : undefined)
    const list = entry ? (Array.isArray(entry) ? entry : [entry]) : []
    const out: OutVariant[] = []
    for (const v of list) {
        const m = modelIndex(v.model)
        if (m !== null) out.push({ model: m, x: v.x ?? 0, y: v.y ?? 0, weight: v.weight ?? 1 })
    }
    if (out.length) return out
    if (spec.fallback) return [{ model: compile(spec.fallback(stateIndex))!, x: 0, y: 0, weight: 1 }]
    // No blockstate: the block's own model, else a cube of the texture named like it.
    const own = modelIndex(`block/${key}`)
    if (own !== null) return [{ model: own, x: 0, y: 0, weight: 1 }]
    return [{ model: compile(cubeAll(`block/${key}`))!, x: 0, y: 0, weight: 1 }]
}

const blocks: Record<string, { states: OutVariant[][], tints?: number[] }> = {}
for (const [key, spec] of Object.entries(SPECS)) {
    const compiledOf = new Map<ModelJson, number>()
    const modelOf = (m: ModelJson | string) => {
        if (typeof m === 'string') return modelIndex(m)!
        if (!compiledOf.has(m)) compiledOf.set(m, compile(m)!)
        return compiledOf.get(m)!
    }
    let states = spec.list
        ? spec.list.map(s => [{ model: modelOf(s.model), x: s.x ?? 0, y: s.y ?? 0, weight: 1 }])
        : spec.inline
            ? spec.inline.map(m => [{ model: compile(m)!, x: 0, y: 0, weight: 1 }])
            : (spec.states ?? ['']).map((s, i) => variantsFor(key, spec, s, i))
    // Minecraft's blockstates: the front faces north at y=0, east at 90, south at 180, west at 270.
    if (spec.facings) states = states.flatMap(list => [0, 90, 180, 270].map(y => list.map(v => ({ ...v, y: (v.y + y) % 360 }))))
    if (spec.turned) {
        for (const t of spec.turned) states.push([{ model: compile(t.model)!, x: 0, y: t.y, weight: 1 }])
    }
    if (spec.attached) {
        // Minecraft's attached stem model points west; its blockstate turns it 90 degrees per facing.
        const m = modelIndex(spec.attached)
        if (m !== null) for (let f = 0; f < 4; f++) states.push([{ model: m, x: 0, y: f * 90, weight: 1 }])
        else warnings.push(`missing model ${spec.attached}`)
    }
    blocks[key] = { states, ...(spec.tints ? { tints: spec.tints } : {}) }
}

// The ten crack stages drawn over a block as it is mined.
const crack = Array.from({ length: 10 }, (_, i) => useTexture(`block/destroy_stage_${i}`))

// ── Output ─────────────────────────────────────────────────────────────

/** Width and height from a PNG's header, without decoding it. */
function pngSize(path: string) {
    const b = readFileSync(path)
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'textures'), { recursive: true })
/**
 * A texture file, how many square frames its strip holds, and for an
 * animation the frame to show on each game tick of one loop (Minecraft's
 * .mcmeta: a default frametime, and optionally a frame list with per-frame times).
 */
const files: { file: string, frames: number, timeline?: number[] }[] = []
for (const name of textures) {
    const path = join(root, 'textures', `${name}.png`)
    const file = `${name.replace(/\//g, '__')}.png`
    if (!existsSync(path)) {
        files.push({ file: '', frames: 1 })
        continue
    }
    copyFileSync(path, join(out, 'textures', file))
    const { w, h } = pngSize(path)
    const anim = readJson<{ animation?: { frametime?: number, frames?: (number | { index: number, time?: number })[] } }>(`${path}.mcmeta`)?.animation
    // An animation is a vertical strip of square frames; the chest sheet is not one.
    const frames = anim && h > w ? Math.floor(h / w) : 1
    if (frames === 1) {
        files.push({ file, frames })
        continue
    }
    const step = anim!.frametime ?? 1
    const list = anim!.frames ?? Array.from({ length: frames }, (_, i) => i)
    const timeline: number[] = []
    for (const f of list) {
        const { index, time } = typeof f === 'number' ? { index: f, time: step } : { index: f.index, time: f.time ?? step }
        for (let t = 0; t < time; t++) timeline.push(Math.min(index, frames - 1))
    }
    files.push({ file, frames, timeline })
}

// The sky: sun, moon phases, clouds and rain streaks, as the pack draws them.
mkdirSync(join(out, 'sky'), { recursive: true })
for (const name of ['sun', 'moon_phases', 'clouds', 'rain']) {
    const path = join(root, 'textures/environment', `${name}.png`)
    if (existsSync(path)) copyFileSync(path, join(out, 'sky', `${name}.png`))
    else warnings.push(`missing sky texture ${name}`)
}

// Mobs' skins (the renderer builds Minecraft's models for them), arrows, and the
// HUD's hearts and air bubbles.
mkdirSync(join(out, 'entity'), { recursive: true })
for (const name of ['cow/cow', 'pig/pig_temperate', 'sheep/sheep', 'sheep/sheep_wool', 'chicken/chicken_temperate', 'zombie/zombie', 'skeleton/skeleton', 'creeper/creeper', 'spider/spider', 'spider/spider_eyes', 'projectiles/arrow', 'witch/witch',
    ...['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie'].map(c => `cat/cat_${c}`),
    'iron_golem/iron_golem', ...['low', 'medium', 'high'].map(c => `iron_golem/iron_golem_crackiness_${c}`), 'squid/squid']) {
    const path = join(root, 'textures/entity', `${name}.png`)
    if (existsSync(path)) copyFileSync(path, join(out, 'entity', `${name.split('/')[1]}.png`))
    else warnings.push(`missing entity texture ${name}`)
}
// Armour as mobs wear it: each material's outer layer (helmet, chestplate, boots)
// and its leggings layer. Leather comes dyed its default brown.
mkdirSync(join(out, 'entity/armor'), { recursive: true })
for (const material of ['leather', 'gold', 'chainmail', 'iron', 'diamond']) {
    for (const layer of ['humanoid', 'humanoid_leggings']) {
        const dir = join(root, 'textures/entity/equipment', layer)
        const to = join(out, 'entity/armor', `${material}${layer === 'humanoid' ? '' : '_leggings'}.png`)
        if (material === 'leather') dyeLeather(join(dir, 'leather.png'), join(dir, 'leather_overlay.png'), to)
        else copyFileSync(join(dir, `${material}.png`), to)
    }
}
// Villagers and zombie villagers: the skin, and a plains villager's clothes to lay over it.
for (const [from, to] of [['villager/villager', 'villager'], ['villager/type/plains', 'villager_plains'], ['zombie_villager/zombie_villager', 'zombie_villager'], ['zombie_villager/type/plains', 'zombie_villager_plains']]) {
    copyFileSync(join(root, 'textures/entity', `${from}.png`), join(out, 'entity', `${to}.png`))
}
// The thirteen trades' work clothes, laid over a villager once it has a workstation.
for (const prof of ['armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'shepherd', 'toolsmith', 'weaponsmith']) {
    copyFileSync(join(root, 'textures/entity/villager/profession', `${prof}.png`), join(out, 'entity', `profession_${prof}.png`))
    copyFileSync(join(root, 'textures/entity/zombie_villager/profession', `${prof}.png`), join(out, 'entity', `zombie_profession_${prof}.png`))
}
// Splash potions, in flight and in the inventory: the liquid in its colour (Minecraft's
// potion colours) inside the splash bottle.
const POTION_COLORS = { harming: [0xa9, 0x65, 0x6a], poison: [0x87, 0xa3, 0x63], slowness: [0x8b, 0xaf, 0xe0], weakness: [0x48, 0x4d, 0x48] }
function potionImage(color: number[], to: string) {
    const liquid = readRgba(join(root, 'textures/item/potion_overlay.png'))
    const bottle = readRgba(join(root, 'textures/item/splash_potion.png'))
    for (let i = 0; i < liquid.data.length; i += 4) {
        for (let c = 0; c < 3; c++) liquid.data[i + c] = Math.round((liquid.data[i + c]! * color[c]!) / 255)
        const a = bottle.data[i + 3]! / 255
        for (let c = 0; c < 3; c++) liquid.data[i + c] = Math.round(bottle.data[i + c]! * a + liquid.data[i + c]! * (1 - a))
        liquid.data[i + 3] = Math.max(liquid.data[i + 3]!, bottle.data[i + 3]!)
    }
    writeRgba(to, liquid)
}
for (const [kind, color] of Object.entries(POTION_COLORS)) potionImage(color, join(out, 'entity', `potion_${kind}.png`))
mkdirSync(join(out, 'gui'), { recursive: true })
const hearts = ['full', 'half', 'container', 'poisoned_full', 'poisoned_half'].flatMap(h => [`heart/${h}`, `heart/${h}_blinking`])
for (const name of [...hearts, 'air', 'air_bursting', 'armor_full', 'armor_half', 'armor_empty']) {
    const path = join(root, 'textures/gui/sprites/hud', `${name}.png`)
    if (existsSync(path)) copyFileSync(path, join(out, 'gui', `${name.replace('/', '_')}.png`))
    else warnings.push(`missing HUD sprite ${name}`)
}
// The effect icons shown while a witch's potion is on you.
for (const name of ['poison', 'slowness', 'weakness', 'regeneration']) copyFileSync(join(root, 'textures/mob_effect', `${name}.png`), join(out, 'gui', `effect_${name}.png`))

// Inventory icons: the pack's item texture, else its block texture of the same
// name; the rest (most blocks) are drawn from their model in the game.
const icons: Record<string, string> = {}
mkdirSync(join(out, 'icons'), { recursive: true })
for (const { key } of allItems()) {
    const path = [join(root, 'textures/item', `${key}.png`), join(root, 'textures/block', `${key}.png`)].find(p => existsSync(p))
    if (!path || (blocks[key] && !path.includes('/item/'))) continue
    copyFileSync(path, join(out, 'icons', `${key}.png`))
    icons[key] = `${key}.png`
}
// Flowers show their flat picture in the inventory, as Minecraft's item models do:
// the small ones their block texture, the tall ones their head.
const FLOWER_ICONS: Record<string, string> = {
    ...Object.fromEntries(['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip'].map(k => [k, k])),
    sunflower: 'sunflower_front', lilac: 'lilac_top', rose_bush: 'rose_bush_top', peony: 'peony_top'
}
for (const [key, tex] of Object.entries(FLOWER_ICONS)) {
    const path = join(root, 'textures/block', `${tex}.png`)
    if (!existsSync(path)) {
        warnings.push(`missing flower texture ${tex}`)
        continue
    }
    copyFileSync(path, join(out, 'icons', `${key}.png`))
    icons[key] = `${key}.png`
}
// The splash potion of weakness you can buy (and throw at a zombie villager).
potionImage(POTION_COLORS.weakness, join(out, 'icons', 'splash_potion_weakness.png'))
icons.splash_potion_weakness = 'splash_potion_weakness.png'
// Leather armour's icons are grey in the pack (Minecraft dyes them as it draws them): dye them brown.
for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
    const base = join(root, 'textures/item', `leather_${piece}.png`)
    if (existsSync(base)) dyeLeather(base, join(root, 'textures/item', `leather_${piece}_overlay.png`), join(out, 'icons', `leather_${piece}.png`))
}

// Sounds, by group: every variant of a sound plays at random. The pack has no
// stone sounds, so the game uses gravel, pitched down, for stone-like blocks.
const SOUND_GROUPS: Record<string, string[]> = {
    grass: ['step/grass1', 'step/grass2', 'step/grass3', 'step/grass4', 'step/grass5', 'step/grass6'],
    gravel: ['step/gravel1', 'step/gravel2', 'step/gravel3', 'step/gravel4'],
    sand: ['step/sand1', 'step/sand2', 'step/sand3', 'step/sand4', 'step/sand5'],
    wood: ['step/wood1', 'step/wood2', 'step/wood3', 'step/wood4', 'step/wood5', 'step/wood6'],
    cloth: ['step/cloth1', 'step/cloth2', 'step/cloth3', 'step/cloth4'],
    glass: ['random/glass1', 'random/glass2', 'random/glass3'],
    pop: ['random/pop'],
    click: ['random/click'],
    chestOpen: ['random/chestopen'],
    chestClose: ['random/chestclosed'],
    splash: ['liquid/splash', 'liquid/splash1', 'liquid/splash2'],
    fizz: ['random/fizz'],
    // The pack's only fire sound: catching fire (it has no crackle loop).
    ignite: ['fire/ignite'],
    rain: ['ambient/weather/rain1', 'ambient/weather/rain2', 'ambient/weather/rain3', 'ambient/weather/rain4', 'ambient/weather/rain5', 'ambient/weather/rain6', 'ambient/weather/rain7', 'ambient/weather/rain8'],
    thunder: ['ambient/weather/thunder1', 'ambient/weather/thunder2', 'ambient/weather/thunder3'],
    // Hurting (you and the mobs: the pack has no mob voices), creepers, skeletons' bows.
    hurt: ['random/classic_hurt'],
    explode: ['random/explode1', 'random/explode2', 'random/explode3', 'random/explode4'],
    fuse: ['random/fuse'],
    bow: ['random/bow'],
    arrowHit: ['random/bowhit1', 'random/bowhit2', 'random/bowhit3', 'random/bowhit4'],
    drink: ['random/drink'],
    cure: ['random/levelup'],
    pistonOut: ['tile/piston/out'],
    pistonIn: ['tile/piston/in']
}
const sounds: Record<string, string[]> = {}
mkdirSync(join(out, 'sounds'), { recursive: true })
for (const [group, names] of Object.entries(SOUND_GROUPS)) {
    sounds[group] = []
    for (const name of names) {
        const path = join(root, 'sounds', `${name}.ogg`)
        if (!existsSync(path)) {
            warnings.push(`missing sound ${name}`)
            continue
        }
        const file = `${name.replace(/\//g, '__')}.ogg`
        copyFileSync(path, join(out, 'sounds', file))
        sounds[group].push(file)
    }
}

writeFileSync(join(out, 'blocks.json'), JSON.stringify({ textures: files, models, blocks, icons, crack, sounds }))
writeFileSync(join(out, 'LICENSE.txt'), `Skyfarm block textures and models

Derived from Pixel Perfection by XSSheep (https://www.minecraftforum.net/members/XSSheep),
continued as Pixel Perfection Legacy by Nova_Wostra (https://modrinth.com/resourcepack/pixel-perfection-legacy).

Licensed under the Creative Commons Attribution-ShareAlike 4.0 International License:
https://creativecommons.org/licenses/by-sa/4.0/

Changes: a subset of the pack's block textures and models, re-packed into one JSON
file; some models (chest, hopper, lever, button, repeater, pistons, observer, cactus,
farmland, redstone dust) are simple shapes of our own using the pack's textures.

Sounds (sounds/): copied as they ship in the same pack. The pack does not say who
made them, and they appear to be classic Minecraft sounds rather than the pack
authors' own work, so the license above may not cover them.
`)

console.log(`${Object.keys(blocks).length} blocks, ${models.length} models, ${textures.length} textures`)
for (const w of [...new Set(warnings)]) console.warn(`  ${w}`)
