export const PATHWARDEN_PROTOCOL_MAGIC = 0x50
export const PATHWARDEN_PROTOCOL_VERSION = 1
export const PATHWARDEN_MAX_PACKET_BYTES = 64 * 1024

export const enum PathwardenPacketKind {
    Hello = 1,
    HelloAck = 2,
    FullSnapshot = 3,
    InputCommand = 4,
    CommandAck = 5,
    CommandReject = 6,
    Correction = 7,
    Ping = 8,
    Pong = 9,
    ProtocolError = 10,
    MapSnapshot = 11,
    MapSnapshotChunk = 12,
    EntitySnapshot = 13,
    ChoiceOffer = 14
}

export type PathwardenPhase = 'planning' | 'wave' | 'checkpoint' | 'path' | 'upgrade' | 'cashout' | 'victory' | 'defeat'

export interface PathwardenPacketHeader {
    kind: PathwardenPacketKind
    flags: number
    schema: number
    sequence: number
    tick: number
    acknowledgedInput: number
}

export interface PathwardenWorldSnapshot {
    runId: string
    revision: number
    realm: number
    seed: number
    tick: number
    phase: PathwardenPhase
    wave: number
    lives: number
    aether: number
    score: number
    paused: boolean
    entityCount: number
}

export interface PathwardenEntityState {
    id: number
    type: number
    x: number
    y: number
    z: number
    v1: number
    v2: number
    v3: number
    components?: Record<string, number | string | boolean>
}

export type PathwardenInputCommand =
    | { type: 'pause', value: boolean }
    | { type: 'start-wave' }
    | { type: 'select-tower', tower: string }
    | { type: 'place-tower', col: number, row: number }
    | { type: 'upgrade-tower', id: number }
    | { type: 'fuse-tower', sourceId: number, targetId: number }
    | { type: 'salvage-tower', id: number }
    | { type: 'move-tower', id: number, col: number, row: number }
    | { type: 'set-targeting', id: number, targeting: 'first' | 'strong' | 'fast' }
    | { type: 'checkpoint-choice', choice: number }
    | { type: 'relic-choice', choice: number }

export interface PathwardenDecodedPacket {
    header: PathwardenPacketHeader
    payload: unknown
}

const HEADER_BYTES = 20
const MAP_CHUNK_BYTES = 12 * 1024
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

class ByteWriter {
    private bytes: number[] = []

    u8(value: number) {
        this.bytes.push(value & 0xff)
    }

    u16(value: number) {
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff)
    }

    u32(value: number) {
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
    }

    varUint(value: number) {
        let remaining = Math.max(0, Math.floor(value))
        while (remaining >= 0x80) {
            this.u8((remaining & 0x7f) | 0x80)
            remaining = Math.floor(remaining / 128)
        }
        this.u8(remaining)
    }

    bool(value: boolean) {
        this.u8(value ? 1 : 0)
    }

    string(value: string, maxBytes = 4096) {
        const encoded = textEncoder.encode(value)
        if (encoded.byteLength > maxBytes) throw new Error('String exceeds protocol limit')
        this.varUint(encoded.byteLength)
        for (const byte of encoded) this.u8(byte)
    }

    writeBytes(value: Uint8Array, maxBytes = PATHWARDEN_MAX_PACKET_BYTES) {
        if (value.byteLength > maxBytes) throw new Error('Byte field exceeds protocol limit')
        this.varUint(value.byteLength)
        for (const byte of value) this.u8(byte)
    }

    signedVarInt(value: number) {
        const integer = Math.trunc(value)
        this.varUint(integer < 0 ? (-integer * 2) - 1 : integer * 2)
    }

    value(value: unknown, depth = 0) {
        if (depth > 8) throw new Error('Pathwarden compound nesting limit exceeded')
        if (value === null) {
            this.u8(0)
            return
        }
        if (value === false) {
            this.u8(1)
            return
        }
        if (value === true) {
            this.u8(2)
            return
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) throw new Error('Pathwarden compound contains a non-finite number')
            if (Number.isInteger(value)) {
                this.u8(3)
                this.signedVarInt(value)
            } else {
                this.u8(4)
                const view = new DataView(new ArrayBuffer(4))
                view.setFloat32(0, value, true)
                for (let index = 0; index < 4; index++) this.u8(view.getUint8(index))
            }
            return
        }
        if (typeof value === 'string') {
            this.u8(5)
            this.string(value, 2048)
            return
        }
        if (Array.isArray(value)) {
            if (value.length > 10_000) throw new Error('Pathwarden compound array limit exceeded')
            this.u8(6)
            this.varUint(value.length)
            for (const child of value) this.value(child, depth + 1)
            return
        }
        if (typeof value === 'object') {
            const entries = Object.entries(value)
            if (entries.length > 512) throw new Error('Pathwarden compound field limit exceeded')
            this.u8(7)
            this.varUint(entries.length)
            for (const [key, child] of entries) {
                this.string(key, 128)
                this.value(child, depth + 1)
            }
            return
        }
        throw new Error('Unsupported Pathwarden compound value')
    }

    finish() {
        return Uint8Array.from(this.bytes)
    }
}

