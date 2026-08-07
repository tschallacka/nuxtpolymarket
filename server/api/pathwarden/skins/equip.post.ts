import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { pathwardenState } from '#server/database/schema'
import { requireUserId } from '#server/utils/auth'
import { getLockedPathwardenState, reconcileOrphanedPathwardenRun } from '#server/utils/pathwarden'
import { PATHWARDEN_SKINS } from '#shared/utils/gamelogic/pathwarden'

export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    const skin = PATHWARDEN_SKINS.find(item => item.id === body?.skinId)
    if (!skin) throw createError({ statusCode: 400, statusMessage: 'Invalid skin' })

    return db.transaction(async (tx) => {
        const state = await getLockedPathwardenState(tx, userId)
        const reconciledState = await reconcileOrphanedPathwardenRun(tx, userId, state)
        if (reconciledState.runStartedAt) throw createError({ statusCode: 400, statusMessage: 'Finish the active march before changing livery' })
        const owned = new Set(['warden-stone', ...(reconciledState.ownedSkinIds ?? [])])
        if (!owned.has(skin.id)) throw createError({ statusCode: 403, statusMessage: 'Purchase this skin first' })
        await tx.update(pathwardenState).set({ equippedSkinId: skin.id })
            .where(eq(pathwardenState.userId, userId))
        return { skinId: skin.id, equipped: true }
    })
})
