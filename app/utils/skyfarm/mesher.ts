import { B, block, occludesWith } from './blocks'
import type { BlockPack, Dir, PackElement, PackFace, PackVariant, Vec3 } from './pack'
import { computeLight, MAX_LIGHT, type LightField } from './light'
import { fluidFlow, fluidHeight } from './sim'
import { CHUNK, HEIGHT, World, type Chunk } from './world'

/** What meshing needs from the block pack: plain data, so a worker can have it too. */
export type MeshPack = Pick<BlockPack, 'looks' | 'layer' | 'anim' | 'models'>

/*
 * Turns one chunk into buffers, block by block from the pack's models
 * (Minecraft's model format: boxes with per-face uvs). Three passes: opaque,
 * cutout (leaves, plants, glass: alpha-tested) and translucent (water, ice).
 * A face with a cull side is dropped when the neighbour on that side is an
 * opaque cube; faces on the island's underside stay (it floats). Pure, so it
 * can run in a worker or a test.
 */

export interface MeshData {
    position: Float32Array
    normal: Float32Array
    color: Float32Array
    uv: Float32Array
    layer: Float32Array
    anim: Float32Array
    /** Light at each corner: sky and block, 0..1 (the shader turns it into brightness). */
    light: Float32Array
    index: Uint32Array
}

/** Sky and block light at a corner, 0..1. */
type Lit = [number, number]
const FULL_SKY: Lit[] = [[1, 0], [1, 0], [1, 0], [1, 0]]

/**
 * Minecraft's fixed face shading, baked in: tops full, bottoms half, the
 * north and south sides 0.8, east and west 0.6 (blended for tilted faces).
 */
function faceShade(n: Vec3) {
    return Math.abs(n[0]) * 0.6 + Math.abs(n[2]) * 0.8 + (n[1] > 0 ? n[1] : -n[1] * 0.5)
}

class Writer {
    pos: number[] = []
    nrm: number[] = []
    col: number[] = []
    uvs: number[] = []
    lay: number[] = []
    ani: number[] = []
    lit: number[] = []
    idx: number[] = []

    /** Four corners in texture order (top-left, top-right, bottom-right, bottom-left), wound to face `n`. */
    /** `flat`: shaded as if facing up whatever its normal (plants, torches). */
    quad(corners: Vec3[], uv: [number, number][], n: Vec3, rgb: Vec3, ao: number[], layer: number, anim: number, light: Lit[] = FULL_SKY, flat = false) {
        const base = this.pos.length / 3
        const shade = flat ? 1 : faceShade(n)
        for (let i = 0; i < 4; i++) {
            const c = corners[i]!
            this.pos.push(c[0], c[1], c[2])
            this.nrm.push(n[0], n[1], n[2])
            const k = ao[i]! * shade
            this.col.push(rgb[0] * k, rgb[1] * k, rgb[2] * k)
            this.uvs.push(uv[i]![0], uv[i]![1])
            this.lay.push(layer)
            this.ani.push(anim)
            this.lit.push(light[i]![0], light[i]![1])
        }
        // Wind counter-clockwise as seen from the side the normal points to.
        const [a, b, c] = corners as [Vec3, Vec3, Vec3]
        const e1 = sub(b, a), e2 = sub(c, a)
        const facing = dot(cross(e1, e2), n) > 0
        // Split along the diagonal with the brighter corners, so AO gradients don't crease.
        const flip = ao[0]! + ao[2]! < ao[1]! + ao[3]!
        const tri = flip ? [1, 2, 3, 1, 3, 0] : [0, 1, 2, 0, 2, 3]
        for (let i = 0; i < 6; i += 3) {
            const [p, q, r] = [tri[i]!, tri[i + 1]!, tri[i + 2]!]
            if (facing) this.idx.push(base + p, base + q, base + r)
            else this.idx.push(base + p, base + r, base + q)
        }
    }

    done(): MeshData {
        return {
            position: new Float32Array(this.pos),
            normal: new Float32Array(this.nrm),
            color: new Float32Array(this.col),
            uv: new Float32Array(this.uvs),
            layer: new Float32Array(this.lay),
            anim: new Float32Array(this.ani),
            light: new Float32Array(this.lit),
            index: new Uint32Array(this.idx)
        }
    }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export const DIRS: Record<Dir, Vec3> = {
    down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0]
}

