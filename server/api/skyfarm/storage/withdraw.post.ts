import { requireUserId } from '#server/utils/auth'
import { withdrawStorage } from '#server/utils/skyfarm-market'

/** Takes items out of storage back into the game (the client puts them in your inventory). */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    const body = await readBody(event)
    return withdrawStorage(userId, String(body?.item ?? ''), Number(body?.quantity))
})
