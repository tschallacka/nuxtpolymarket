import { requireUserId } from '#server/utils/auth'
import { bookView } from '#server/utils/skyfarm-market'

/** One item's market: the best buy and sell prices, recent trades, and what the system pays. */
export default defineEventHandler(async (event) => {
    await requireUserId(event)
    return bookView(getRouterParam(event, 'item') ?? '')
})
