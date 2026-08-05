import { PathwardenPacketKind } from '#shared/pathwarden/protocol'

export type PathwardenDebugSide = 'client' | 'server'

export interface PathwardenDebugRecord {
    id: string
    sequence: number
    timestamp: string
    timestampMs: number
    side: PathwardenDebugSide
    event: string
    [key: string]: unknown
}

export interface PathwardenDebugQuery {
    filter?: string
    select?: string
    limit?: number
    before?: string
    after?: string
    saved?: string
}

export interface PathwardenDebugQueryResult {
    entries: unknown[]
    total: number
    returned: number
    nextBefore: string | null
    nextAfter: string | null
}

export interface PathwardenDebugSavedSegment {
    name: string
    createdAt: string
    count: number
    firstId: string | null
    lastId: string | null
}

const MAX_RECORDS = 10_000
const MAX_QUERY_LIMIT = 500

export function pathwardenPacketMetadata(value: ArrayBufferLike | Uint8Array) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    const metadata: Record<string, unknown> = { byteLength: bytes.byteLength }
    if (bytes.byteLength < 20) return metadata
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const kind = view.getUint8(2)
    const names: Record<number, string> = {
        [PathwardenPacketKind.Hello]: 'Hello',
        [PathwardenPacketKind.HelloAck]: 'HelloAck',
        [PathwardenPacketKind.FullSnapshot]: 'FullSnapshot',
        [PathwardenPacketKind.InputCommand]: 'InputCommand',
        [PathwardenPacketKind.CommandAck]: 'CommandAck',
        [PathwardenPacketKind.CommandReject]: 'CommandReject',
        [PathwardenPacketKind.ProtocolError]: 'ProtocolError',
        [PathwardenPacketKind.MapSnapshot]: 'MapSnapshot',
        [PathwardenPacketKind.MapSnapshotChunk]: 'MapSnapshotChunk',
        [PathwardenPacketKind.EntitySnapshot]: 'EntitySnapshot',
        [PathwardenPacketKind.ChoiceOffer]: 'ChoiceOffer',
        [PathwardenPacketKind.EntityDelta]: 'EntityDelta',
        [PathwardenPacketKind.MapStateDelta]: 'MapStateDelta',
        [PathwardenPacketKind.GameplayEvent]: 'GameplayEvent'
    }
    return {
        ...metadata,
        packetKind: names[kind] ?? `Unknown(${kind})`,
        packetKindCode: kind,
        packetSequence: view.getUint32(6),
        tick: view.getUint32(10),
        acknowledgedInput: view.getUint32(14)
    }
}

function valueAt(record: PathwardenDebugRecord, path: string) {
    const parts = path.replace(/^\.?/, '').split('.').filter(Boolean)
    let value: unknown = record
    for (const part of parts) {
        if (!value || typeof value !== 'object') return undefined
        value = (value as Record<string, unknown>)[part]
    }
    return value
}

function parseLiteral(input: string): unknown {
    const value = input.trim()
    if (value === 'null') return null
    if (value === 'true') return true
    if (value === 'false') return false
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    throw new Error(`Invalid debug query literal: ${value}`)
}

function splitBoolean(input: string, operator: 'and' | 'or') {
    const parts: string[] = []
    let start = 0
    let quote: string | null = null
    for (let index = 0; index < input.length; index++) {
        const character = input[index]
        if (quote) {
            if (character === quote && input[index - 1] !== '\\') quote = null
            continue
        }
        if (character === '"' || character === "'") {
            quote = character
            continue
        }
        const match = input.slice(index).match(new RegExp(`^\\s+${operator}\\s+`))
        if (match) {
            parts.push(input.slice(start, index).trim())
            index += match[0].length - 1
            start = index + 1
        }
    }
    parts.push(input.slice(start).trim())
    return parts.filter(Boolean)
}

