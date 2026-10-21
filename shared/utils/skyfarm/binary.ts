import { itemId, itemKey } from './item-ids'
import { SAVED_MOB_KINDS, SKYFARM_LIMITS, SKYFARM_SAVE_VERSION, validateSkyfarmState, type ItemStack, type SkyfarmSave } from './save'

/*
 * Skyfarm's save files, region-file style: one file per 16x16x64 column, and a
 * map file that indexes them. Every file is gzipped as a whole by whoever
 * sends or stores it; the layouts below are before gzip. Little-endian; f64 is
 * an IEEE double. No JSON: every field has a fixed binary form.
 *
 * Items are stored as ids (item-ids.ts) and only as ids: the game works with
 * item keys, and saving and loading translate. A slot is
 *
 *   u16 id, u8 count      (id 0: an empty slot, count 0)
 *
 * A column file is the column's raw bytes, then the containers standing in it
 * (a chest's items travel with its column, as in Minecraft's chunks):
 *
 *   16384 bytes            block ids, x fastest, then z, then y
 *   16384 bytes            meta
 *   u16                    container count, then per container:
 *     u8 x, u8 y, u8 z     its block, within the column
 *     u8 kind              0 a container, 1 a furnace
 *     u8 n, n slots
 *     furnace only: u32 fuel ticks left, u32 the fuel's full burn, u32 smelt ticks done
 *
 * Column files are named by the SHA-256 of those bytes, so a column that
 * didn't change keeps its file: a save sends only the columns that changed,
 * and a loaded column can be cached for good.
 *
 * The map file is the island's state and the index of its columns:
 *
 *   "SKYM", u8 format (SKYFARM_FORMAT)
 *   state                  see writeState below
 *   u32                    column count, then per column:
 *     i16 cx, i16 cz
 *     u8 cubes             which of its four cubes you own (bit cy)
 *     32 bytes             SHA-256 of its column file
 *
 * A save travels as a bundle: the map file and the new column files.
 *
 *   "SKYB", u8 format
 *   u32 n, n bytes         the map file, gzipped
 *   u32                    column file count, then per file:
 *     32 bytes             its SHA-256 (of the bytes before gzip)
 *     u32 n, n bytes       the column file, gzipped
 *
 * Older formats are still read, so those islands load: 1 (state as JSON,
 * column files without containers), 2 (no build count) and 3 (no redstone
 * ticks). Saving writes 4.
 */

export const SKYFARM_FORMAT = 4
/** Bytes in a column for each of its two arrays: 16 x 16 x 64. */
export const COLUMN_BYTES = 16 * 16 * 64
/** Bytes in a cube for each array: a cube is a contiguous slice of its column (y is the slowest axis). */
export const CUBE_BYTES = 16 * 16 * 16
/** A column file's blocks and meta, before its containers. */
export const COLUMN_BLOCK_BYTES = COLUMN_BYTES * 2
/** The largest a column file can be: every cell a full furnace would be absurd, so: blocks plus the container limit. */
export const MAX_COLUMN_FILE_BYTES = COLUMN_BLOCK_BYTES + 2 + SKYFARM_LIMITS.containers * (6 + SKYFARM_LIMITS.slots * 3 + 12)
/** At most this many columns (of up to four cubes each). */
export const MAX_COLUMNS = 400
const MAX_STATE_BYTES = 2_000_000
/** At most this many redstone ticks due in a save. */
const MAX_REDSTONE_DUE = 100_000
const MAP_MAGIC = [0x53, 0x4b, 0x59, 0x4d]
const BUNDLE_MAGIC = [0x53, 0x4b, 0x59, 0x42]
const WEATHER = ['clear', 'rain', 'thunder'] as const

/** Everything in a save except the blocks and what stands among them. */
export type SkyfarmState = Omit<SkyfarmSave, 'chunks' | 'cubes' | 'containers' | 'furnaces'>
    & Partial<Pick<SkyfarmSave, 'containers' | 'furnaces'>>

