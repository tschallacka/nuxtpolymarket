import { describe, expect, it } from 'vitest'
import { B } from '../../app/utils/skyfarm/blocks'
import { Island } from '../../app/utils/skyfarm/island'
import { build } from '../../app/utils/skyfarm/test-island'
import { account, growthCapacity, holdings, measureMachines, PRODUCTION_SLACK } from '../../app/utils/skyfarm/verify'
import { CHUNK, STARTER_TOP } from '../../app/utils/skyfarm/world'

const held = (entries: Record<string, number>) => new Map(Object.entries(entries))

describe('the storage check\'s accounting', () => {
    it('lets a full chest emptied into storage through: what is held goes down by what is sent', () => {
        const r = account({ trusted: { cobblestone: 1728 }, held: held({}), sent: { cobblestone: 1728 }, rates: {}, seconds: 30 })
        expect(r.accepted.cobblestone).toBe(1728)
        expect(r.trusted.cobblestone ?? 0).toBe(0)
    })

    it('turns away items that came from nowhere, every save, however many saves', () => {
        let trusted: Record<string, number> = {}
        let total = 0
        // A day of saves every 30 seconds, each claiming diamonds the island can't make.
        for (let i = 0; i < 2880; i++) {
            const r = account({ trusted, held: held({}), sent: { diamond: 64 }, rates: {}, seconds: 30 })
            total += r.accepted.diamond ?? 0
            trusted = r.trusted
        }
        expect(total).toBe(0)
    })

    it('never trusts items forged into a chest, so they can\'t be sent on a later save either', () => {
        const forged = account({ trusted: {}, held: held({ diamond: 5000 }), sent: {}, rates: {}, seconds: 30 })
        expect(forged.trusted.diamond ?? 0).toBe(0)
        const later = account({ trusted: forged.trusted, held: held({}), sent: { diamond: 5000 }, rates: {}, seconds: 30 })
        expect(later.accepted.diamond ?? 0).toBe(0)
    })

    it('lets bone meal used on the island\'s crops through as the harvest it could make, and no more', () => {
        // A wheat farm (a small natural rate) and 10 trusted bone meal, all used this time.
        const rates = { wheat: 0.01, wheat_seeds: 0.03 }
        const r = account({ trusted: { bone_meal: 10 }, held: held({}), sent: { wheat: 100 }, rates, seconds: 30 })
        // 10 bone meal: at most 10 ripe wheat on top of the natural 0.3 (×1.5, +0.3 slack).
        expect(r.accepted.wheat).toBe(Math.floor(10 + 0.3 * 1.5 + 0.3))
        // Bone meal still held doesn't count; and it only grows what the island grows (no melons here).
        const kept = account({ trusted: { bone_meal: 10 }, held: held({ bone_meal: 10 }), sent: { wheat: 100, melon_slice: 70 }, rates, seconds: 30 })
        expect(kept.accepted.wheat ?? 0).toBe(0)
        expect(kept.accepted.melon_slice ?? 0).toBe(0)
    })

    it('allows a stack of timing slack only on top of what the island makes', () => {
        // Half a cobblestone a second for 30 seconds: 15 made, 22.5 with the margin, plus up to 15 of slack.
        const r = account({ trusted: {}, held: held({}), sent: { cobblestone: 100 }, rates: { cobblestone: 0.5 }, seconds: 30 })
        expect(r.accepted.cobblestone).toBe(Math.floor(15 * 1.5 + Math.min(PRODUCTION_SLACK, 15)))
    })

    it('lets through what the island could have produced since the last check', () => {
        // A generator making a cobblestone a second: an hour away is good for about 3600 (with the margin, more).
        const r = account({ trusted: {}, held: held({}), sent: { cobblestone: 3600 }, rates: { cobblestone: 1 }, seconds: 3600 })
        expect(r.accepted.cobblestone).toBe(3600)
        const greedy = account({ trusted: {}, held: held({}), sent: { cobblestone: 100_000 }, rates: { cobblestone: 1 }, seconds: 3600 })
        expect(greedy.accepted.cobblestone).toBeLessThan(6000)
    })
})

describe('what an island holds and can produce', () => {
    it('counts chests, inventory and built blocks, not what grows', () => {
        const island = Island.fresh()
        const h = holdings(island.toSave())
        // The starter chest's ten stacks, and the island itself: dirt (grass drops dirt), the tree's logs.
        expect(h.get('ice')).toBe(2)
        expect(h.get('dirt')).toBeGreaterThan(50)
        expect(h.get('oak_log')).toBe(4)
        // Leaves grow and decay by themselves: not counted.
        expect(h.has('oak_leaves')).toBe(false)
        island.world.set(6, STARTER_TOP, 6, B.Wheat, 3)
        expect(holdings(island.toSave()).has('wheat')).toBe(false)
    })

    it('bounds what grows by the growth rules: more farmland, more wheat it could yield', () => {
        const island = Island.fresh()
        const before = growthCapacity(island.toSave()).get('wheat') ?? 0
        for (let x = 4; x < 8; x++) island.world.set(x, STARTER_TOP - 1, 5, B.Farmland)
        const after = growthCapacity(island.toSave()).get('wheat')!
        expect(after).toBeGreaterThan(before)
        // Four farmland: at best four wheat every ~3150 ticks, about 0.025 a second.
        expect(after).toBeCloseTo(4 * 20 / (7 * 300 / (2 / 3)), 5)
    })

    it('measures what machines make by replaying the island', () => {
        const island = Island.fresh()
        island.world.addCube(1, 1, 0)
        build(island, 'cobble', CHUNK, CHUNK, 0)
        const rates = measureMachines(island)
        // Eight generators, a cobblestone each every second or two.
        expect(rates.get('cobblestone')).toBeGreaterThan(2)
    })
})
