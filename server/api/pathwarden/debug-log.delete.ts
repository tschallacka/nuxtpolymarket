import { clearPathwardenServerDebug } from '#server/pathwarden/debug-log'
import { requireUserId } from '#server/utils/auth'

export default defineEventHandler(async event => {
    await requireUserId(event)
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    clearPathwardenServerDebug()
    return { cleared: true, savedSegments: [] }
})
