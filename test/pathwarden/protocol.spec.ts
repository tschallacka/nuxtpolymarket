import { describe, expect, it } from 'vitest'
import {
    decodePacket,
    decodeCompound,
    encodeEntitySnapshot,
    encodeChoiceOffer,
    encodeMapSnapshotChunks,
    encodeHello,
    encodeInputCommand,
    encodeWorldSnapshot,
    PathwardenPacketKind
} from '#shared/pathwarden/protocol'
import { createPathwardenMapPlan } from '#shared/utils/gamelogic/pathwarden-map'

describe('Pathwarden binary gameplay protocol', () => {
    it('round-trips a compact world snapshot', () => {
        const packet = encodeWorldSnapshot({
            runId: 'run-1',
            revision: 7,
            realm: 3,
            seed: 0xffffffff,
            tick: 120,
            phase: 'wave',
            wave: 4,
            lives: 19,
            aether: 123.45,
            score: 9001,
            streak: 2,
            flawlessWaves: 3,
            relicPower: 0.4,
            paused: false,
            entityCount: 42,
            claimedRoomIds: ['castle'],
            revealedCells: [{ col: 4, row: 8 }]
        }, { sequence: 9, acknowledgedInput: 8 })
        const decoded = decodePacket(packet)
        expect(decoded.header.kind).toBe(PathwardenPacketKind.FullSnapshot)
        expect(decoded.header.sequence).toBe(9)
        expect(decoded.header.acknowledgedInput).toBe(8)
        expect(decoded.payload).toEqual({
            runId: 'run-1',
            revision: 7,
            realm: 3,
            seed: 0xffffffff,
            phase: 'wave',
            wave: 4,
            lives: 19,
            aether: 123.45,
            score: 9001,
            streak: 2,
            flawlessWaves: 3,
            relicPower: 0.4,
            paused: false,
            entityCount: 42,
            claimedRoomIds: ['castle'],
            revealedCells: [{ col: 4, row: 8 }]
        })
    })

    it('round-trips semantic commands without JSON', () => {
        const packet = encodeInputCommand(12, { type: 'place-tower', col: 31, row: 9 }, 100)
        const decoded = decodePacket(packet)
        expect(decoded.header.kind).toBe(PathwardenPacketKind.InputCommand)
        expect(decoded.payload).toEqual({
            inputSequence: 12,
            desiredTick: 100,
            command: { type: 'place-tower', col: 31, row: 9 }
        })
        expect(packet.byteLength).toBeLessThan(64)
    })

    it('rejects malformed and trailing data', () => {
        const packet = new Uint8Array(encodeHello())
        expect(() => decodePacket(packet.slice(0, -1))).toThrow('Invalid Pathwarden payload length')
        const trailing = new Uint8Array(packet.byteLength + 1)
        trailing.set(packet)
        trailing[trailing.length - 1] = 1
        expect(() => decodePacket(trailing)).toThrow('Invalid Pathwarden payload length')
    })

    it('round-trips the server map as a typed compound byte stream', () => {
        const map = createPathwardenMapPlan({ seed: 1, realm: 1 })
        const packets = encodeMapSnapshotChunks(map)
        const chunks = packets.map(packet => decodePacket(packet).payload as { chunkIndex: number, chunkCount: number, bytes: Uint8Array })
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0))
        let offset = 0
        for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
            bytes.set(chunk.bytes, offset)
            offset += chunk.bytes.byteLength
            expect(chunk.chunkCount).toBe(packets.length)
        }
        expect(decodeCompound(bytes)).toEqual(map)
        expect(Math.max(...packets.map(packet => packet.byteLength))).toBeLessThan(13 * 1024)
    })

    it('round-trips authoritative entity state', () => {
        const packet = encodeEntitySnapshot([{
            id: 7,
            type: 1,
            x: 12,
            y: 13,
            z: 0,
            v1: 0.5,
            v2: 0,
            v3: 0,
            components: { towerType: 'bolt', col: 12, row: 13 }
        }])
        const decoded = decodePacket(packet)
        expect(decoded.header.kind).toBe(PathwardenPacketKind.EntitySnapshot)
        expect(decoded.payload).toEqual([{
            id: 7,
            type: 1,
            x: 12,
            y: 13,
            z: 0,
            v1: 0.5,
            v2: 0,
            v3: 0,
            components: { towerType: 'bolt', col: 12, row: 13 }
        }])
    })

    it('round-trips bounded server choice offers and choice commands', () => {
        const offer = decodePacket(encodeChoiceOffer('checkpoint', [0, 1, 2], {}, 7))
        expect(offer.payload).toEqual({ kind: 'checkpoint', offerRevision: 7, choices: [0, 1, 2] })
        const command = decodePacket(encodeInputCommand(4, { type: 'checkpoint-choice', choice: 2, offerRevision: 7 }))
        expect(command.payload).toMatchObject({ command: { type: 'checkpoint-choice', choice: 2, offerRevision: 7 } })
        const pathOffer = decodePacket(encodeChoiceOffer('path', [0, 1, 2], {}, 8))
        expect(pathOffer.payload).toEqual({ kind: 'path', offerRevision: 8, choices: [0, 1, 2] })
        const pathCommand = decodePacket(encodeInputCommand(5, { type: 'claim-path', choice: 1, offerRevision: 8 }))
        expect(pathCommand.payload).toMatchObject({ command: { type: 'claim-path', choice: 1, offerRevision: 8 } })
    })

    it('round-trips building commands with compact numeric payloads', () => {
        const commands = [
            { type: 'upgrade-tower', id: 4 },
            { type: 'fuse-tower', sourceId: 4, targetId: 9 },
            { type: 'salvage-tower', id: 9 },
            { type: 'move-tower', id: 9, col: 31, row: 12 },
            { type: 'set-targeting', id: 9, targeting: 'strong' as const },
            { type: 'sell-relic', instanceId: 8 },
            { type: 'bind-relic', towerId: 9, instanceId: 8 }
        ]
        for (const command of commands) {
            const decoded = decodePacket(encodeInputCommand(3, command))
            expect(decoded.payload).toMatchObject({ command })
        }
    })
})