/** A face's corners in Minecraft's texture order: top-left, top-right, bottom-right, bottom-left. */
function faceCorners(dir: Dir, f: Vec3, t: Vec3): Vec3[] {
    switch (dir) {
        case 'up': return [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]]
        case 'down': return [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], f[1], f[2]], [f[0], f[1], f[2]]]
        case 'north': return [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [f[0], f[1], f[2]], [t[0], f[1], f[2]]]
        case 'south': return [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]]
        case 'west': return [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]]]
        case 'east': return [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]]]
    }
}

/** Rotates p (in pixels) about `origin` by `deg` degrees around `axis`, right-handed. */
function rotate(p: Vec3, axis: 'x' | 'y' | 'z', deg: number, origin: Vec3, scale: Vec3 = [1, 1, 1]): Vec3 {
    if (!deg) return p
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
    const x = (p[0] - origin[0]) * scale[0], y = (p[1] - origin[1]) * scale[1], z = (p[2] - origin[2]) * scale[2]
    let q: Vec3
    if (axis === 'x') q = [x, y * c - z * s, y * s + z * c]
    else if (axis === 'y') q = [x * c + z * s, y, -x * s + z * c]
    else q = [x * c - y * s, x * s + y * c, z]
    return [q[0] + origin[0], q[1] + origin[1], q[2] + origin[2]]
}

const CENTRE: Vec3 = [8, 8, 8]

/**
 * A blockstate rotation: x first, then y, both clockwise looking down the
 * axis from the positive side, as Minecraft's blockstates turn models.
 */
function turn(p: Vec3, v: PackVariant): Vec3 {
    return rotate(rotate(p, 'x', -v.x, CENTRE), 'y', -v.y, CENTRE)
}

function turnDir(d: Vec3, v: PackVariant): Vec3 {
    const p = turn([8 + d[0] * 8, 8 + d[1] * 8, 8 + d[2] * 8], v)
    return [Math.round((p[0] - 8) / 8), Math.round((p[1] - 8) / 8), Math.round((p[2] - 8) / 8)]
}

/** Which of a block's looks applies, from its meta byte. */
export function stateOf(id: number, meta: number) {
    switch (id) {
        case B.Wheat: return meta & 7
        // A stem: its age, or once it has grown its fruit (bit 3) one of four attached looks (bits 4-5).
        case B.MelonStem:
        case B.PumpkinStem: return meta & 8 ? 8 + ((meta >> 4) & 3) : meta & 7
        // Farmland: dry, or moist.
        case B.Farmland: return meta & 1
        // A two-block plant: its lower half, or its upper.
        case B.DoubleTallGrass:
        case B.Sunflower:
        case B.Lilac:
        case B.RoseBush:
        case B.Peony: return meta & 1
        // Floor or one of four walls (bits 0-2), lit unless bit 3 says burnt out.
        case B.RedstoneTorch: {
            const wall = Math.min(4, meta & 7)
            return (wall ? 2 + (wall - 1) * 2 : 0) + (meta & 8 ? 1 : 0)
        }
        // Which sides the dust links to (bits 4-7).
        case B.RedstoneDust: return (meta >> 4) & 15
        // Bottom half, top half, double.
        case B.OakSlab:
        case B.CobblestoneSlab:
        case B.StoneSlab:
        case B.StoneBrickSlab: return Math.min(2, meta & 3)
        // How full: a composter 0 to 8, a cauldron 0 to 3.
        case B.Composter: return Math.min(8, meta)
        case B.Cauldron: return meta & 3
        case B.Smoker:
        case B.BlastFurnace: return (meta & 8 ? 4 : 0) + (meta & 3)
        case B.Stonecutter:
        case B.Grindstone:
        case B.Lectern:
        case B.Loom: return meta & 3
        // On the floor (0), or on one of four walls (1 to 4).
        case B.Torch: return Math.min(4, meta & 7)
        // Unlit or lit (bit 3), times four facings (bits 0-1).
        case B.Furnace: return (meta & 8 ? 4 : 0) + (meta & 3)
        case B.JackOLantern: return meta & 3
        // Where it sits or which way it faces (bits 0-2), times off and on (bit 3).
        case B.Lever:
        case B.Button:
        case B.Observer:
        case B.Piston:
        case B.StickyPiston:
        case B.PistonHead: return Math.min(5, meta & 7) * 2 + ((meta >> 3) & 1)
        // Sending one of four ways (bits 0-1), off or powered.
        case B.Repeater: return (meta & 3) * 2 + (meta & 16 ? 1 : 0)
        case B.Dropper:
        case B.Dispenser:
        case B.BlockBreaker:
        case B.Hopper: return Math.min(5, meta & 7)
        default: return 0
    }
}