/** A chest, hopper, furnace...: its block (world position), its slots, and a furnace's fire. */
export interface SavedContainer {
    x: number
    y: number
    z: number
    slots: (ItemStack | null)[]
    /** A furnace: [fuel ticks left, the fuel's full burn, smelt ticks done]. */
    furnace?: [number, number, number]
}

export interface SkyfarmColumn {
    cx: number
    cz: number
    /** Which of its four cubes you own: bit cy. */
    cubes: number
    blocks: Uint8Array
    meta: Uint8Array
    containers: SavedContainer[]
}

/** The island with its blocks: what Island.toSave gives and Island.fromSave takes. */
export interface SkyfarmIsland {
    state: SkyfarmState
    columns: SkyfarmColumn[]
}

/** An entry in the map file: a column and the hash naming its file. */
export interface SkyfarmColumnRef {
    cx: number
    cz: number
    cubes: number
    hash: string
}

export interface SkyfarmMap {
    format: number
    state: SkyfarmState
    columns: SkyfarmColumnRef[]
}

const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], h => parseInt(h, 16))
const HASH = /^[0-9a-f]{64}$/
const bits = (n: number) => (n & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1)

export const isColumnHash = (s: string) => HASH.test(s)

/** Thrown while reading a malformed file; decoders turn it into null. */
class Bad extends Error {}

class Writer {
    private buf = new Uint8Array(1024)
    private view = new DataView(this.buf.buffer)
    private o = 0

    private room(n: number) {
        if (this.o + n <= this.buf.length) return
        const next = new Uint8Array(Math.max(this.buf.length * 2, this.o + n))
        next.set(this.buf)
        this.buf = next
        this.view = new DataView(next.buffer)
    }

    bytes(b: Uint8Array | readonly number[]) {
        this.room(b.length)
        this.buf.set(b, this.o)
        this.o += b.length
    }

    u8(n: number) {
        this.room(1)
        this.view.setUint8(this.o, n)
        this.o += 1
    }

    u16(n: number) {
        this.room(2)
        this.view.setUint16(this.o, n, true)
        this.o += 2
    }

    i16(n: number) {
        this.room(2)
        this.view.setInt16(this.o, n, true)
        this.o += 2
    }

    u32(n: number) {
        this.room(4)
        this.view.setUint32(this.o, n, true)
        this.o += 4
    }

    i32(n: number) {
        this.room(4)
        this.view.setInt32(this.o, n, true)
        this.o += 4
    }

    f64(n: number) {
        this.room(8)
        this.view.setFloat64(this.o, n, true)
        this.o += 8
    }

    /** A short string (a villager's profession): u8 length, UTF-8. */
    text(s: string) {
        const b = new TextEncoder().encode(s)
        if (b.length > 255) throw new Error('Text too long to save')
        this.u8(b.length)
        this.bytes(b)
    }

    done() {
        return this.buf.slice(0, this.o)
    }
}

class Reader {
    private o = 0
    private view: DataView
    constructor(private b: Uint8Array) {
        this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    }

    private take(n: number) {
        if (this.o + n > this.b.length) throw new Bad()
        const at = this.o
        this.o += n
        return at
    }

    bytes(n: number) {
        const at = this.take(n)
        return this.b.subarray(at, at + n)
    }

    u8() {
        return this.view.getUint8(this.take(1))
    }

    u16() {
        return this.view.getUint16(this.take(2), true)
    }

    i16() {
        return this.view.getInt16(this.take(2), true)
    }

    u32() {
        return this.view.getUint32(this.take(4), true)
    }

    i32() {
        return this.view.getInt32(this.take(4), true)
    }

    f64() {
        const v = this.view.getFloat64(this.take(8), true)
        if (!Number.isFinite(v)) throw new Bad()
        return v
    }

    text() {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(this.u8()))
        } catch {
            throw new Bad()
        }
    }

    get left() {
        return this.b.length - this.o
    }

    end() {
        if (this.o !== this.b.length) throw new Bad()
    }
}