class ByteReader {
    private offset = 0

    constructor(private readonly bytes: Uint8Array) {}

    private require(length: number) {
        if (this.offset + length > this.bytes.byteLength) throw new Error('Truncated Pathwarden packet')
    }

    u8() {
        this.require(1)
        return this.bytes[this.offset++]!
    }

    u16() {
        return this.u8() | (this.u8() << 8)
    }

    u32() {
        return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0
    }

    varUint() {
        let value = 0
        let multiplier = 1
        for (let index = 0; index < 5; index++) {
            const byte = this.u8()
            value += (byte & 0x7f) * multiplier
            if ((byte & 0x80) === 0) return value
            multiplier *= 128
        }
        throw new Error('Invalid Pathwarden varint')
    }

    signedVarInt() {
        const value = this.varUint()
        return value % 2 === 0 ? value / 2 : -((value + 1) / 2)
    }

    bool() {
        const value = this.u8()
        if (value > 1) throw new Error('Invalid Pathwarden boolean')
        return value === 1
    }

    string(maxBytes = 4096) {
        const length = this.varUint()
        if (length > maxBytes) throw new Error('String exceeds protocol limit')
        this.require(length)
        const value = textDecoder.decode(this.bytes.subarray(this.offset, this.offset + length))
        this.offset += length
        return value
    }

    bytesValue(maxBytes = PATHWARDEN_MAX_PACKET_BYTES) {
        const length = this.varUint()
        if (length > maxBytes) throw new Error('Byte field exceeds protocol limit')
        this.require(length)
        const value = this.bytes.slice(this.offset, this.offset + length)
        this.offset += length
        return value
    }

    value(depth = 0): unknown {
        if (depth > 8) throw new Error('Pathwarden compound nesting limit exceeded')
        const tag = this.u8()
        if (tag === 0) return null
        if (tag === 1) return false
        if (tag === 2) return true
        if (tag === 3) return this.signedVarInt()
        if (tag === 4) {
            const view = new DataView(new ArrayBuffer(4))
            for (let index = 0; index < 4; index++) view.setUint8(index, this.u8())
            return view.getFloat32(0, true)
        }
        if (tag === 5) return this.string(2048)
        if (tag === 6) {
            const length = this.varUint()
            if (length > 10_000) throw new Error('Pathwarden compound array limit exceeded')
            return Array.from({ length }, () => this.value(depth + 1))
        }
        if (tag === 7) {
            const length = this.varUint()
            if (length > 512) throw new Error('Pathwarden compound field limit exceeded')
            const result: Record<string, unknown> = {}
            for (let index = 0; index < length; index++) result[this.string(128)] = this.value(depth + 1)
            return result
        }
        throw new Error('Unknown Pathwarden compound tag')
    }

