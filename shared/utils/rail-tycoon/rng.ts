// Rail Tycoon's seeded RNG exists for simulation determinism only: every peer advances it identically
// and a save restores it. It must never decide a payout, which is why the game is exempt from
// shared/utils/random (nothing in Rail Tycoon pays coins or gems).

const TWO_32 = 0x100000000

function checkU32(value: number, what: string): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${what} must be a u32: ${value}`)
    }
}

/** A mulberry32-style 32-bit generator whose whole state is one u32. */
export class RtRng {
    private s: number

    constructor(seed: number) {
        checkU32(seed, 'seed')
        this.s = seed
    }

    /** The generator state; assigning a saved value resumes the exact sequence. */
    get state(): number {
        return this.s
    }

    set state(value: number) {
        checkU32(value, 'state')
        this.s = value
    }

    /** The next u32. */
    next(): number {
        this.s = (this.s + 0x6d2b79f5) >>> 0
        let t = this.s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return (t ^ (t >>> 14)) >>> 0
    }

    /** A uniform integer in [min, max], by rejection sampling so no value is favoured. */
    int(min: number, max: number): number {
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
            throw new RangeError(`bad range ${min}..${max}`)
        }
        const span = max - min + 1
        if (span > TWO_32) throw new RangeError(`range ${min}..${max} wider than 2^32`)
        const limit = TWO_32 - TWO_32 % span
        let draw = this.next()
        while (draw >= limit) draw = this.next()
        return min + draw % span
    }

    /** True with probability numerator / denominator, in integers only. */
    chance(numerator: number, denominator: number): boolean {
        if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
            || denominator < 1 || denominator > TWO_32 || numerator < 0) {
            throw new RangeError(`bad chance ${numerator}/${denominator}`)
        }
        return this.int(0, denominator - 1) < numerator
    }
}
