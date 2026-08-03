import { db } from '#server/database'
import { requireUserId } from '#server/utils/auth'
import { PATHWARDEN_AMBIENT_STORY_COUNT } from '#shared/utils/gamelogic/pathwarden'
import { recordPathwardenAmbientStory } from '#server/utils/pathwarden'
import { hasPathwardenSessionForUser } from '#server/pathwarden/session'

export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    if (hasPathwardenSessionForUser(userId)) {
        throw createError({ statusCode: 409, statusMessage: 'Live ambient stories are owned by the Pathwarden session' })
    }
    const body = await readBody<{ storyId?: number }>(event)
    const storyId = Math.floor(Number(body.storyId))
    if (!Number.isInteger(storyId) || storyId < 1 || storyId > PATHWARDEN_AMBIENT_STORY_COUNT) {
        throw createError({ statusCode: 400, statusMessage: 'Unknown ambient story' })
    }

    return db.transaction(tx => recordPathwardenAmbientStory(tx, userId, storyId))
})
