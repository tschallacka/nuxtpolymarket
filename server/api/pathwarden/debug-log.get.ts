import { getQuery } from 'h3'
import { listPathwardenServerDebugSaves, queryPathwardenServerDebug } from '#server/pathwarden/debug-log'
import { requireUserId } from '#server/utils/auth'

export default defineEventHandler(async event => {
    await requireUserId(event)
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    const query = getQuery(event)
    const limit = typeof query.limit === 'string' ? Number(query.limit) : undefined
    return {
        ...queryPathwardenServerDebug({
            filter: typeof query.filter === 'string' ? query.filter : undefined,
            select: typeof query.select === 'string' ? query.select : undefined,
            limit,
            before: typeof query.before === 'string' ? query.before : undefined,
            after: typeof query.after === 'string' ? query.after : undefined,
            saved: typeof query.saved === 'string' ? query.saved : undefined
        }),
        savedSegments: listPathwardenServerDebugSaves()
    }
})
