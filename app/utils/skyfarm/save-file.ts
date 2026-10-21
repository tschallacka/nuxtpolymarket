import {
    columnFile, columnHash, decodeMap, encodeBundle, encodeMap, islandFromFiles, mapOf, type SkyfarmIsland
} from '#shared/utils/skyfarm/binary'
import type { SkyfarmSave } from '#shared/utils/skyfarm/save'

/*
 * Moving the island to and from the server as its save files (binary.ts): a
 * map file and one file per column, each gzipped by the browser itself
 * (CompressionStream). A save sends the map and only the column files the
 * server doesn't have yet, so an autosave after building in one column sends
 * one column. Loading fetches the map, then its columns, which the browser
 * caches for good (a column's name is its contents).
 */

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
    const out = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer()
    return new Uint8Array(out)
}

const gzip = (b: Uint8Array) => through(b, new CompressionStream('gzip'))
const gunzip = (b: Uint8Array) => through(b, new DecompressionStream('gzip'))

/** Column fetches running at once while loading. */
const PARALLEL = 6

export interface LoadedIsland {
    revision: number
    /** The island from its files, an older JSON save, or null for a new island. */
    island: SkyfarmIsland | SkyfarmSave | null
    savedAt: number | null
    now: number
    /** The column files the server holds (by hash), so a save can leave them out. */
    stored: Set<string>
}

async function fetchBytes(url: string, init?: RequestInit) {
    const res = await fetch(url, { credentials: 'same-origin', ...init })
    if (!res.ok) throw Object.assign(new Error(res.statusText || 'Could not load your island'), { statusCode: res.status })
    return res
}

/** Fetches your island: its map and columns, or (a new or older island) JSON. */
export async function fetchIsland(): Promise<LoadedIsland> {
    const res = await fetchBytes('/api/skyfarm/island', { cache: 'no-store' })
    if ((res.headers.get('content-type') ?? '').includes('application/json')) return { ...await res.json() as Omit<LoadedIsland, 'stored'>, stored: new Set() }
    const map = decodeMap(await gunzip(new Uint8Array(await res.arrayBuffer())))
    if (!map) throw new Error('Your island\'s save could not be read')
    const files = new Map<string, Uint8Array>()
    const queue = [...new Set(map.columns.map(c => c.hash))]
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        for (let hash = queue.pop(); hash; hash = queue.pop()) {
            const col = await fetchBytes(`/api/skyfarm/column/${hash}`)
            files.set(hash, await gunzip(new Uint8Array(await col.arrayBuffer())))
        }
    }))
    const island = islandFromFiles(map, files)
    if (!island) throw new Error('Your island\'s save could not be read')
    const num = (h: string) => Number(res.headers.get(h))
    return { revision: num('x-skyfarm-revision'), island, savedAt: num('x-skyfarm-saved-at'), now: num('x-skyfarm-now'), stored: new Set(files.keys()) }
}

export interface Saved {
    revision: number
    savedAt: number
    /** What storage took of what the depots sent, by item (the rest stays on its way). */
    accepted: Record<string, number>
    /** The column files the server now holds. */
    stored: Set<string>
}

type Put = (body: Uint8Array) => Promise<{ revision: number, savedAt: number, accepted?: Record<string, number> }>

/**
 * Saves the island through `put` (which sends the bundle with the revision):
 * the map, and the columns the server lacks. If the server says it is missing
 * some anyway (`stored` was out of date), sends those and tries once more.
 */
export async function saveIsland(island: SkyfarmIsland, stored: Set<string>, put: Put): Promise<Saved> {
    // Every column's file and name, before anything awaits: the island copy is ours, but keep it simple.
    const files = island.columns.map(columnFile)
    const hashes = await Promise.all(files.map(columnHash))
    const map = await gzip(encodeMap(mapOf(island, hashes)))
    const send = async (skip: Set<string>) => {
        const fresh = new Map<string, Uint8Array>()
        hashes.forEach((h, i) => {
            if (!skip.has(h)) fresh.set(h, files[i]!)
        })
        const columns = await Promise.all([...fresh].map(async ([hash, file]) => ({ hash, file: await gzip(file) })))
        return put(encodeBundle(map, columns))
    }
    let res
    try {
        res = await send(stored)
    } catch (e) {
        const missing = (e as { data?: { data?: { missing?: string[] } } })?.data?.data?.missing
        if (!missing?.length) throw e
        res = await send(new Set([...stored].filter(h => !missing.includes(h))))
    }
    return { revision: res.revision, savedAt: res.savedAt, accepted: res.accepted ?? {}, stored: new Set(hashes) }
}
