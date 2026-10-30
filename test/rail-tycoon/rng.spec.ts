import { describe, expect, it } from 'vitest'
import { RtRng } from '../../shared/utils/rail-tycoon/rng'

function draws(rng: RtRng, count: number): number[] {
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push(rng.next())
    return out
}

describe('RtRng', () => {
    it('gives identical 1000-value sequences for the same seed', () => {
        expect(draws(new RtRng(12345), 1000)).toEqual(draws(new RtRng(12345), 1000))
    })

    it('gives different sequences for different seeds', () => {
        expect(draws(new RtRng(1), 1000)).not.toEqual(draws(new RtRng(2), 1000))
    })

    it('returns u32 integers only', () => {
        for (const v of draws(new RtRng(0xffffffff), 1000)) {
            expect(Number.isInteger(v)).toBe(true)
            expect(v).toBeGreaterThanOrEqual(0)
            expect(v).toBeLessThanOrEqual(0xffffffff)
        }
    })

    it('resumes the identical remaining sequence from a saved state', () => {
        const a = new RtRng(777)
        draws(a, 500)
        const saved = a.state
        const rest = draws(a, 500)
        const b = new RtRng(1)
        b.state = saved
        expect(draws(b, 500)).toEqual(rest)
    })

    it('keeps int(1, 6) within 5 percent of uniform over 60000 draws', () => {
        const rng = new RtRng(42)
        const counts = [0, 0, 0, 0, 0, 0]
        for (let i = 0; i < 60000; i++) {
            const face = rng.int(1, 6)
            expect(Number.isInteger(face)).toBe(true)
            counts[face - 1]!++
        }
        for (const c of counts) {
            expect(c).toBeGreaterThanOrEqual(9500)
            expect(c).toBeLessThanOrEqual(10500)
        }
    })

    it('keeps chance(1, 4) within 5 percent of 10000 over 40000 draws', () => {
        const rng = new RtRng(4242)
        let hits = 0
        for (let i = 0; i < 40000; i++) if (rng.chance(1, 4)) hits++
        expect(hits).toBeGreaterThanOrEqual(9500)
        expect(hits).toBeLessThanOrEqual(10500)
    })

    it('handles degenerate and full-width ranges', () => {
        const rng = new RtRng(9)
        expect(rng.int(5, 5)).toBe(5)
        expect(rng.chance(0, 7)).toBe(false)
        expect(rng.chance(7, 7)).toBe(true)
        const v = rng.int(0, 0xffffffff)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(0xffffffff)
        expect(rng.int(-3, -1)).toBeLessThan(0)
    })

    it('refuses bad seeds, states and ranges', () => {
        expect(() => new RtRng(-1)).toThrow(RangeError)
        expect(() => new RtRng(2 ** 32)).toThrow(RangeError)
        expect(() => new RtRng(1.5)).toThrow(RangeError)
        const rng = new RtRng(1)
        expect(() => { rng.state = -1 }).toThrow(RangeError)
        expect(() => rng.int(2, 1)).toThrow(RangeError)
        expect(() => rng.int(0, 2 ** 32)).toThrow(RangeError)
        expect(() => rng.int(0.5, 2)).toThrow(RangeError)
        expect(() => rng.chance(1, 0)).toThrow(RangeError)
        expect(() => rng.chance(-1, 4)).toThrow(RangeError)
    })
})