const attempt = <T>(read: () => T): T | null => {
    try {
        return read()
    } catch (e) {
        if (e instanceof Bad) return null
        throw e
    }
}

// ── Items ──────────────────────────────────────────────────────────────

function writeSlot(w: Writer, s: ItemStack | null) {
    if (!s) {
        w.u16(0)
        w.u8(0)
        return
    }
    const id = itemId(s.item)
    if (!id) throw new Error(`Item ${s.item} has no save id: add it to item-ids.ts`)
    w.u16(id)
    w.u8(s.count)
}

function readSlot(r: Reader): ItemStack | null {
    const id = r.u16(), count = r.u8()
    if (id === 0) {
        if (count !== 0) throw new Bad()
        return null
    }
    const item = itemKey(id)
    if (!item || count < 1 || count > SKYFARM_LIMITS.stack) throw new Bad()
    return { item, count }
}

function writeSlots(w: Writer, slots: (ItemStack | null)[]) {
    w.u8(slots.length)
    for (const s of slots) writeSlot(w, s)
}

function readSlots(r: Reader) {
    const n = r.u8()
    if (n > SKYFARM_LIMITS.slots) throw new Bad()
    return Array.from({ length: n }, () => readSlot(r))
}

/** Counts by item (the store, the ledger): u16 n, then per item u16 id, f64 count. */
function writeCounts(w: Writer, counts: Record<string, number>) {
    const entries = Object.entries(counts)
    w.u16(entries.length)
    for (const [key, n] of entries) {
        const id = itemId(key)
        if (!id) throw new Error(`Item ${key} has no save id: add it to item-ids.ts`)
        w.u16(id)
        w.f64(n)
    }
}

function readCounts(r: Reader) {
    const out: Record<string, number> = {}
    const n = r.u16()
    for (let i = 0; i < n; i++) {
        const key = itemKey(r.u16())
        if (!key || key in out) throw new Bad()
        out[key] = r.f64()
    }
    return out
}

// ── The map's state ────────────────────────────────────────────────────

type SavedMob = NonNullable<SkyfarmSave['mobs']>[number]
const MOB_CONV = 1, MOB_PROF = 2, MOB_SITE = 4, MOB_TRADES = 8, MOB_REP = 16, MOB_INV = 32, MOB_VARIANT = 64, MOB_KEEP = 128

/**
 * The state, field by field:
 *   f64 coins, f64 earned, u32 chunks bought, u8 ore level, f64 time
 *   u8 weather (0 clear, 1 rain, 2 thunder), u32 its ticks left
 *   f64 health
 *   f64 x 5 player (x, y, z, yaw, pitch), f64 x 3 spawn
 *   slots inventory, slots armour
 *   counts store
 *   u8 ledger buckets, each: u16 ticks, counts produced, sold, stored, gained
 *   u16 mobs, each: u8 kind, f64 x, y, z, yaw, hp, u8 flags, then as flagged:
 *     conv u16 | prof text | site i32 x 3 | trades: u8 n offers (slot a, slot b
 *     (empty: none), slot out, u8 uses, u8 max, u8 xp), u32 xp, u8 level | rep f64
 *     | inv slots (what a villager carries) | variant u8 (a cat's coat) | keep (no data:
 *     a zombie villager that was a villager)
 *   u32 builds (format 3 on): times the island was changed by hand
 *   u32 n, then n redstone ticks due (format 4 on): u16 ticks from now, text what
 */