function predicate(input: string): (record: PathwardenDebugRecord) => boolean {
    const expression = input.trim()
    if (!expression) return () => true
    const ors = splitBoolean(expression, 'or')
    if (ors.length > 1) {
        const predicates = ors.map(predicate)
        return record => predicates.some(test => test(record))
    }
    const ands = splitBoolean(expression, 'and')
    if (ands.length > 1) {
        const predicates = ands.map(predicate)
        return record => predicates.every(test => test(record))
    }
    const contains = expression.match(/^contains\((\.?[\w.]+)\s*;\s*(.+)\)$/)
    if (contains) {
        const expected = String(parseLiteral(contains[2]!))
        return record => String(valueAt(record, contains[1]!)).includes(expected)
    }
    const comparison = expression.match(/^(\.?[\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/)
    if (!comparison) throw new Error(`Unsupported debug query expression: ${expression}`)
    const path = comparison[1]!
    const operator = comparison[2]!
    const expected = parseLiteral(comparison[3]!)
    return record => {
        const actual = valueAt(record, path)
        if (operator === '==') return actual === expected
        if (operator === '!=') return actual !== expected
        if (typeof actual !== 'number' || typeof expected !== 'number') return false
        if (operator === '>') return actual > expected
        if (operator === '<') return actual < expected
        if (operator === '>=') return actual >= expected
        return actual <= expected
    }
}

function project(record: PathwardenDebugRecord, select?: string): unknown {
    if (!select) return record
    const expression = select.trim()
    const fields = expression.startsWith('{') && expression.endsWith('}')
        ? expression.slice(1, -1).split(',').map(field => field.trim()).filter(Boolean)
        : expression.split(',').map(field => field.trim()).filter(Boolean)
    if (!fields.length) throw new Error('Debug query projection is empty')
    if (!expression.startsWith('{') && fields.length === 1) return valueAt(record, fields[0]!)
    return Object.fromEntries(fields.map(field => {
        const path = field.replace(/^\.?/, '')
        return [path.split('.').pop()!, valueAt(record, field)]
    }))
}

export class PathwardenDebugLog {
    private readonly records: PathwardenDebugRecord[] = []
    private readonly saved = new Map<string, { createdAt: string, records: PathwardenDebugRecord[] }>()
    private sequence = 0

    constructor(
        private readonly side: PathwardenDebugSide,
        private readonly capacity = MAX_RECORDS,
        private readonly storageKey?: string
    ) {
        this.loadSaved()
    }

    record(event: string, fields: Record<string, unknown> = {}) {
        const timestampMs = Date.now()
        const entry: PathwardenDebugRecord = {
            id: `${this.side}-${++this.sequence}`,
            sequence: this.sequence,
            timestamp: new Date(timestampMs).toISOString(),
            timestampMs,
            side: this.side,
            event,
            ...fields
        }
        this.records.push(entry)
        while (this.records.length > Math.min(MAX_RECORDS, Math.max(1, this.capacity))) this.records.shift()
        return entry
    }

    private matching(options: PathwardenDebugQuery = {}) {
        const test = predicate(options.filter ?? '')
        const source = options.saved
            ? this.saved.get(options.saved)?.records ?? []
            : this.records
        const beforeIndex = options.before ? source.findIndex(record => record.id === options.before) : -1
        const afterIndex = options.after ? source.findIndex(record => record.id === options.after) : -1
        const start = options.after && afterIndex >= 0 ? afterIndex + 1 : 0
        const end = options.before && beforeIndex >= 0 ? beforeIndex : source.length
        return source.slice(start, end).filter(test)
    }

    query(options: PathwardenDebugQuery = {}): PathwardenDebugQueryResult {
        const matches = this.matching(options)
        const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(options.limit ?? 100)))
        const entries = matches.slice(Math.max(0, matches.length - limit)).map(record => project(record, options.select))
        const rawEntries = matches.slice(Math.max(0, matches.length - limit))
        return {
            entries,
            total: matches.length,
            returned: entries.length,
            nextBefore: rawEntries[0]?.id ?? null,
            nextAfter: rawEntries[rawEntries.length - 1]?.id ?? null
        }
    }

    save(name: string, options: PathwardenDebugQuery = {}) {
        const normalizedName = name.trim()
        if (!normalizedName || normalizedName.length > 80) throw new Error('Debug save name must be 1-80 characters')
        const records = this.matching({ ...options, saved: undefined }).slice(-MAX_RECORDS)
        const createdAt = new Date().toISOString()
        this.saved.set(normalizedName, { createdAt, records })
        this.persistSaved()
        return this.savedInfo(normalizedName)!
    }

    listSaved(): PathwardenDebugSavedSegment[] {
        return [...this.saved.keys()].map(name => this.savedInfo(name)!)
    }

    deleteSaved(name: string) {
        const deleted = this.saved.delete(name)
        if (deleted) this.persistSaved()
        return deleted
    }

    clearSaved() {
        this.saved.clear()
        this.persistSaved()
    }

    private savedInfo(name: string): PathwardenDebugSavedSegment | undefined {
        const segment = this.saved.get(name)
        if (!segment) return undefined
        return {
            name,
            createdAt: segment.createdAt,
            count: segment.records.length,
            firstId: segment.records[0]?.id ?? null,
            lastId: segment.records[segment.records.length - 1]?.id ?? null
        }
    }

    private loadSaved() {
        if (!this.storageKey || typeof localStorage === 'undefined') return
        try {
            const value = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null') as Array<{ name?: string, createdAt?: string, records?: PathwardenDebugRecord[] }> | null
            for (const segment of value ?? []) {
                if (!segment.name || !segment.createdAt || !Array.isArray(segment.records)) continue
                this.saved.set(segment.name, { createdAt: segment.createdAt, records: segment.records.slice(-MAX_RECORDS) })
            }
        } catch {
            localStorage.removeItem(this.storageKey)
        }
    }

    private persistSaved() {
        if (!this.storageKey || typeof localStorage === 'undefined') return
        try {
            localStorage.setItem(this.storageKey, JSON.stringify([...this.saved.entries()].map(([name, segment]) => ({ name, ...segment }))))
        } catch {
            // Saved debugging is best effort; a full local storage must not affect gameplay.
        }
    }

    clear() {
        this.records.length = 0
    }
}

type PathwardenDebugGlobals = typeof globalThis & {
    __POLYNUX_PATHWARDEN_DEBUG_LOG__?: PathwardenDebugLog
    __POLYNUX_PATHWARDEN_SERVER_DEBUG_LOG__?: PathwardenDebugLog
}

export function getPathwardenDebugLog(side: PathwardenDebugSide) {
    const globals = globalThis as PathwardenDebugGlobals
    const key = side === 'client'
        ? '__POLYNUX_PATHWARDEN_DEBUG_LOG__'
        : '__POLYNUX_PATHWARDEN_SERVER_DEBUG_LOG__'
    const existing = globals[key]
    if (existing) return existing
    const logger = new PathwardenDebugLog(side, MAX_RECORDS, side === 'client' ? 'polynux:pathwarden:debug-saved:v1' : undefined)
    globals[key] = logger
    return logger
}
