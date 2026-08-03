import type { PathwardenInputCommand, PathwardenWorldSnapshot } from '#shared/pathwarden/protocol'
import type { PathwardenEntity } from '#server/pathwarden/world'

export interface PathwardenReplayRecord {
    tick: number
    inputSequence?: number
    command?: PathwardenInputCommand
    accepted?: boolean
    events?: Array<{ id: number, type: number }>
    stateHash: string
}

const MAX_RECORDS_PER_RUN = 512
const records = new Map<string, PathwardenReplayRecord[]>()

function hashBytes(value: string) {
    let hash = 2166136261
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

export function hashPathwardenState(snapshot: PathwardenWorldSnapshot, entities: PathwardenEntity[]) {
    return hashBytes(JSON.stringify({ snapshot, entities }))
}

export function recordPathwardenReplay(runId: string, record: PathwardenReplayRecord) {
    const runRecords = records.get(runId) ?? []
    runRecords.push(record)
    if (runRecords.length > MAX_RECORDS_PER_RUN) runRecords.splice(0, runRecords.length - MAX_RECORDS_PER_RUN)
    records.set(runId, runRecords)
}

export function getPathwardenReplay(runId: string) {
    return [...(records.get(runId) ?? [])]
}

export function clearPathwardenReplay(runId: string) {
    records.delete(runId)
}
