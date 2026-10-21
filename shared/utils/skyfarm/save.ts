/*
 * Skyfarm's save state: the containers, the player's inventory, the island's
 * economy and the rest. Shared by the client, which builds it, and the server,
 * which validates it. The blocks travel beside it as raw bytes in the save
 * file (see binary.ts); `chunks` is only the older JSON form, still read so
 * islands saved before the file format load.
 */

export const SKYFARM_SAVE_VERSION = 1
/** Bounds that keep a save small. */
export const SKYFARM_LIMITS = { chunks: 400, containers: 2000, slots: 54, stack: 64, coins: 1e15, mobs: 200 }
/** The mobs a save keeps (monsters aren't kept), in the order the save file numbers them: append only. */
export const SAVED_MOB_KINDS = ['cow', 'pig', 'sheep', 'chicken', 'villager', 'zombie_villager', 'cat', 'iron_golem'] as const
/** The most health a saved mob can have (an iron golem's 100; the rest 20 or less). */
const MAX_MOB_HP: Record<string, number> = { iron_golem: 100 }

export interface ItemStack {
    item: string
    count: number
}

export interface SkyfarmChunkSave {
    cx: number
    cz: number
    blocks: string
    meta: string
}

export interface SkyfarmSave {
    version: number
    /** The older JSON form of the blocks (run-length encoded, then base64); absent in save files. */
    chunks?: SkyfarmChunkSave[]
    /** The owned 16x16x16 cubes [cx, cy, cz] (absent in older saves: every cube of every chunk is owned). */
    cubes?: [number, number, number][]
    /** Container contents by block position "x,y,z". */
    containers?: Record<string, (ItemStack | null)[]>
    inventory: (ItemStack | null)[]
    coins: number
    /** Chunks bought beyond the free starter one (sets the next chunk's price). */
    chunksBought: number
    oreLevel: number
    player: { x: number, y: number, z: number, yaw: number, pitch: number }
    spawn: { x: number, y: number, z: number }
    /** Lifetime totals, for the away report and progress. */
    earned: number
    /** Ticks since the island began: the time of day is this modulo a day (absent in older saves). */
    time?: number
    /** The weather and how many ticks it has left (absent in older saves: clear). */
    weather?: { kind: 'clear' | 'rain' | 'thunder', ticksLeft: number }
    /** Each furnace's fire and smelting, by position: [fuel ticks left, the fuel's full burn, smelt ticks done] (absent in older saves). */
    furnaces?: Record<string, [number, number, number]>
    /** Your health, 0 to 20 (absent in older saves: full). */
    health?: number
    /** The animals on the island (monsters aren't kept), absent in older saves. */
    mobs?: {
        k: string, x: number, y: number, z: number, yaw: number, hp: number, conv?: number, prof?: string, site?: [number, number, number]
        /** A villager's trades: what you give (a, and b), what you get, how often it has been used and may be. */
        offers?: { a: ItemStack, b?: ItemStack, out: ItemStack, uses: number, max: number, xp: number }[]
        xp?: number
        level?: number
        rep?: number
        /** What a villager carries (a farmer's seeds and wheat). */
        inv?: (ItemStack | null)[]
        /** A cat's coat. */
        v?: number
        /** A zombie villager that was a villager (kept, as Minecraft keeps it). */
        keep?: boolean
    }[]
    /** What you wear: head, chest, legs, feet (absent in older saves). */
    armor?: (ItemStack | null)[]
    /** What store depots have sent to the store, by item. */
    store?: Record<string, number>
    /** The production ledger: the last ten minutes of what the island made by itself (see ledger.ts). */
    ledger?: { ticks: number, produced: Record<string, number>, sold: Record<string, number>, stored: Record<string, number>, gained: Record<string, number> }[]
    /** How many times the island was changed by hand (the server re-measures its production when this moves). */
    builds?: number
    /** Redstone ticks due: [ticks from now, what ("pulse:x,y,z")]. */
    redstone?: [number, string][]
}

/** Reads the older JSON form of a chunk's bytes: (value, count) pairs, then base64. */
export function decodeBytes(text: string, length: number): Uint8Array {
    const runs = fromBase64(text)
    const out = new Uint8Array(length)
    let o = 0
    for (let i = 0; i + 1 < runs.length && o < length; i += 2) {
        const v = runs[i]!, n = runs[i + 1]!
        out.fill(v, o, Math.min(length, o + n))
        o += n
    }
    return out
}

function fromBase64(text: string): Uint8Array {
    const s = atob(text)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
}

function isStack(v: unknown): v is ItemStack | null {
    if (v === null) return true
    const s = v as ItemStack
    return !!s && typeof s.item === 'string' && s.item.length <= 40 && Number.isInteger(s.count) && s.count > 0 && s.count <= SKYFARM_LIMITS.stack
}