/** A stable pseudo-random pick among weighted variants, by position (Minecraft does the same). */
function pickVariant(list: PackVariant[], x: number, y: number, z: number) {
    if (list.length === 1) return list[0]!
    let h = Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ Math.imul(y, 2654435761)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    const total = list.reduce((n, v) => n + v.weight, 0)
    let r = ((h >>> 0) % 10007) / 10007 * total
    for (const v of list) {
        r -= v.weight
        if (r < 0) return v
    }
    return list[list.length - 1]!
}

/** Whether the block at (x, y, z) fills its cell and hides what is behind it. */
function opaqueAt(world: World, x: number, y: number, z: number) {
    return occludesWith(world.get(x, y, z), world.meta(x, y, z))
}

/** Ambient occlusion at a face corner from its two edge neighbours and the diagonal one. */
function cornerAo(world: World, x: number, y: number, z: number, n: Vec3, corner: Vec3) {
    // The corner's offset from the face centre, in the face plane (-1 or 1 per axis).
    const d = corner.map((c, i) => (n[i] !== 0 ? 0 : c > 0.5 ? 1 : -1))
    const axes = [0, 1, 2].filter(i => n[i] === 0)
    const side = (axis: number) => {
        const p = [x + n[0], y + n[1], z + n[2]]
        p[axis]! += d[axis]!
        return opaqueAt(world, p[0]!, p[1]!, p[2]!) ? 1 : 0
    }
    const s1 = side(axes[0]!), s2 = side(axes[1]!)
    const c = opaqueAt(world, x + n[0] + d[0]!, y + n[1] + d[1]!, z + n[2] + d[2]!) ? 1 : 0
    const level = s1 && s2 ? 0 : 3 - (s1 + s2 + c)
    return 0.5 + level * (0.5 / 3)
}

/** sRGB 0xRRGGBB to a roughly linear colour (the vertex colours are linear). */
function linear(c: number): Vec3 {
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255
    return [r * r, g * g, b * b]
}

const WHITE: Vec3 = [1, 1, 1]
const NO_AO = [1, 1, 1, 1]

/** Redstone dust: dark when unpowered, bright red at full power. */
function dustTint(power: number): Vec3 {
    const k = power / 15
    return linear(((0x4b + Math.round(k * 0xb4)) << 16) | (Math.round(k * 0x14) << 8))
}

export interface ChunkMeshes {
    opaque: MeshData
    cutout: MeshData
    translucent: MeshData
    /** The chunk's light, worked out for this mesh (kept for lighting what moves through it). */
    light: LightField
}

/**
 * Smooth lighting at a face corner, Minecraft's way: the average of the cell
 * in front of the face and the three around that corner in front of it,
 * leaving out the ones a solid block fills.
 */
function cornerLight(field: LightField, world: World, x: number, y: number, z: number, n: Vec3, corner: Vec3): Lit {
    const d = corner.map((c, i) => (n[i] !== 0 ? 0 : c > 0.5 ? 1 : -1))
    const axes = [0, 1, 2].filter(i => n[i] === 0)
    const fx = x + n[0], fy = y + n[1], fz = z + n[2]
    const cells: Vec3[] = [[fx, fy, fz]]
    for (const a of axes) {
        const c: Vec3 = [fx, fy, fz]
        c[a] = c[a]! + d[a]!
        cells.push(c)
    }
    cells.push([fx + d[0]!, fy + d[1]!, fz + d[2]!])
    let sky = 0, glow = 0, count = 0
    cells.forEach((c, i) => {
        if (i > 0 && opaqueAt(world, c[0], c[1], c[2])) return
        const [s, b] = field.at(c[0], c[1], c[2])
        sky += s
        glow += b
        count++
    })
    return [sky / count / MAX_LIGHT, glow / count / MAX_LIGHT]
}

/** The light in a block's own cell (for faces inside it: plants, torches, half slabs). */
function ownLight(field: LightField, x: number, y: number, z: number): Lit {
    const [s, b] = field.at(x, y, z)
    return [s / MAX_LIGHT, b / MAX_LIGHT]
}