    raw(length: number) {
        this.require(length)
        const value = this.bytes.slice(this.offset, this.offset + length)
        this.offset += length
        return value
    }

    done() {
        return this.offset === this.bytes.byteLength
    }
}

const phaseToCode: Record<PathwardenPhase, number> = {
    planning: 0,
    wave: 1,
    checkpoint: 2,
    path: 3,
    upgrade: 4,
    cashout: 5,
    victory: 6,
    defeat: 7
}

const codeToPhase: PathwardenPhase[] = ['planning', 'wave', 'checkpoint', 'path', 'upgrade', 'cashout', 'victory', 'defeat']

function asBytes(value: ArrayBufferLike | Uint8Array) {
    return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function writeHeader(writer: ByteWriter, header: PathwardenPacketHeader, payloadLength: number) {
    writer.u8(PATHWARDEN_PROTOCOL_MAGIC)
    writer.u8(PATHWARDEN_PROTOCOL_VERSION)
    writer.u8(header.kind)
    writer.u8(header.flags)
    writer.u8(header.schema)
    writer.u8(0)
    writer.u32(header.sequence)
    writer.u32(header.tick)
    writer.u32(header.acknowledgedInput)
    writer.u16(payloadLength)
}

function readHeader(reader: ByteReader): PathwardenPacketHeader {
    if (reader.u8() !== PATHWARDEN_PROTOCOL_MAGIC) throw new Error('Invalid Pathwarden packet magic')
    if (reader.u8() !== PATHWARDEN_PROTOCOL_VERSION) throw new Error('Unsupported Pathwarden protocol version')
    const kind = reader.u8()
    if (kind < PathwardenPacketKind.Hello || kind > PathwardenPacketKind.ChoiceOffer) throw new Error('Unknown Pathwarden packet kind')
    const flags = reader.u8()
    const schema = reader.u8()
    reader.u8()
    return {
        kind,
        flags,
        schema,
        sequence: reader.u32(),
        tick: reader.u32(),
        acknowledgedInput: reader.u32()
    }
}

function encodePacket(header: PathwardenPacketHeader, payload: Uint8Array) {
    if (payload.byteLength + HEADER_BYTES > PATHWARDEN_MAX_PACKET_BYTES) throw new Error('Pathwarden packet exceeds size limit')
    const writer = new ByteWriter()
    writeHeader(writer, header, payload.byteLength)
    const headerBytes = writer.finish()
    const packet = new Uint8Array(headerBytes.byteLength + payload.byteLength)
    packet.set(headerBytes)
    packet.set(payload, headerBytes.byteLength)
    return packet.buffer
}

export function encodeHello(sequence = 0) {
    const payload = new ByteWriter()
    payload.u8(1)
    return encodePacket({ kind: PathwardenPacketKind.Hello, flags: 0, schema: 1, sequence, tick: 0, acknowledgedInput: 0 }, payload.finish())
}

export function encodeHelloAck(header: Partial<PathwardenPacketHeader> = {}) {
    const payload = new ByteWriter()
    payload.u8(1)
    return encodePacket({ kind: PathwardenPacketKind.HelloAck, flags: 0, schema: 1, sequence: header.sequence ?? 0, tick: header.tick ?? 0, acknowledgedInput: header.acknowledgedInput ?? 0 }, payload.finish())
}

export function encodeWorldSnapshot(snapshot: PathwardenWorldSnapshot, header: Partial<PathwardenPacketHeader> = {}) {
    const payload = new ByteWriter()
    payload.string(snapshot.runId, 128)
    payload.u32(snapshot.revision)
    payload.u8(snapshot.realm)
    payload.u32(snapshot.seed)
    payload.u8(phaseToCode[snapshot.phase])
    payload.u8(snapshot.wave)
    payload.u16(snapshot.lives)
    payload.u32(Math.max(0, Math.round(snapshot.aether * 100)))
    payload.u32(snapshot.score)
    payload.bool(snapshot.paused)
    payload.varUint(snapshot.entityCount)
    return encodePacket({ kind: PathwardenPacketKind.FullSnapshot, flags: 0, schema: 1, sequence: header.sequence ?? 0, tick: snapshot.tick, acknowledgedInput: header.acknowledgedInput ?? 0 }, payload.finish())
}

export function encodeMapSnapshot(mapPlan: unknown, header: Partial<PathwardenPacketHeader> = {}) {
    const payload = new ByteWriter()
    payload.value(mapPlan)
    return encodePacket({ kind: PathwardenPacketKind.MapSnapshot, flags: 0, schema: 1, sequence: header.sequence ?? 0, tick: header.tick ?? 0, acknowledgedInput: header.acknowledgedInput ?? 0 }, payload.finish())
}

export function encodeMapSnapshotChunks(mapPlan: unknown, firstSequence = 0) {
    const compound = new ByteWriter()
    compound.value(mapPlan)
    const bytes = compound.finish()
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / MAP_CHUNK_BYTES))
    return Array.from({ length: chunkCount }, (_, chunkIndex) => {
        const payload = new ByteWriter()
        payload.varUint(chunkIndex)
        payload.varUint(chunkCount)
        payload.writeBytes(bytes.slice(chunkIndex * MAP_CHUNK_BYTES, (chunkIndex + 1) * MAP_CHUNK_BYTES), MAP_CHUNK_BYTES)
        return encodePacket({ kind: PathwardenPacketKind.MapSnapshotChunk, flags: 0, schema: 1, sequence: firstSequence + chunkIndex, tick: 0, acknowledgedInput: 0 }, payload.finish())
    })
}

