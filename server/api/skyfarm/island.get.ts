import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { skyfarmIslands } from '#server/database/schema'
import { requireUserId } from '#server/utils/auth'

/**
 * The player's island, with the server's clock: the client measures its time
 * away (for the offline catch-up) as `now - savedAt`, both from this server,
 * so a wrong or wound-forward client clock earns nothing.
 *
 * An island saved in binary comes back as its map file (gzipped bytes), with
 * the revision and times in X-Skyfarm-* headers; the client then fetches the
 * columns it names from /api/skyfarm/column/<hash>. A new island, or one still
 * in the older JSON form, comes back as JSON; its next save makes it binary.
 */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const [row] = await db.select({
        revision: skyfarmIslands.revision,
        island: skyfarmIslands.island,
        map: skyfarmIslands.map,
        savedAt: skyfarmIslands.savedAt
    }).from(skyfarmIslands).where(eq(skyfarmIslands.userId, userId))
    const now = Date.now()
    if (row?.map) {
        setHeaders(event, {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-skyfarm-revision': String(row.revision),
            'x-skyfarm-saved-at': String(row.savedAt.getTime()),
            'x-skyfarm-now': String(now)
        })
        return row.map
    }
    return {
        revision: row?.revision ?? 0,
        island: row?.island ?? null,
        savedAt: row ? row.savedAt.getTime() : null,
        now
    }
})
