/*
 * The island's production ledger: what it makes by itself, minute by minute,
 * kept for the last ten minutes (and saved). It is what time away is worked
 * out from: the island isn't replayed tick by tick for hours, it is moved on
 * to the state its known production says it reaches.
 *
 * Only what the island makes counts as production: drops from block
 * breakers, pistons, mobs that died without you, decaying leaves; what the
 * furnaces turn out; bone meal from composters. What happens to it is
 * recorded too: sold by sell chests, sent to the store, piling up in chests.
 * Time away adds, for each item, at most what was made of it: running down
 * a stockpile (diamonds hoppered into a sell chest) is not production, so it
 * is never repeated.
 */

export type Counts = Record<string, number>

export interface LedgerBucket {
    /** Ticks this bucket covers. */
    ticks: number
    produced: Counts
    sold: Counts
    stored: Counts
    /** Net growth of what the chests hold. */
    gained: Counts
}

/** Ticks per bucket (a minute) and buckets kept (ten minutes). */
export const BUCKET_TICKS = 1200
export const BUCKETS = 10
/** Less known production than this (half a minute) is too little to go on. */
export const MIN_LEDGER_TICKS = 600

const add = (c: Counts, key: string, n: number) => {
    c[key] = (c[key] ?? 0) + n
}

const empty = (): LedgerBucket => ({ ticks: 0, produced: {}, sold: {}, stored: {}, gained: {} })

export class Ledger {
    buckets: LedgerBucket[] = []
    current = empty()
    /** What the chests held when the current bucket began. */
    private start: Map<string, number> | null = null

    produce(key: string, n: number) {
        if (n > 0) add(this.current.produced, key, n)
    }

    sell(key: string, n: number) {
        if (n > 0) add(this.current.sold, key, n)
    }

    store(key: string, n: number) {
        if (n > 0) add(this.current.stored, key, n)
    }

    /** One tick; at the end of a minute the bucket closes with how the chests changed. */
    tick(totals: () => Map<string, number>) {
        this.start ??= totals()
        if (++this.current.ticks < BUCKET_TICKS) return
        const now = totals()
        for (const key of new Set([...now.keys(), ...this.start.keys()])) {
            const d = (now.get(key) ?? 0) - (this.start.get(key) ?? 0)
            if (d !== 0) this.current.gained[key] = d
        }
        this.buckets.push(this.current)
        if (this.buckets.length > BUCKETS) this.buckets.shift()
        this.current = empty()
        this.start = now
    }

    /** Everything known, summed: the closed buckets (and the current one, as far as it goes, minus chest growth). */
    window(): LedgerBucket {
        const all = empty()
        for (const b of [...this.buckets, this.current]) {
            all.ticks += b.ticks
            for (const k of ['produced', 'sold', 'stored', 'gained'] as const) for (const [key, n] of Object.entries(b[k])) add(all[k], key, n)
        }
        return all
    }

    /**
     * What `ticks` more of the same would bring: for each item, what was sold,
     * stored and piled up, scaled, but altogether never more than was made of it.
     */
    project(ticks: number): { sold: Counts, stored: Counts, gained: Counts } | null {
        const w = this.window()
        if (w.ticks < MIN_LEDGER_TICKS) return null
        const scale = ticks / w.ticks
        const out = { sold: {} as Counts, stored: {} as Counts, gained: {} as Counts }
        for (const [key, made] of Object.entries(w.produced)) {
            let budget = made
            for (const k of ['sold', 'stored', 'gained'] as const) {
                const n = Math.min(Math.max(0, w[k][key] ?? 0), budget)
                budget -= n
                const scaled = Math.floor(n * scale)
                if (scaled > 0) out[k][key] = scaled
            }
        }
        return out
    }

    toSave(): LedgerBucket[] {
        return this.buckets
    }

    load(buckets: LedgerBucket[] | undefined) {
        this.buckets = (buckets ?? []).slice(-BUCKETS).map(b => ({ ticks: b.ticks, produced: { ...b.produced }, sold: { ...b.sold }, stored: { ...b.stored }, gained: { ...b.gained } }))
    }
}