export function decodeCompound(value: ArrayBufferLike | Uint8Array) {
    const reader = new ByteReader(asBytes(value))
    const decoded = reader.value()
    if (!reader.done()) throw new Error('Trailing Pathwarden compound data')
    return decoded
}

export function encodeCommandAck(inputSequence: number, tick: number, accepted: boolean, reason = '') {
    const payload = new ByteWriter()
    payload.varUint(inputSequence)
    payload.bool(accepted)
    payload.string(reason, 160)
    return encodePacket({ kind: accepted ? PathwardenPacketKind.CommandAck : PathwardenPacketKind.CommandReject, flags: 0, schema: 1, sequence: inputSequence, tick, acknowledgedInput: inputSequence }, payload.finish())
}

export function encodeEntitySnapshot(entities: PathwardenEntityState[], header: Partial<PathwardenPacketHeader> = {}) {
    if (entities.length > 10_000) throw new Error('Pathwarden entity count exceeds protocol limit')
    const payload = new ByteWriter()
    payload.varUint(entities.length)
    for (const entity of entities) {
        payload.varUint(entity.id)
        payload.u8(entity.type)
        payload.value(entity.x)
        payload.value(entity.y)
        payload.value(entity.z)
        payload.value(entity.v1)
        payload.value(entity.v2)
        payload.value(entity.v3)
        payload.value(entity.components ?? null)
    }
    return encodePacket({ kind: PathwardenPacketKind.EntitySnapshot, flags: 0, schema: 1, sequence: header.sequence ?? 0, tick: header.tick ?? 0, acknowledgedInput: header.acknowledgedInput ?? 0 }, payload.finish())
}

export function encodeChoiceOffer(kind: 'checkpoint' | 'relic', choices: number[], header: Partial<PathwardenPacketHeader> = {}) {
    if (choices.length > 8) throw new Error('Pathwarden choice count exceeds protocol limit')
    const payload = new ByteWriter()
    payload.u8(kind === 'checkpoint' ? 1 : 2)
    payload.varUint(choices.length)
    for (const choice of choices) payload.varUint(choice)
    return encodePacket({ kind: PathwardenPacketKind.ChoiceOffer, flags: 0, schema: 1, sequence: header.sequence ?? 0, tick: header.tick ?? 0, acknowledgedInput: header.acknowledgedInput ?? 0 }, payload.finish())
}

