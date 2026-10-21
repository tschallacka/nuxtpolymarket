import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '#server/database'
import { skyfarmColumns, skyfarmIslands } from '#server/database/schema'
import { requireUserId } from '#server/utils/auth'
import { addStorage } from '#server/utils/skyfarm-market'
import { loadIsland, measure, ownedCubes, paidFor, ratesKey, starterHoldings } from '#server/utils/skyfarm-verify'
import { decodeBundle, decodeMap, encodeMap, isColumnHash, MAX_COLUMN_FILE_BYTES, MAX_COLUMNS, readColumnFile, SKYFARM_FORMAT } from '#shared/utils/skyfarm/binary'
import { SKYFARM_SAVE_VERSION } from '#shared/utils/skyfarm/save'
import { account, holdings } from '../../../app/utils/skyfarm/verify'

/** Unzipped, a map is its state (at most ~2 MB) and 37 bytes a column: anything more is a zip bomb. */
const MAX_MAP = 2_100_000 + MAX_COLUMNS * 37
/** A bundle larger than this is refused unread. */
const MAX_UPLOAD = 16 * 1024 * 1024

const invalid = () => createError({ statusCode: 400, statusMessage: 'Invalid Skyfarm save' })
const conflict = () => createError({ statusCode: 409, statusMessage: 'This island was saved from another session' })

function gunzip(bytes: Uint8Array, max: number) {
    try {
        return gunzipSync(bytes, { maxOutputLength: max })
    } catch {
        throw invalid()
    }
}