function writeState(w: Writer, s: SkyfarmState) {
    w.f64(s.coins)
    w.f64(s.earned)
    w.u32(s.chunksBought)
    w.u8(s.oreLevel)
    w.f64(s.time ?? 0)
    w.u8(Math.max(0, WEATHER.indexOf(s.weather?.kind ?? 'clear')))
    w.u32(s.weather?.ticksLeft ?? 0)
    w.f64(s.health ?? 20)
    for (const v of [s.player.x, s.player.y, s.player.z, s.player.yaw, s.player.pitch, s.spawn.x, s.spawn.y, s.spawn.z]) w.f64(v)
    writeSlots(w, s.inventory)
    writeSlots(w, s.armor ?? [null, null, null, null])
    writeCounts(w, s.store ?? {})
    const ledger = s.ledger ?? []
    w.u8(ledger.length)
    for (const b of ledger) {
        w.u16(b.ticks)
        for (const k of ['produced', 'sold', 'stored', 'gained'] as const) writeCounts(w, b[k])
    }
    const mobs = s.mobs ?? []
    w.u16(mobs.length)
    for (const m of mobs) {
        w.u8(SAVED_MOB_KINDS.indexOf(m.k as typeof SAVED_MOB_KINDS[number]))
        for (const v of [m.x, m.y, m.z, m.yaw, m.hp]) w.f64(v)
        const flags = (m.conv ? MOB_CONV : 0) | (m.prof ? MOB_PROF : 0) | (m.site ? MOB_SITE : 0) | (m.offers ? MOB_TRADES : 0) | (m.rep ? MOB_REP : 0) | (m.inv ? MOB_INV : 0)
            | (m.v !== undefined ? MOB_VARIANT : 0) | (m.keep ? MOB_KEEP : 0)
        w.u8(flags)
        if (m.conv) w.u16(m.conv)
        if (m.prof) w.text(m.prof)
        if (m.site) for (const v of m.site) w.i32(v)
        if (m.offers) {
            w.u8(m.offers.length)
            for (const o of m.offers) {
                writeSlot(w, o.a)
                writeSlot(w, o.b ?? null)
                writeSlot(w, o.out)
                w.u8(o.uses)
                w.u8(o.max)
                w.u8(o.xp)
            }
            w.u32(m.xp ?? 0)
            w.u8(m.level ?? 1)
        }
        if (m.rep) w.f64(m.rep)
        if (m.inv) writeSlots(w, m.inv)
        if (m.v !== undefined) w.u8(m.v)
    }
    w.u32(s.builds ?? 0)
    const due = s.redstone ?? []
    w.u32(due.length)
    for (const [delay, key] of due) {
        w.u16(Math.min(65535, delay))
        w.text(key)
    }
}

/** `format`: 2 has no build count at the end; 3 does. */
function readState(r: Reader, format: number): SkyfarmState {
    const coins = r.f64(), earned = r.f64(), chunksBought = r.u32(), oreLevel = r.u8(), time = r.f64()
    const weather = { kind: WEATHER[r.u8()] ?? 'clear', ticksLeft: r.u32() }
    const health = r.f64()
    const p = Array.from({ length: 8 }, () => r.f64())
    const inventory = readSlots(r)
    const armor = readSlots(r)
    const store = readCounts(r)
    const ledger = Array.from({ length: r.u8() }, () => ({ ticks: r.u16(), produced: readCounts(r), sold: readCounts(r), stored: readCounts(r), gained: readCounts(r) }))
    const mobs: SavedMob[] = []
    const mobCount = r.u16()
    for (let i = 0; i < mobCount; i++) {
        const k = SAVED_MOB_KINDS[r.u8()]
        if (!k) throw new Bad()
        const [x, y, z, yaw, hp] = Array.from({ length: 5 }, () => r.f64()) as [number, number, number, number, number]
        const m: SavedMob = { k, x, y, z, yaw, hp }
        const flags = r.u8()
        if (flags & MOB_CONV) m.conv = r.u16()
        if (flags & MOB_PROF) m.prof = r.text()
        if (flags & MOB_SITE) m.site = [r.i32(), r.i32(), r.i32()]
        if (flags & MOB_TRADES) {
            m.offers = Array.from({ length: r.u8() }, () => {
                const a = readSlot(r), b = readSlot(r), out = readSlot(r)
                if (!a || !out) throw new Bad()
                return { a, ...(b ? { b } : {}), out, uses: r.u8(), max: r.u8(), xp: r.u8() }
            })
            m.xp = r.u32()
            m.level = r.u8()
        }
        if (flags & MOB_REP) m.rep = r.f64()
        if (flags & MOB_INV) m.inv = readSlots(r)
        if (flags & MOB_VARIANT) m.v = r.u8()
        if (flags & MOB_KEEP) m.keep = true
        mobs.push(m)
    }
    const builds = format >= 3 ? r.u32() : 0
    const redstone: [number, string][] = []
    if (format >= 4) {
        const n = r.u32()
        if (n > MAX_REDSTONE_DUE) throw new Bad()
        for (let i = 0; i < n; i++) redstone.push([r.u16(), r.text()])
    }
    return {
        version: SKYFARM_SAVE_VERSION, coins, earned, chunksBought, oreLevel, time, weather, health,
        player: { x: p[0]!, y: p[1]!, z: p[2]!, yaw: p[3]!, pitch: p[4]! }, spawn: { x: p[5]!, y: p[6]!, z: p[7]! },
        inventory, armor, store, ledger, mobs, builds, ...(format >= 4 ? { redstone } : {})
    }
}