export function encodeProtocolError(message: string) {
    const payload = new ByteWriter()
    payload.string(message, 240)
    return encodePacket({ kind: PathwardenPacketKind.ProtocolError, flags: 0, schema: 1, sequence: 0, tick: 0, acknowledgedInput: 0 }, payload.finish())
}

export function encodeInputCommand(inputSequence: number, command: PathwardenInputCommand, desiredTick = 0) {
    const payload = new ByteWriter()
    payload.varUint(inputSequence)
    payload.varUint(desiredTick)
    const type = command.type === 'pause' ? 1 : command.type === 'start-wave' ? 2 : command.type === 'select-tower' ? 3 : command.type === 'place-tower' ? 4 : command.type === 'upgrade-tower' ? 5 : command.type === 'fuse-tower' ? 6 : command.type === 'salvage-tower' ? 7 : command.type === 'move-tower' ? 8 : command.type === 'set-targeting' ? 9 : command.type === 'checkpoint-choice' ? 10 : 11
    payload.u8(type)
    if (command.type === 'pause') payload.bool(command.value)
    if (command.type === 'select-tower') payload.string(command.tower, 32)
    if (command.type === 'place-tower') {
        payload.u16(command.col)
        payload.u16(command.row)
    }
    if (command.type === 'upgrade-tower' || command.type === 'salvage-tower') payload.varUint(command.id)
    if (command.type === 'fuse-tower') {
        payload.varUint(command.sourceId)
        payload.varUint(command.targetId)
    }
    if (command.type === 'move-tower') {
        payload.varUint(command.id)
        payload.u16(command.col)
        payload.u16(command.row)
    }
    if (command.type === 'set-targeting') {
        payload.varUint(command.id)
        payload.u8(command.targeting === 'first' ? 1 : command.targeting === 'strong' ? 2 : 3)
    }
    if (command.type === 'checkpoint-choice' || command.type === 'relic-choice') payload.varUint(command.choice)
    return encodePacket({ kind: PathwardenPacketKind.InputCommand, flags: 0, schema: 1, sequence: inputSequence, tick: desiredTick, acknowledgedInput: 0 }, payload.finish())
}