/**
 * Saves the island. The body is a bundle (application/octet-stream): the new
 * map file and the column files the server doesn't have yet, each gzipped.
 * The X-Skyfarm-Revision header is the revision it was loaded at; that integer
 * is the guard: a save only lands if nothing else saved since, so two open tabs
 * can't overwrite each other's progress silently. The first save of a new
 * island (revision 0, no row yet) creates the row.
 *
 * The map and the columns (one row each) are written in one transaction, under
 * a lock on the island's row: a save lands whole or not at all. If the map
 * names a column the server doesn't have, the answer is 422 with
 * `data.missing`: the client sends those and tries again.
 */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const revision = Math.floor(Number(getHeader(event, 'x-skyfarm-revision')))
    const body = await readRawBody(event, false)
    if (!Number.isInteger(revision) || revision < 0 || !body?.length) throw invalid()
    if (body.length > MAX_UPLOAD) throw createError({ statusCode: 413, statusMessage: 'Skyfarm save too large' })
    const bundle = decodeBundle(new Uint8Array(body))
    if (!bundle) throw invalid()
    const map = decodeMap(gunzip(bundle.map, MAX_MAP))
    // Saves are written in the current format only (older ones are only ever read).
    if (!map || map.format !== SKYFARM_FORMAT) throw invalid()

    // Each column file must be a well-formed column, named by its own contents, and one the map uses.
    const sent = new Map<string, Uint8Array>()
    for (const c of bundle.columns) {
        const ref = map.columns.find(r => r.hash === c.hash)
        if (!isColumnHash(c.hash) || !ref) throw invalid()
        const raw = gunzip(c.file, MAX_COLUMN_FILE_BYTES)
        if (createHash('sha256').update(raw).digest('hex') !== c.hash) throw invalid()
        if (!readColumnFile(raw, ref.cx, ref.cz)) throw invalid()
        sent.set(c.hash, c.file)
    }

    // The production check needs the island's rates: measured again (a headless replay of
    // the last saved island, which takes real time) only when it was built on or upgraded
    // since the last measure (with nothing built, it makes what it made), outside any lock.
    const [before] = await db.select({ map: skyfarmIslands.map, rates: skyfarmIslands.rates, ratesFor: skyfarmIslands.ratesFor })
        .from(skyfarmIslands).where(eq(skyfarmIslands.userId, userId))
    const previous = before?.map ? await loadIsland(db, userId, before.map) : null
    const measuredFor = previous ? ratesKey(previous.island) : null
    const freshRates = previous && (!before?.rates || before.ratesFor !== measuredFor) ? measure(previous.island) : null

    const saved = await db.transaction(async (tx) => {
        // Lock-then-read: the island's row (absent for a new island) holds every save of it back until this one is done.
        const [row] = await tx.select({
            revision: skyfarmIslands.revision, trusted: skyfarmIslands.trusted, rates: skyfarmIslands.rates, savedAt: skyfarmIslands.savedAt,
            bought: skyfarmIslands.bought, ore: skyfarmIslands.ore, map: skyfarmIslands.map
        }).from(skyfarmIslands).where(eq(skyfarmIslands.userId, userId)).for('update')
        if ((row?.revision ?? 0) !== revision) throw conflict()

        // Land and upgrades are paid for in site coins (server/utils/skyfarm-shop.ts): a save can't
        // own more cubes than were bought, nor a better generator. An island from before that was
        // kept: what its last save owns counts as paid for.
        const grandfathered = row && (row.bought === null || row.ore === null) ? paidFor(row.map) : null
        const bought = row?.bought ?? grandfathered?.bought ?? 0
        const ore = row?.ore ?? grandfathered?.ore ?? 0
        if (ownedCubes(map) > 1 + bought) throw createError({ statusCode: 400, statusMessage: 'This island owns land it hasn\'t paid for' })
        if (map.state.oreLevel > ore) throw createError({ statusCode: 400, statusMessage: 'This island\'s generator wasn\'t paid for' })

        // What is stored now, column by column; a column the map names must be sent, or stored as that same file.
        const stored = await tx.select({ cx: skyfarmColumns.cx, cz: skyfarmColumns.cz, hash: skyfarmColumns.hash })
            .from(skyfarmColumns).where(eq(skyfarmColumns.userId, userId))
        const at = new Map(stored.map(s => [`${s.cx},${s.cz}`, s]))
        const missing = new Set<string>()
        // A column whose file is already stored under another position (two identical columns) is copied from there.
        const copies: { cx: number, cz: number, hash: string }[] = []
        for (const ref of map.columns) {
            if (sent.has(ref.hash) || at.get(`${ref.cx},${ref.cz}`)?.hash === ref.hash) continue
            if (stored.some(s => s.hash === ref.hash)) copies.push(ref)
            else missing.add(ref.hash)
        }
        if (missing.size) throw createError({ statusCode: 422, statusMessage: 'Skyfarm save is missing columns', data: { missing: [...missing] } })

        for (const ref of map.columns) {
            const file = sent.get(ref.hash)
            if (!file || at.get(`${ref.cx},${ref.cz}`)?.hash === ref.hash) continue
            await tx.insert(skyfarmColumns).values({ userId, cx: ref.cx, cz: ref.cz, hash: ref.hash, data: file })
                .onConflictDoUpdate({ target: [skyfarmColumns.userId, skyfarmColumns.cx, skyfarmColumns.cz], set: { hash: ref.hash, data: file } })
        }
        for (const ref of copies) {
            await tx.execute(sql`
                insert into skyfarm_columns (user_id, cx, cz, hash, data)
                select ${userId}, ${ref.cx}, ${ref.cz}, hash, data from skyfarm_columns
                where user_id = ${userId} and hash = ${ref.hash} limit 1
                on conflict (user_id, cx, cz) do update set hash = excluded.hash, data = excluded.data`)
        }
        // Columns the map no longer has (none today: land is only ever bought) go.
        const keep = new Set(map.columns.map(r => `${r.cx},${r.cz}`))
        const gone = stored.filter(s => !keep.has(`${s.cx},${s.cz}`))
        for (const s of gone) {
            await tx.delete(skyfarmColumns).where(and(eq(skyfarmColumns.userId, userId), eq(skyfarmColumns.cx, s.cx), eq(skyfarmColumns.cz, s.cz)))
        }

        // The production check (app/utils/skyfarm/verify.ts): what the depots sent this time goes to
        // storage as far as the island's holdings and production account for it.
        const now = new Date()
        const current = await loadIsland(tx, userId, bundle.map)
        if (!current) throw invalid()
        const deposited = map.state.store ?? {}
        const rates = freshRates ?? row?.rates ?? {}
        const baseline = row?.trusted ?? (previous ? Object.fromEntries(holdings(previous.island)) : starterHoldings())
        const seconds = row ? (now.getTime() - row.savedAt.getTime()) / 1000 : 0
        const { accepted, trusted } = account({ trusted: baseline, held: holdings(current.island), sent: deposited, rates, seconds })
        for (const [item, n] of Object.entries(accepted)) await addStorage(tx, userId, item, n)
        // The map keeps only what is still on its way (so a reload doesn't send the accepted part again).
        let mapGz = bundle.map
        if (Object.keys(accepted).length) {
            const pending = Object.fromEntries(Object.entries(deposited).map(([k, n]) => [k, n - (accepted[k] ?? 0)]).filter(([, n]) => (n as number) > 0))
            mapGz = new Uint8Array(gzipSync(encodeMap({ state: { ...map.state, store: pending }, columns: map.columns })))
        }

        // Every column row left is one the map names.
        const [size] = await tx.select({ n: sql<number>`coalesce(sum(length(${skyfarmColumns.data})), 0)::int` })
            .from(skyfarmColumns).where(eq(skyfarmColumns.userId, userId))
        const values = {
            revision: revision + 1, saveVersion: SKYFARM_SAVE_VERSION, island: null, map: mapGz, bytes: mapGz.length + (size?.n ?? 0), savedAt: now,
            trusted, rates, ...(freshRates ? { ratesFor: measuredFor } : {}), bought, ore
        }
        const [done] = row
            ? await tx.update(skyfarmIslands).set(values).where(eq(skyfarmIslands.userId, userId))
                .returning({ revision: skyfarmIslands.revision, savedAt: skyfarmIslands.savedAt })
            : await tx.insert(skyfarmIslands).values({ userId, ...values }).onConflictDoNothing({ target: skyfarmIslands.userId })
                .returning({ revision: skyfarmIslands.revision, savedAt: skyfarmIslands.savedAt })
        // A new island's row made by another session in the meantime (no row to lock, so no lock held it back).
        if (!done) throw conflict()
        return { ...done, accepted }
    })
    return { revision: saved.revision, savedAt: saved.savedAt.getTime(), accepted: saved.accepted }
})
