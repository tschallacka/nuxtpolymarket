import { requireUserId } from '#server/utils/auth'
import { storageView } from '#server/utils/skyfarm-market'

/** Your Skyfarm storage (what the server accepted from your depots), and your open market orders. */
export default defineEventHandler(async (event) => {
    const userId = await requireUserId(event)
    return storageView(userId)
})
