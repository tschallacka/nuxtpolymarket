import { B, lightOf, opacityOf } from './blocks'

/*
 * The island: owned 16x16x16 cubes of space floating in the void. Blocks are
 * stored per 16x16 column, 64 blocks tall (four cubes stacked), as two parallel
 * byte arrays: the block id and a meta byte (fluid level, facing, power,
 * growth stage, depending on the block). A column exists once any cube in it
 * is owned; blocks can only go into owned cubes. Coordinates are integer block
 * positions; x and z can be negative (the starting cube is 0,1,0), y runs 0
 * (bottom) to HEIGHT - 1.
 */

export const CHUNK = 16
export const HEIGHT = 64
/** Cubes stacked in a column. */
export const LAYERS = HEIGHT / CHUNK
const LAYER = CHUNK * CHUNK
export const VOLUME = LAYER * HEIGHT

export function cubeKey(cx: number, cy: number, cz: number) {
    return `${cx},${cy},${cz}`
}

/** The six cubes sharing a face with a cube. */
export const CUBE_SIDES: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

export interface Chunk {
    cx: number
    cz: number
    blocks: Uint8Array
    meta: Uint8Array
}

export function chunkKey(cx: number, cz: number) {
    return `${cx},${cz}`
}

/** Index of a block inside its chunk's arrays: x fastest, then z, then y. */
export function index(lx: number, y: number, lz: number) {
    return y * LAYER + lz * CHUNK + lx
}

export class World {
    readonly chunks = new Map<string, Chunk>()
    /** Chunks whose look changed since the mesher last ran. */
    readonly dirty = new Set<string>()
    /** How many times each chunk (or what lights it) changed: caches of derived data compare against it. */
    readonly revisions = new Map<string, number>()
    /** Every block change, for the simulation's neighbour updates. */
    onChange: ((x: number, y: number, z: number, before: number) => void) | null = null

    /** The owned cubes, by cubeKey. */
    readonly cubes = new Set<string>()

    /** The storage column at (cx, cz), made (all air) if it isn't there yet. */
    private column(cx: number, cz: number): Chunk {
        const key = chunkKey(cx, cz)
        let chunk = this.chunks.get(key)
        if (!chunk) {
            chunk = { cx, cz, blocks: new Uint8Array(VOLUME), meta: new Uint8Array(VOLUME) }
            this.chunks.set(key, chunk)
            this.dirty.add(key)
        }
        return chunk
    }

    /** Owns one cube of space: empty (all air) until you build in it. */
    addCube(cx: number, cy: number, cz: number): Chunk {
        const chunk = this.column(cx, cz)
        if (cy >= 0 && cy < LAYERS) this.cubes.add(cubeKey(cx, cy, cz))
        return chunk
    }

    /** Owns a whole column, every cube in it (older islands, and tests). */
    addChunk(cx: number, cz: number): Chunk {
        for (let cy = 0; cy < LAYERS; cy++) this.cubes.add(cubeKey(cx, cy, cz))
        return this.column(cx, cz)
    }

    /** Whether any cube in the column at (cx, cz) is owned. */
    owns(cx: number, cz: number) {
        return this.chunks.has(chunkKey(cx, cz))
    }

    ownsCube(cx: number, cy: number, cz: number) {
        return this.cubes.has(cubeKey(cx, cy, cz))
    }

    /** Whether (x, y, z) is in an owned cube, so a block may go there. */
    ownsAt(x: number, y: number, z: number) {
        return this.ownsCube(Math.floor(x / CHUNK), Math.floor(y / CHUNK), Math.floor(z / CHUNK))
    }

