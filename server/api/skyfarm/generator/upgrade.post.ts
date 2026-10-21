import { requireUserId } from '#server/utils/auth'
import { upgradeGenerator } from '#server/utils/skyfarm-shop'

/** Buys the Skyfarm generator's next ore level for site coins. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    return upgradeGenerator(userId)
})
