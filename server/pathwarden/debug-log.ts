import {
    getPathwardenDebugLog,
    type PathwardenDebugQuery,
    type PathwardenDebugQueryResult
} from '#shared/pathwarden/debug-log'

const logger = import.meta.dev ? getPathwardenDebugLog('server') : null

export function recordPathwardenServerDebug(event: string, fields: Record<string, unknown> = {}) {
    return logger?.record(event, fields) ?? null
}

export function queryPathwardenServerDebug(options: PathwardenDebugQuery = {}): PathwardenDebugQueryResult {
    return logger?.query(options) ?? {
        entries: [],
        total: 0,
        returned: 0,
        nextBefore: null,
        nextAfter: null
    }
}

export function listPathwardenServerDebugSaves() {
    return logger?.listSaved() ?? []
}

export function savePathwardenServerDebug(name: string, options: PathwardenDebugQuery = {}) {
    if (!logger) return null
    return logger.save(name, options)
}

export function deletePathwardenServerDebug(name: string) {
    return logger?.deleteSaved(name) ?? false
}

export function clearPathwardenServerDebug() {
    logger?.clear()
    logger?.clearSaved()
}