function passOf(id: number): 'opaque' | 'cutout' | 'translucent' {
    if (id === B.Water || id === B.Ice) return 'translucent'
    const def = block(id)
    return def.transparent || def.shape !== 'cube' ? 'cutout' : 'opaque'
}

export function meshChunk(world: World, chunk: Chunk, pack: MeshPack): ChunkMeshes {
    const writers = { opaque: new Writer(), cutout: new Writer(), translucent: new Writer() }
    const field = computeLight(world, chunk.cx, chunk.cz)
    const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK
    for (let y = 0; y < HEIGHT; y++) {
        for (let lz = 0; lz < CHUNK; lz++) {
            for (let lx = 0; lx < CHUNK; lx++) {
                const i = y * CHUNK * CHUNK + lz * CHUNK + lx
                const id = chunk.blocks[i]!
                if (id === B.Air) continue
                const x = ox + lx, z = oz + lz
                const meta = chunk.meta[i]!
                if (id === B.Water || id === B.Lava) fluid(writers[passOf(id)], world, pack, id, meta, x, y, z, field)
                else model(writers[passOf(id)], world, pack, id, meta, x, y, z, field)
            }
        }
    }
    return { opaque: writers.opaque.done(), cutout: writers.cutout.done(), translucent: writers.translucent.done(), light: field }
}

/**
 * One block on its own, in a unit cube at the origin: for a dropped item or
 * the block in your hand. Full light; the renderer lights these as a whole.
 */
export function meshBlock(pack: MeshPack, id: number, meta = 0): MeshData {
    const w = new Writer()
    // An empty world: nothing to cull against, no occlusion.
    model(w, new World(), pack, id, meta, 0, 0, 0, null)
    return w.done()
}

function model(w: Writer, world: World, pack: MeshPack, id: number, meta: number, x: number, y: number, z: number, field: LightField | null) {
    const look = pack.looks[id]
    if (!look) return
    const variants = look.states[stateOf(id, meta)] ?? look.states[0]!
    const v = pickVariant(variants, x, y, z)
    const m = pack.models[v.model]
    if (!m) return
    const transparent = block(id).transparent
    for (const e of m.elements) {
        for (const [dir, f] of Object.entries(e.faces) as [Dir, PackFace][]) {
            let cullDir: Vec3 | null = null
            if (f.cull) {
                cullDir = turnDir(DIRS[f.cull], v)
                const nb = world.get(x + cullDir[0], y + cullDir[1], z + cullDir[2])
                const nx = x + cullDir[0], ny = y + cullDir[1], nz = z + cullDir[2]
                if (occludesWith(nb, world.meta(nx, ny, nz)) || (transparent && nb === id && id !== B.OakLeaves)) continue
            }
            emitFace(w, world, pack, look.tints, id, meta, e, dir, f, v, x, y, z, m.ao && !!cullDir, cullDir, field)
        }
    }
}

function emitFace(w: Writer, world: World, pack: MeshPack, tints: number[], id: number, meta: number,
    e: PackElement, dir: Dir, f: PackFace, v: PackVariant, x: number, y: number, z: number, ao: boolean, cullDir: Vec3 | null, field: LightField | null) {
    let corners = faceCorners(dir, e.from, e.to)
    let normal: Vec3 = DIRS[dir]
    if (e.rot) {
        const r = e.rot
        // Rescale stretches the rotated face back across the full block (crossed plants).
        const k = r.rescale ? 1 / Math.cos((Math.abs(r.angle) * Math.PI) / 180) : 1
        const scale: Vec3 = r.axis === 'x' ? [1, k, k] : r.axis === 'y' ? [k, 1, k] : [k, k, 1]
        corners = corners.map(c => rotate(c, r.axis, r.angle, r.origin, scale))
        normal = rotate(normal, r.axis, r.angle, [0, 0, 0])
    }
    corners = corners.map(c => turn(c, v))
    normal = sub(turn([8 + normal[0], 8 + normal[1], 8 + normal[2]], v), CENTRE)
    const world3 = corners.map(c => [x + c[0] / 16, y + c[1] / 16, z + c[2] / 16] as Vec3)

    // Texture coordinates, rotated in 90 degree steps if the face asks.
    const [u1, v1, u2, v2] = f.uv
    const base: [number, number][] = [[u1, v1], [u2, v1], [u2, v2], [u1, v2]]
    const steps = ((f.rot ?? 0) / 90) & 3
    const uv = base.map((_, i) => base[(i + steps) & 3]!).map(([u, t]) => [u / 16, t / 16] as [number, number])

    let tint = WHITE
    if (f.tint !== undefined) tint = id === B.RedstoneDust ? dustTint(meta & 15) : tints[f.tint] !== undefined ? linear(tints[f.tint]!) : WHITE
    const aoValues = ao && cullDir ? corners.map(c => cornerAo(world, x, y, z, cullDir, [c[0] / 16, c[1] / 16, c[2] / 16])) : NO_AO
    // Light: a face on the block's edge takes it from the cells in front (smoothly, per
    // corner); a face inside the block's own cell (plants, torches) from that cell.
    let light = FULL_SKY
    if (field) {
        light = cullDir
            ? corners.map(c => cornerLight(field, world, x, y, z, cullDir, [c[0] / 16, c[1] / 16, c[2] / 16]))
            : [0, 1, 2, 3].map(() => ownLight(field, x, y, z))
    }
    // Plants and dust ignore which way their faces point: lit as if facing up.
    // (Only the shading: the face still winds by its real normal, or it shows from behind.)
    w.quad(world3, uv, normal, tint, aoValues, pack.layer[f.t]!, pack.anim[f.t]!, light, !e.shade)
}

