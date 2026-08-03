import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { pathwardenRuns, pathwardenState } from '#server/database/schema'
import { requireUserId } from '#server/utils/auth'
import { getLockedPathwardenState } from '#server/utils/pathwarden'
import { closePathwardenSessionsForUser } from '#server/pathwarden/session'

export default defineEventHandler(async (event) => {
    if (!import.meta.dev && !useRuntimeConfig(event).devMode) {
        throw createError({ statusCode: 404, statusMessage: 'Not found' })
    }

    const userId = await requireUserId(event)
    await closePathwardenSessionsForUser(userId, 4003, 'Pathwarden debug cache cleared')

    return db.transaction(async (tx) => {
        await getLockedPathwardenState(tx, userId)
        await tx.delete(pathwardenRuns).where(eq(pathwardenRuns.userId, userId))
        await tx.update(pathwardenState)
            .set({
                runStartedAt: null,
                runRealmSnapshot: null,
                runPowerSnapshot: null,
                runSurgedSnapshot: null
            })
            .where(eq(pathwardenState.userId, userId))
        return { cleared: true }
    })
})
