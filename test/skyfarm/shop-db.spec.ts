import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { skyfarmIslands } from '#server/database/schema'
import { getBalance } from '#server/utils/balance'
import { buyLand, buySkyfarmItem, upgradeGenerator } from '#server/utils/skyfarm-shop'
import { chunkPrice, ORE_LEVELS, SHOP } from '../../app/utils/skyfarm/economy'
import { SKIP, burst, cleanupUser, seedUser } from '../setup/db-helpers'

const PLAYER = 'test-skyfarm-shopper'

const coins = async () => parseFloat(await getBalance(PLAYER))
const row = async () => (await db.select().from(skyfarmIslands).where(eq(skyfarmIslands.userId, PLAYER)))[0]!

async function cleanup() {
    await db.delete(skyfarmIslands).where(eq(skyfarmIslands.userId, PLAYER))
    await cleanupUser(PLAYER)
}

describe.skipIf(SKIP)('the Skyfarm shop, in site coins (database)', () => {
    beforeEach(async () => {
        await cleanup()
        await seedUser(PLAYER, { balance: String(chunkPrice(0) + chunkPrice(1) + 10_000) })
        await db.insert(skyfarmIslands).values({ userId: PLAYER, revision: 1, saveVersion: 1, bought: 0, ore: 0 })
    })
    afterEach(cleanup)

    it('charges for items and trusts them as held', async () => {
        const price = SHOP.Farming!.find(r => r.item === 'wheat_seeds')!.price
        const before = await coins()
        await buySkyfarmItem(PLAYER, 'wheat_seeds', 3)
        expect(await coins()).toBeCloseTo(before - 3 * price, 4)
        expect((await row()).trusted!.wheat_seeds).toBe(3)
        await expect(buySkyfarmItem(PLAYER, 'diamond', 1)).rejects.toThrow()
    })

    it('prices land by what was bought before, and counts each purchase once in a burst', async () => {
        const r = await burst(5, () => buyLand(PLAYER))
        // Enough coins for the first two only.
        expect(r.ok).toBe(2)
        expect((await row()).bought).toBe(2)
        expect(await coins()).toBeCloseTo(10_000, 4)
    })

    it('upgrades the generator a level at a time, each charged once in a burst', async () => {
        const before = await coins()
        const r = await burst(3, () => upgradeGenerator(PLAYER))
        expect(r.ok).toBe(3)
        expect((await row()).ore).toBe(3)
        expect(await coins()).toBeCloseTo(before - ORE_LEVELS[1]!.price - ORE_LEVELS[2]!.price - ORE_LEVELS[3]!.price, 4)
    })
})