    /** A block's storage: anywhere in a stored column (reads see air outside owned cubes). */
    private locate(x: number, y: number, z: number) {
        if (y < 0 || y >= HEIGHT) return null
        const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK)
        const chunk = this.chunks.get(chunkKey(cx, cz))
        if (!chunk) return null
        return { chunk, i: index(x - cx * CHUNK, y, z - cz * CHUNK) }
    }

    get(x: number, y: number, z: number): number {
        const at = this.locate(x, y, z)
        return at ? at.chunk.blocks[at.i]! : B.Air
    }

    meta(x: number, y: number, z: number): number {
        const at = this.locate(x, y, z)
        return at ? at.chunk.meta[at.i]! : 0
    }

    /** Places a block (and its meta). Returns false outside the owned cubes. */
    set(x: number, y: number, z: number, id: number, meta = 0): boolean {
        const at = this.locate(x, y, z)
        if (!at || !this.ownsAt(x, y, z)) return false
        const before = at.chunk.blocks[at.i]!
        const beforeMeta = at.chunk.meta[at.i]!
        if (before === id && beforeMeta === meta) return true
        at.chunk.blocks[at.i] = id
        at.chunk.meta[at.i] = meta
        this.markDirty(x, z, at.chunk, lightChanges(before, beforeMeta, id, meta))
        this.onChange?.(x, y, z, before)
        return true
    }

    /** Changes only the meta byte (a growth stage, a fluid level); still re-meshes. */
    setMeta(x: number, y: number, z: number, meta: number) {
        const at = this.locate(x, y, z)
        if (!at || at.chunk.meta[at.i] === meta || !this.ownsAt(x, y, z)) return
        const id = at.chunk.blocks[at.i]!
        const light = lightChanges(id, at.chunk.meta[at.i]!, id, meta)
        at.chunk.meta[at.i] = meta
        this.markDirty(x, z, at.chunk, light)
        this.onChange?.(x, y, z, id)
    }

    private markDirty(x: number, z: number, chunk: Chunk, light: boolean) {
        this.touch(chunkKey(chunk.cx, chunk.cz))
        // Light reaches 15 blocks: a change in what glows or what blocks light can
        // reach into any neighbouring chunk, so they all re-mesh.
        if (light) {
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) this.touch(chunkKey(chunk.cx + dx, chunk.cz + dz))
            return
        }
        // A block on a chunk edge changes which faces its neighbour shows.
        const lx = x - chunk.cx * CHUNK, lz = z - chunk.cz * CHUNK
        if (lx === 0) this.touch(chunkKey(chunk.cx - 1, chunk.cz))
        if (lx === CHUNK - 1) this.touch(chunkKey(chunk.cx + 1, chunk.cz))
        if (lz === 0) this.touch(chunkKey(chunk.cx, chunk.cz - 1))
        if (lz === CHUNK - 1) this.touch(chunkKey(chunk.cx, chunk.cz + 1))
    }

    private touch(key: string) {
        this.dirty.add(key)
        this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    }

    /** The highest non-air block in a column, or -1 (open void). */
    top(x: number, z: number) {
        if (!this.owns(Math.floor(x / CHUNK), Math.floor(z / CHUNK))) return -1
        for (let y = HEIGHT - 1; y >= 0; y--) if (this.get(x, y, z) !== B.Air) return y
        return -1
    }
}

/** Whether swapping one block for another changes how light spreads (what it gives off, or holds back). */
function lightChanges(a: number, am: number, b: number, bm: number) {
    return lightOf(a, am) !== lightOf(b, bm) || opacityOf(a, am) !== opacityOf(b, bm)
}

/** The cube you start with: x and z 0..15, y 16..31. */
export const STARTER_CUBE: [number, number, number] = [0, 1, 0]
/** Where the starter island sits: its grass is at y = STARTER_TOP - 1. */
export const STARTER_TOP = 24

/**
 * The classic start: an L of dirt and grass, three deep, each arm six long and
 * three wide, with a tree at the end of one arm and the starting chest at the
 * end of the other. All in the starter cube, with room to build above.
 */
export function starterIsland(world: World) {
    world.addCube(...STARTER_CUBE)
    const top = STARTER_TOP
    for (let x = 4; x < 10; x++) {
        for (let z = 4; z < 10; z++) {
            // The arm along x (z 4..6) and the arm along z (x 4..6).
            if (z >= 7 && x >= 7) continue
            for (let y = top - 3; y < top; y++) world.set(x, y, z, y === top - 1 ? B.Grass : B.Dirt)
        }
    }
    world.set(5, top - 4, 5, B.Bedrock)
    // A tree at the far end of the z arm.
    for (let y = top; y < top + 4; y++) world.set(5, y, 8, B.OakLog)
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            for (let dy = 2; dy <= 4; dy++) {
                if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue
                if (dy === 4 && (Math.abs(dx) > 1 || Math.abs(dz) > 1)) continue
                if (dx === 0 && dz === 0 && dy < 4) continue
                world.set(5 + dx, top + dy, 8 + dz, B.OakLeaves)
            }
        }
    }
    // The starting chest at the far end of the x arm.
    world.set(8, top, 5, B.Chest)
    return { spawn: { x: 5.5, y: top, z: 5.5 }, chest: { x: 8, y: top, z: 5 } }
}
