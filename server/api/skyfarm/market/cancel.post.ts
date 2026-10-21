import { requireUserId } from '#server/utils/auth'
import { cancelOrder } from '#server/utils/skyfarm-market'

/** Cancels your open Skyfarm order; what it held comes back. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    return cancelOrder(userId, String(body?.orderId ?? ''))
})
