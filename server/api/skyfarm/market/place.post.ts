import { requireUserId } from '#server/utils/auth'
import { placeOrder } from '#server/utils/skyfarm-market'

/** Places a buy or sell order for a Skyfarm item, in site coins. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    const side = body?.side === 'buy' ? 'buy' as const : body?.side === 'sell' ? 'sell' as const : null
    if (!side) throw createError({ statusCode: 400, statusMessage: 'Choose buy or sell' })
    return placeOrder(userId, String(body?.item ?? ''), side, Number(body?.price), Number(body?.quantity))
})