export function decodePacket(value: ArrayBufferLike | Uint8Array): PathwardenDecodedPacket {
    const bytes = asBytes(value)
    if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > PATHWARDEN_MAX_PACKET_BYTES) throw new Error('Invalid Pathwarden packet length')
    const reader = new ByteReader(bytes)
    const header = readHeader(reader)
    const payloadLength = reader.u16()
    if (payloadLength !== bytes.byteLength - HEADER_BYTES) throw new Error('Invalid Pathwarden payload length')
    const payloadReader = new ByteReader(reader.raw(payloadLength))
    let payload: unknown = null
    if (header.kind === PathwardenPacketKind.Hello) payload = { capabilities: payloadReader.u8() }
    else if (header.kind === PathwardenPacketKind.HelloAck) payload = { accepted: payloadReader.u8() === 1 }
    else if (header.kind === PathwardenPacketKind.FullSnapshot) {
        payload = {
            runId: payloadReader.string(128),
            revision: payloadReader.u32(),
            realm: payloadReader.u8(),
            seed: payloadReader.u32(),
            phase: codeToPhase[payloadReader.u8()] ?? 'planning',
            wave: payloadReader.u8(),
            lives: payloadReader.u16(),
            aether: payloadReader.u32() / 100,
            score: payloadReader.u32(),
            paused: payloadReader.bool(),
            entityCount: payloadReader.varUint()
        }
    } else if (header.kind === PathwardenPacketKind.InputCommand) {
        const inputSequence = payloadReader.varUint()
        const desiredTick = payloadReader.varUint()
        const type = payloadReader.u8()
        payload = type === 1
            ? { inputSequence, desiredTick, command: { type: 'pause', value: payloadReader.bool() } }
            : type === 2
                ? { inputSequence, desiredTick, command: { type: 'start-wave' } }
                : type === 3
                    ? { inputSequence, desiredTick, command: { type: 'select-tower', tower: payloadReader.string(32) } }
                    : type === 4
                        ? { inputSequence, desiredTick, command: { type: 'place-tower', col: payloadReader.u16(), row: payloadReader.u16() } }
                        : type === 5
                            ? { inputSequence, desiredTick, command: { type: 'upgrade-tower', id: payloadReader.varUint() } }
                            : type === 6
                                ? { inputSequence, desiredTick, command: { type: 'fuse-tower', sourceId: payloadReader.varUint(), targetId: payloadReader.varUint() } }
                                : type === 7
                                    ? { inputSequence, desiredTick, command: { type: 'salvage-tower', id: payloadReader.varUint() } }
                                    : type === 8
                                        ? { inputSequence, desiredTick, command: { type: 'move-tower', id: payloadReader.varUint(), col: payloadReader.u16(), row: payloadReader.u16() } }
                                        : type === 9
                                            ? { inputSequence, desiredTick, command: { type: 'set-targeting', id: payloadReader.varUint(), targeting: (['first', 'strong', 'fast'] as const)[payloadReader.u8() - 1] ?? 'first' } }
                                            : type === 10
                            ? { inputSequence, desiredTick, command: { type: 'checkpoint-choice', choice: payloadReader.varUint() } }
                            : type === 11
                                ? { inputSequence, desiredTick, command: { type: 'relic-choice', choice: payloadReader.varUint() } }
                        : null
    } else if (header.kind === PathwardenPacketKind.CommandAck || header.kind === PathwardenPacketKind.CommandReject) {
        payload = { inputSequence: payloadReader.varUint(), accepted: payloadReader.bool(), reason: payloadReader.string(160) }
    } else if (header.kind === PathwardenPacketKind.ProtocolError) {
        payload = { message: payloadReader.string(240) }
    } else if (header.kind === PathwardenPacketKind.MapSnapshot) {
        payload = payloadReader.value()
    } else if (header.kind === PathwardenPacketKind.MapSnapshotChunk) {
        payload = {
            chunkIndex: payloadReader.varUint(),
            chunkCount: payloadReader.varUint(),
            bytes: payloadReader.bytesValue(MAP_CHUNK_BYTES)
        }
    } else if (header.kind === PathwardenPacketKind.EntitySnapshot) {
        const count = payloadReader.varUint()
        if (count > 10_000) throw new Error('Pathwarden entity count exceeds protocol limit')
        payload = Array.from({ length: count }, () => ({
            id: payloadReader.varUint(),
            type: payloadReader.u8(),
            x: payloadReader.value() as number,
            y: payloadReader.value() as number,
            z: payloadReader.value() as number,
            v1: payloadReader.value() as number,
            v2: payloadReader.value() as number,
            v3: payloadReader.value() as number,
            components: (payloadReader.value() as Record<string, number | string | boolean> | null) ?? undefined
        }))
    } else if (header.kind === PathwardenPacketKind.ChoiceOffer) {
        const kind = payloadReader.u8()
        const count = payloadReader.varUint()
        if (count > 8) throw new Error('Pathwarden choice count exceeds protocol limit')
        payload = {
            kind: kind === 1 ? 'checkpoint' : 'relic',
            choices: Array.from({ length: count }, () => payloadReader.varUint())
        }
    }
    if (!payloadReader.done()) throw new Error('Trailing Pathwarden packet data')
    return { header, payload }
}
