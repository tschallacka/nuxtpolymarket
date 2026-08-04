import { describe, expect, it } from 'vitest'
import { predictPathwardenSnapshot } from '#shared/pathwarden/prediction'
import type { PathwardenWorldSnapshot } from '#shared/pathwarden/protocol'

const snapshot: PathwardenWorldSnapshot = {
    runId: 'prediction-test',
    revision: 1,
    realm: 1,
    seed: 7,
    tick: 10,
    phase: 'planning',
    wave: 0,
    lives: 20,
    maxLives: 20,
    aether: 205,
    score: 0,
    streak: 0,
    flawlessWaves: 0,
    relicPower: 0,
    paused: false,
    entityCount: 0,
    claimedRoomIds: ['room-castle'],
    revealedCells: [{ col: 1, row: 1 }]
}

describe('Pathwarden client prediction', () => {
    it('predicts only the safe planning-to-wave transition', () => {
        const predicted = predictPathwardenSnapshot(snapshot, [{ type: 'start-wave' }])

        expect(predicted.phase).toBe('wave')
        expect(predicted.wave).toBe(1)
        expect(predicted.aether).toBe(snapshot.aether)
        expect(predicted.entityCount).toBe(snapshot.entityCount)
        expect(predicted.claimedRoomIds).toEqual(snapshot.claimedRoomIds)
    })

    it('predicts pause only during an active wave', () => {
        const wave = { ...snapshot, phase: 'wave' as const, wave: 1 }
        expect(predictPathwardenSnapshot(wave, [{ type: 'pause', value: true }]).paused).toBe(true)
        expect(predictPathwardenSnapshot(snapshot, [{ type: 'pause', value: true }]).paused).toBe(false)
    })

    it('lets the authoritative snapshot win when a command is rejected', () => {
        const predicted = predictPathwardenSnapshot(snapshot, [{ type: 'start-wave' }])
        const corrected = predictPathwardenSnapshot({ ...snapshot, tick: 11 }, [])

        expect(predicted.phase).toBe('wave')
        expect(corrected.phase).toBe('planning')
        expect(corrected.wave).toBe(0)
    })
})
