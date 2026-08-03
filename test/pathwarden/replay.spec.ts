import { describe, expect, it } from 'vitest'
import { comparePathwardenReplay, hashPathwardenState, recordPathwardenReplay, getPathwardenReplay, clearPathwardenReplay } from '#server/pathwarden/replay'

describe('Pathwarden replay diagnostics', () => {
    it('records bounded semantic command history and returns stable hashes', () => {
        const runId = 'replay-test'
        clearPathwardenReplay(runId)
        for (let sequence = 1; sequence <= 520; sequence++) recordPathwardenReplay(runId, {
            tick: sequence,
            inputSequence: sequence,
            command: { type: 'select-tower', tower: 'bolt' },
            accepted: true,
            stateHash: hashPathwardenState({
                runId,
                revision: 1,
                realm: 1,
                seed: 1,
                tick: sequence,
                phase: 'planning',
                wave: 0,
                lives: 20,
                aether: 205,
                score: 0,
                streak: 0,
                flawlessWaves: 0,
                relicPower: 0,
                paused: false,
                entityCount: 0,
                claimedRoomIds: ['castle'],
                revealedCells: []
            }, [])
        })
        const records = getPathwardenReplay(runId)
        expect(records).toHaveLength(512)
        expect(records[0]?.inputSequence).toBe(9)
        expect(records.at(-1)?.stateHash).toMatch(/^[0-9a-f]{8}$/)
        clearPathwardenReplay(runId)
        expect(getPathwardenReplay(runId)).toEqual([])
    })

    it('keeps authoritative event metadata alongside the tick hash', () => {
        const runId = 'replay-events-test'
        clearPathwardenReplay(runId)
        recordPathwardenReplay(runId, {
            tick: 12,
            events: [{ id: 7, type: 1 }, { id: 8, type: 2 }],
            stateHash: 'deadbeef'
        })

        expect(getPathwardenReplay(runId)).toEqual([{
            tick: 12,
            events: [{ id: 7, type: 1 }, { id: 8, type: 2 }],
            stateHash: 'deadbeef'
        }])
        clearPathwardenReplay(runId)
    })

    it('reports the first bounded replay divergence', () => {
        const expected = [{ tick: 1, stateHash: 'a' }]
        const actual = [{ tick: 1, stateHash: 'b' }, { tick: 2, stateHash: 'c' }]
        expect(comparePathwardenReplay(expected, actual)).toEqual({
            equal: false,
            mismatches: [
                { index: 0, expected: expected[0], actual: actual[0] },
                { index: 1, expected: undefined, actual: actual[1] }
            ]
        })
        expect(comparePathwardenReplay(expected, expected)).toEqual({ equal: true, mismatches: [] })
    })
})