// ── Column files ───────────────────────────────────────────────────────

/** A column's file, before gzip. */
export function columnFile(c: SkyfarmColumn): Uint8Array {
    const w = new Writer()
    w.bytes(c.blocks.subarray(0, COLUMN_BYTES))
    w.bytes(c.meta.subarray(0, COLUMN_BYTES))
    w.u16(c.containers.length)
    for (const box of c.containers) {
        w.u8(box.x - c.cx * 16)
        w.u8(box.y)
        w.u8(box.z - c.cz * 16)
        w.u8(box.furnace ? 1 : 0)
        writeSlots(w, box.slots)
        if (box.furnace) for (const v of box.furnace) w.u32(v)
    }
    return w.done()
}

/** A column file's blocks, meta and containers (at world positions for column cx, cz), or null if it is not one. */
export function readColumnFile(bytes: Uint8Array, cx: number, cz: number): Omit<SkyfarmColumn, 'cx' | 'cz' | 'cubes'> | null {
    return attempt(() => {
        const r = new Reader(bytes)
        const blocks = r.bytes(COLUMN_BYTES).slice(), meta = r.bytes(COLUMN_BYTES).slice()
        const containers: SavedContainer[] = []
        // Format 1 column files end with the meta: their containers were in the map.
        if (r.left === 0) return { blocks, meta, containers }
        const n = r.u16()
        if (n > SKYFARM_LIMITS.containers) throw new Bad()
        const seen = new Set<number>()
        for (let i = 0; i < n; i++) {
            const lx = r.u8(), y = r.u8(), lz = r.u8(), kind = r.u8()
            const cell = (y * 16 + lz) * 16 + lx
            if (lx > 15 || lz > 15 || y > 63 || kind > 1 || seen.has(cell)) throw new Bad()
            seen.add(cell)
            const slots = readSlots(r)
            const box: SavedContainer = { x: cx * 16 + lx, y, z: cz * 16 + lz, slots }
            if (kind === 1) {
                const f = [r.u32(), r.u32(), r.u32()] as [number, number, number]
                if (f.some(v => v > 100_000)) throw new Bad()
                box.furnace = f
            }
            containers.push(box)
        }
        r.end()
        return { blocks, meta, containers }
    })
}

/** The SHA-256 naming a column file (hex), from its bytes before gzip. */
export async function columnHash(file: Uint8Array): Promise<string> {
    return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', file as BufferSource)))
}

// ── The map file ───────────────────────────────────────────────────────

function magic(r: Reader, m: number[]) {
    const b = r.bytes(4)
    if (!m.every((v, i) => b[i] === v)) throw new Bad()
    return r.u8()
}

/** The map file, before gzip. */
export function encodeMap(map: Omit<SkyfarmMap, 'format'>): Uint8Array {
    const w = new Writer()
    w.bytes(MAP_MAGIC)
    w.u8(SKYFARM_FORMAT)
    writeState(w, map.state)
    w.u32(map.columns.length)
    for (const c of map.columns) {
        w.i16(c.cx)
        w.i16(c.cz)
        w.u8(c.cubes)
        w.bytes(unhex(c.hash))
    }
    return w.done()
}

