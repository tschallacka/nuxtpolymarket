import { readBody } from 'h3'
import {
    deletePathwardenServerDebug,
    listPathwardenServerDebugSaves,
    savePathwardenServerDebug
} from '#server/pathwarden/debug-log'
import { requireUserId } from '#server/utils/auth'

export default defineEventHandler(async event => {
    await requireUserId(event)
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
    const body = await readBody<{
        action?: 'save' | 'delete' | 'list'
        name?: string
        filter?: string
        select?: string
        limit?: number
        before?: string
        after?: string
    }>(event)
    if (body?.action === 'list') return { savedSegments: listPathwardenServerDebugSaves() }
    if (body?.action === 'delete') {
        if (!body.name) throw createError({ statusCode: 400, statusMessage: 'A saved debug segment name is required' })
        return { deleted: deletePathwardenServerDebug(body.name) }
    }
    if (body?.action === 'save') {
        if (!body.name) throw createError({ statusCode: 400, statusMessage: 'A saved debug segment name is required' })
        return {
            saved: savePathwardenServerDebug(body.name, {
                filter: body.filter,
                select: body.select,
                limit: body.limit,
                before: body.before,
                after: body.after
            })
        }
    }
    throw createError({ statusCode: 400, statusMessage: 'Unknown debug log action' })
})
