import { requireUserId } from '#server/utils/auth'
import { buyLand } from '#server/utils/skyfarm-shop'

/** Buys the next cube of Skyfarm land for site coins; the client adds the cube you picked. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    return buyLand(userId)
})