export function isSlots(v: unknown): v is (ItemStack | null)[] {
    return Array.isArray(v) && v.length <= SKYFARM_LIMITS.slots && v.every(isStack)
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Shape and size checks for the state of a save coming from a client, which
 * owns `cubes` cubes (the save file carries them beside the state).
 */
export function validateSkyfarmState(state: unknown, cubes: number): boolean {
    const s = state as SkyfarmSave
    if (!s || typeof s !== 'object' || s.version !== SKYFARM_SAVE_VERSION) return false
    if (s.chunks !== undefined || s.cubes !== undefined) return false
    // Older islands came with whole chunks, four cubes each, bought as one.
    if (!Number.isInteger(s.chunksBought) || s.chunksBought < 0 || s.chunksBought > cubes - 1) return false
    // Containers ride in their column's file now; older saves kept them here.
    if (s.containers !== undefined) {
        if (!s.containers || typeof s.containers !== 'object') return false
        const containers = Object.entries(s.containers)
        if (containers.length > SKYFARM_LIMITS.containers || !containers.every(([k, v]) => /^-?\d+,-?\d+,-?\d+$/.test(k) && isSlots(v))) return false
    }
    if (!isSlots(s.inventory)) return false
    if (!finite(s.coins) || s.coins < 0 || s.coins > SKYFARM_LIMITS.coins) return false
    if (!Number.isInteger(s.oreLevel) || s.oreLevel < 0 || s.oreLevel > 10) return false
    if (!finite(s.earned) || s.earned < 0) return false
    const p = s.player
    if (!p || ![p.x, p.y, p.z, p.yaw, p.pitch].every(finite)) return false
    const sp = s.spawn
    if (!sp || ![sp.x, sp.y, sp.z].every(finite)) return false
    if (s.time !== undefined && (!Number.isInteger(s.time) || s.time < 0)) return false
    const w = s.weather
    if (w !== undefined && (!w || !['clear', 'rain', 'thunder'].includes(w.kind) || !Number.isInteger(w.ticksLeft) || w.ticksLeft < 0)) return false
    if (s.furnaces !== undefined) {
        if (!s.furnaces || typeof s.furnaces !== 'object') return false
        const furnaces = Object.entries(s.furnaces)
        if (furnaces.length > SKYFARM_LIMITS.containers) return false
        const tick = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 100_000
        if (!furnaces.every(([k, v]) => /^-?\d+,-?\d+,-?\d+$/.test(k) && Array.isArray(v) && v.length === 3 && v.every(tick))) return false
    }
    if (s.health !== undefined && (!finite(s.health) || s.health < 0 || s.health > 20)) return false
    if (s.armor !== undefined && (!isSlots(s.armor) || s.armor.length !== 4)) return false
    const counts = (c: unknown, max: number) => !!c && typeof c === 'object' && !Array.isArray(c)
        && Object.keys(c).length <= 300 && Object.entries(c as Record<string, unknown>).every(([k, v]) => k.length <= 40 && finite(v) && Math.abs(v) <= max)
    if (s.store !== undefined && (!counts(s.store, 1e12) || Object.values(s.store).some(v => v < 0 || !Number.isInteger(v)))) return false
    if (s.ledger !== undefined) {
        if (!Array.isArray(s.ledger) || s.ledger.length > 10) return false
        if (!s.ledger.every(b => !!b && Number.isInteger(b.ticks) && b.ticks >= 0 && b.ticks <= 2400
            && counts(b.produced, 1e9) && counts(b.sold, 1e9) && counts(b.stored, 1e9) && counts(b.gained, 1e9))) return false
    }
    if (s.mobs !== undefined) {
        if (!Array.isArray(s.mobs) || s.mobs.length > SKYFARM_LIMITS.mobs) return false
        const kinds: readonly string[] = SAVED_MOB_KINDS
        const conv = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 6000)
        type SavedMob = NonNullable<SkyfarmSave['mobs']>[number]
        const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
        const job = (m: SavedMob) => (m.prof === undefined || (typeof m.prof === 'string' && m.prof.length <= 20))
            && (m.site === undefined || (Array.isArray(m.site) && m.site.length === 3 && m.site.every(v => Number.isInteger(v))))
        const trades = (m: SavedMob) => (m.offers === undefined || (Array.isArray(m.offers) && m.offers.length <= 12 && m.offers.every(o => !!o
            && isStack(o.a) && !!o.a && isStack(o.out) && !!o.out && (o.b === undefined || (isStack(o.b) && !!o.b))
            && int(o.uses, 0, 100) && int(o.max, 1, 100) && int(o.xp, 0, 100))))
            && (m.xp === undefined || int(m.xp, 0, 1e6)) && (m.level === undefined || int(m.level, 1, 5)) && (m.rep === undefined || (finite(m.rep) && m.rep >= 0 && m.rep <= 1000))
        if (!s.mobs.every(m => !!m && kinds.includes(m.k) && [m.x, m.y, m.z, m.yaw].every(finite) && finite(m.hp) && m.hp > 0 && m.hp <= (MAX_MOB_HP[m.k] ?? 20) && conv(m.conv) && job(m) && trades(m)
            && (m.inv === undefined || (isSlots(m.inv) && m.inv.length <= 8)) && (m.v === undefined || int(m.v, 0, 31))
            && (m.keep === undefined || typeof m.keep === 'boolean'))) return false
    }
    return true
}