/**
 * Water and lava: a box whose top sinks with the level (a source fills 8/9),
 * textured with the pack's still texture across world space.
 */
function fluid(w: Writer, world: World, pack: MeshPack, id: number, meta: number, x: number, y: number, z: number, field: LightField) {
    const look = pack.looks[id]
    const faces = look ? pack.models[look.states[0]![0]!.model]?.elements[0]?.faces : undefined
    const still = faces?.up
    if (!look || !still) return
    const flowing = faces.north ?? still
    const top = fluidHeight(world, id, meta, x, y, z)
    const tint = still.tint !== undefined && look.tints[still.tint] !== undefined ? linear(look.tints[still.tint]!) : WHITE
    // Moving fluid shows the flowing texture on its surface, running the way it flows
    // (snapped to the nearest of the four directions); a still pool shows the still one.
    const [fx, fz] = fluidFlow(world, x, y, z)
    const moving = fx !== 0 || fz !== 0
    // The flow texture runs down its v axis: turn it so v points along the flow.
    // (The surface's corners run x0z0, x1z0, x1z1, x0z1: no turn sends v along +z, one along +x.)
    const turns = !moving ? 0 : Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : (fz > 0 ? 0 : 2)
    for (const dir of Object.keys(DIRS) as Dir[]) {
        const d = DIRS[dir]
        const nx = x + d[0], ny = y + d[1], nz = z + d[2]
        const nb = world.get(nx, ny, nz)
        if (opaqueAt(world, nx, ny, nz)) continue
        // Beside the same fluid, a side shows only the step where this one stands higher;
        // without it, the step between two levels is a see-through gap.
        let bottom = 0
        if (nb === id) {
            if (d[1] !== 0) continue
            bottom = fluidHeight(world, id, world.meta(nx, ny, nz), nx, ny, nz)
            if (bottom >= top) continue
        }
        const corners = faceCorners(dir, [0, bottom * 16, 0], [16, top * 16, 16]).map(c => [x + c[0] / 16, y + c[1] / 16, z + c[2] / 16] as Vec3)
        const flat = dir === 'up' || dir === 'down'
        const square: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
        const uv: [number, number][] = flat
            ? square.map((_, i) => square[(i + turns) & 3]!)
            : [[0, 1 - top], [1, 1 - top], [1, 1 - bottom], [0, 1 - bottom]]
        // Sides always flow (down them); the surface flows only where the fluid moves.
        const face = flat && !moving ? still : flowing
        // The flow texture is twice the size of a block face (32 pixels): a block shows
        // half of it, as in Minecraft, so its pixels match everything else's.
        const scale = face === flowing && flowing !== still ? 0.5 : 1
        // Lit by the brighter of its own cell and the one the face looks into (lava lights itself).
        const [os, ob] = field.at(x, y, z), [fs, fb] = field.at(nx, ny, nz)
        const lit: Lit = [Math.max(os, fs) / MAX_LIGHT, Math.max(ob, fb) / MAX_LIGHT]
        w.quad(corners, uv.map(([u, v]) => [u * scale, v * scale] as [number, number]), d, tint, NO_AO, pack.layer[face.t]!, pack.anim[face.t]!, [lit, lit, lit, lit])
    }
}
