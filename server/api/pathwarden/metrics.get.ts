import { requireUserId } from '#server/utils/auth'
import { getPathwardenRuntimeMetrics } from '#server/pathwarden/metrics'

export default defineEventHandler(async (event) => {
    await requireUserId(event)
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    return getPathwardenRuntimeMetrics()
})