/** Reads a map file back (format 2, or the older format 1); null if it is not a well-formed, valid one. */
export function decodeMap(bytes: Uint8Array): SkyfarmMap | null {
    return attempt(() => {
        const r = new Reader(bytes)
        const format = magic(r, MAP_MAGIC)
        let state: SkyfarmState
        if (format >= 2 && format <= 4) {
            state = readState(r, format)
        } else if (format === 1) {
            const len = r.u32()
            if (len > MAX_STATE_BYTES) throw new Bad()
            try {
                state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.bytes(len)))
            } catch {
                throw new Bad()
            }
        } else {
            throw new Bad()
        }
        const count = r.u32()
        if (count < 1 || count > MAX_COLUMNS) throw new Bad()
        const columns: SkyfarmColumnRef[] = []
        const seen = new Set<string>()
        for (let i = 0; i < count; i++) {
            const cx = r.i16(), cz = r.i16(), cubes = r.u8(), hash = hex(r.bytes(32))
            if (cubes < 1 || cubes > 15 || seen.has(`${cx},${cz}`)) throw new Bad()
            seen.add(`${cx},${cz}`)
            columns.push({ cx, cz, cubes, hash })
        }
        r.end()
        const owned = columns.reduce((n, c) => n + bits(c.cubes), 0)
        if (!validateSkyfarmState(state, owned)) throw new Bad()
        return { format, state, columns }
    })
}

// ── Bundles ────────────────────────────────────────────────────────────

/** A save to send: the map file and the column files the server doesn't have yet, all gzipped. */
export function encodeBundle(map: Uint8Array, columns: { hash: string, file: Uint8Array }[]): Uint8Array {
    const w = new Writer()
    w.bytes(BUNDLE_MAGIC)
    w.u8(SKYFARM_FORMAT)
    w.u32(map.length)
    w.bytes(map)
    w.u32(columns.length)
    for (const c of columns) {
        w.bytes(unhex(c.hash))
        w.u32(c.file.length)
        w.bytes(c.file)
    }
    return w.done()
}

/** Splits a bundle into its gzipped map and column files; null if malformed. */
export function decodeBundle(bytes: Uint8Array): { map: Uint8Array, columns: { hash: string, file: Uint8Array }[] } | null {
    return attempt(() => {
        const r = new Reader(bytes)
        if (magic(r, BUNDLE_MAGIC) !== SKYFARM_FORMAT) throw new Bad()
        const map = r.bytes(r.u32())
        const count = r.u32()
        if (count > MAX_COLUMNS) throw new Bad()
        const columns = Array.from({ length: count }, () => {
            const hash = hex(r.bytes(32))
            return { hash, file: r.bytes(r.u32()) }
        })
        r.end()
        return { map, columns }
    })
}

// ── Joining them ───────────────────────────────────────────────────────

/** The map for an island whose column files are named `hashes` (in the island's column order). */
export function mapOf(island: SkyfarmIsland, hashes: string[]): Omit<SkyfarmMap, 'format'> {
    return { state: island.state, columns: island.columns.map((c, i) => ({ cx: c.cx, cz: c.cz, cubes: c.cubes, hash: hashes[i]! })) }
}

/** Joins a map and its column files (before gzip, by hash) back into an island; null if one is missing or malformed. */
export function islandFromFiles(map: SkyfarmMap, files: Map<string, Uint8Array>): SkyfarmIsland | null {
    const columns: SkyfarmColumn[] = []
    for (const ref of map.columns) {
        const file = files.get(ref.hash)
        const col = file ? readColumnFile(file, ref.cx, ref.cz) : null
        if (!col) return null
        columns.push({ cx: ref.cx, cz: ref.cz, cubes: ref.cubes, ...col })
    }
    if (columns.reduce((n, c) => n + c.containers.length, 0) > SKYFARM_LIMITS.containers) return null
    return { state: map.state, columns }
}
