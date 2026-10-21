import { requireUserId } from '#server/utils/auth'
import { sellToSystem } from '#server/utils/skyfarm-market'

/** Sells stored items: to players' standing buy orders at or above the system's price first, the rest to the system. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    return sellToSystem(userId, String(body?.item ?? ''), Number(body?.quantity))
})
