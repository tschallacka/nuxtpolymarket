import { and, eq } from 'drizzle-orm'
import { db } from '#server/database'
import { skyfarmColumns } from '#server/database/schema'
import { requireUserId } from '#server/utils/auth'
import { isColumnHash } from '#shared/utils/skyfarm/binary'

/**
 * One column file of your island (gzipped bytes), by the hash its map names.
 * Only your own island's columns are read. A hash always means the same bytes,
 * so the browser may keep it for good: a reload only downloads columns that
 * changed.
 */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const hash = getRouterParam(event, 'hash') ?? ''
    if (!isColumnHash(hash)) throw createError({ statusCode: 400, statusMessage: 'Bad column name' })
    const [row] = await db.select({ data: skyfarmColumns.data }).from(skyfarmColumns)
        .where(and(eq(skyfarmColumns.userId, userId), eq(skyfarmColumns.hash, hash))).limit(1)
    if (!row) throw createError({ statusCode: 404, statusMessage: 'No such column' })
    setHeaders(event, {
        'content-type': 'application/octet-stream',
        'cache-control': 'private, max-age=31536000, immutable'
    })
    return row.data
})
