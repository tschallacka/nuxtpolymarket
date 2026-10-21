import { requireUserId } from '#server/utils/auth'
import { buySkyfarmItem } from '#server/utils/skyfarm-shop'

/** Buys Skyfarm shop items for site coins; the client puts them in your inventory. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    return buySkyfarmItem(userId, String(body?.item ?? ''), Number(body?.count ?? 1))
})
