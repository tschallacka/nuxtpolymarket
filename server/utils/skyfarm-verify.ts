import { gunzipSync } from 'node:zlib'
import { eq } from 'drizzle-orm'
import type { DbExecutor } from '#server/database'
import { skyfarmColumns } from '#server/database/schema'
import { decodeMap, islandFromFiles, MAX_COLUMN_FILE_BYTES, MAX_COLUMNS, type SkyfarmIsland, type SkyfarmMap } from '#shared/utils/skyfarm/binary'
import { Island } from '../../app/utils/skyfarm/island'
import { holdings, productionRates } from '../../app/utils/skyfarm/verify'

/*
 * Glue between the save endpoint and the production check (app/utils/skyfarm/
 * verify.ts): islands read back from their rows, the production rates measured
 * (and kept for a while: replaying an island costs real time), and the
 * baseline for an island never checked before.
 */

/**
 * What production rates were measured for: the island's build count and its
 * generator's ore level. Machines running don't change it; building does.
 */
export function ratesKey(island: SkyfarmIsland) {
    return `${island.state.builds ?? 0}:${island.state.oreLevel}`
}

const MAX_MAP = 2_100_000 + MAX_COLUMNS * 37

/** A saved island, read back from its map and its column rows (`extra`: column files not in the table yet, by hash, gzipped). */
export async function loadIsland(tx: DbExecutor, userId: string, mapGz: Uint8Array, extra = new Map<string, Uint8Array>()): Promise<{ map: SkyfarmMap, island: SkyfarmIsland } | null> {
    const map = decodeMap(gunzipSync(mapGz, { maxOutputLength: MAX_MAP }))
    if (!map) return null
    const rows = await tx.select({ hash: skyfarmColumns.hash, data: skyfarmColumns.data }).from(skyfarmColumns).where(eq(skyfarmColumns.userId, userId))
    const files = new Map<string, Uint8Array>()
    for (const r of rows) files.set(r.hash, gunzipSync(r.data, { maxOutputLength: MAX_COLUMN_FILE_BYTES }))
    for (const [hash, gz] of extra) files.set(hash, gunzipSync(gz, { maxOutputLength: MAX_COLUMN_FILE_BYTES }))
    const island = islandFromFiles(map, files)
    return island ? { map, island } : null
}

/** The most an island can produce a second, by item: its machines replayed, and what grows on it. */
export function measure(saved: SkyfarmIsland): Record<string, number> {
    return productionRates(Island.fromSave(saved), saved)
}

/** How many cubes a map owns (all its columns' cubes). */
export function ownedCubes(map: SkyfarmMap) {
    return map.columns.reduce((n, c) => n + ((c.cubes & 1) + ((c.cubes >> 1) & 1) + ((c.cubes >> 2) & 1) + ((c.cubes >> 3) & 1)), 0)
}

/**
 * For an island from before purchases were kept on the server: what its last
 * save owns counts as paid for (cubes beyond the starter one, the ore level).
 */
export function paidFor(mapGz: Uint8Array | null): { bought: number, ore: number } {
    const map = mapGz ? decodeMap(gunzipSync(mapGz, { maxOutputLength: MAX_MAP })) : null
    return map ? { bought: Math.max(0, ownedCubes(map) - 1), ore: map.state.oreLevel } : { bought: 0, ore: 0 }
}

/** What a brand-new island holds: the start every island is checked from. */
export function starterHoldings(): Record<string, number> {
    return Object.fromEntries(holdings(Island.fresh().toSave()))
}
