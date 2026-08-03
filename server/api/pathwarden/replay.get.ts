import { and, eq } from 'drizzle-orm'
import { db } from '#server/database'
import { pathwardenRuns } from '#server/database/schema'
import { getPathwardenReplay } from '#server/pathwarden/replay'
import { requireUserId } from '#server/utils/auth'

export default defineEventHandler(async (event) => {
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    const userId = await requireUserId(event)
    const runId = getQuery(event).runId
    if (typeof runId !== 'string' || !runId) throw createError({ statusCode: 400, statusMessage: 'runId is required' })
    const run = await db.query.pathwardenRuns.findFirst({
        where: and(eq(pathwardenRuns.id, runId), eq(pathwardenRuns.userId, userId)),
        columns: { id: true }
    })
    if (!run) throw createError({ statusCode: 404, statusMessage: 'Pathwarden run not found' })
    return { runId, records: getPathwardenReplay(runId) }
})
