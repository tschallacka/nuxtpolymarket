import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '#server/database'
import { skyfarmIslands, skyfarmOrders, skyfarmStorage, skyfarmTrades } from '#server/database/schema'
import { getBalance } from '#server/utils/balance'
import { addStorage, cancelOrder, placeOrder, sellToSystem, withdrawStorage } from '#server/utils/skyfarm-market'
import { systemPrice } from '../../app/utils/skyfarm/market'
import { SKIP, burst, cleanupUser, seedUser } from '../setup/db-helpers'

const SELLER = 'test-skyfarm-seller'
const BUYER = 'test-skyfarm-buyer'
const USERS = [SELLER, BUYER]

async function stored(userId: string, item: string) {
    const [row] = await db.select({ amount: skyfarmStorage.amount }).from(skyfarmStorage)
        .where(and(eq(skyfarmStorage.userId, userId), eq(skyfarmStorage.item, item)))
    return row?.amount ?? 0
}

const coins = async (userId: string) => parseFloat(await getBalance(userId))

async function cleanup() {
    await db.delete(skyfarmOrders).where(inArray(skyfarmOrders.userId, USERS))
    await db.delete(skyfarmTrades).where(inArray(skyfarmTrades.sellerId, USERS))
    await db.delete(skyfarmTrades).where(inArray(skyfarmTrades.buyerId, USERS))
    await db.delete(skyfarmStorage).where(inArray(skyfarmStorage.userId, USERS))
    await db.delete(skyfarmIslands).where(inArray(skyfarmIslands.userId, USERS))
    for (const id of USERS) await cleanupUser(id)
}

describe.skipIf(SKIP)('the Skyfarm market (database)', () => {
    beforeEach(async () => {
        await cleanup()
        await seedUser(SELLER, { balance: '0' })
        await seedUser(BUYER, { balance: '100' })
        // Trading needs an island (its row is the market's per-player lock).
        for (const userId of USERS) await db.insert(skyfarmIslands).values({ userId, revision: 1, saveVersion: 1 })
        await db.transaction(tx => addStorage(tx, SELLER, 'cobblestone', 100))
    })
    afterEach(cleanup)

    it('matches a buy against a standing sell at the seller\'s price, and refunds the buyer the difference', async () => {
        const sell = await placeOrder(SELLER, 'cobblestone', 'sell', 0.05, 100)
        expect(sell.remaining).toBe(100)
        // The sell holds its items.
        expect(await stored(SELLER, 'cobblestone')).toBe(0)
        const buy = await placeOrder(BUYER, 'cobblestone', 'buy', 0.06, 60)
        expect(buy.filled).toBe(60)
        expect(await stored(BUYER, 'cobblestone')).toBe(60)
        expect(await coins(SELLER)).toBeCloseTo(3, 4)
        expect(await coins(BUYER)).toBeCloseTo(100 - 3, 4)
        // Cancelling gives the seller the 40 still held back.
        await cancelOrder(SELLER, sell.orderId)
        expect(await stored(SELLER, 'cobblestone')).toBe(40)
    })

    it('refunds a cancelled order once, however many cancels arrive at once', async () => {
        const sell = await placeOrder(SELLER, 'cobblestone', 'sell', 0.05, 100)
        const r = await burst(10, () => cancelOrder(SELLER, sell.orderId))
        expect(r.ok).toBe(1)
        expect(await stored(SELLER, 'cobblestone')).toBe(100)
    })

    it('sells to standing buy orders above the system\'s price first, the rest to the system', async () => {
        // A bid above what the system pays fills; one below it doesn't (the system pays more).
        await placeOrder(BUYER, 'cobblestone', 'buy', 1.5, 30)
        await placeOrder(BUYER, 'cobblestone', 'buy', systemPrice('cobblestone') / 2, 10)
        const r = await sellToSystem(SELLER, 'cobblestone', 100)
        expect(r.filledByPlayers).toBe(30)
        expect(r.toPlayers).toBeCloseTo(45, 4)
        expect(r.toSystem).toBeCloseTo(systemPrice('cobblestone') * 70, 4)
        expect(await stored(SELLER, 'cobblestone')).toBe(0)
        expect(await stored(BUYER, 'cobblestone')).toBe(30)
        expect(await coins(SELLER)).toBeCloseTo(45 + systemPrice('cobblestone') * 70, 4)
    })

    it('sells the same stock once, however many sells arrive at once', async () => {
        const r = await burst(10, () => sellToSystem(SELLER, 'cobblestone', 100))
        expect(r.ok).toBe(1)
        expect(await coins(SELLER)).toBeCloseTo(systemPrice('cobblestone') * 100, 4)
    })

    it('needs the coins for a buy order up front', async () => {
        await expect(placeOrder(SELLER, 'cobblestone', 'buy', 1, 10)).rejects.toThrow()
        expect(await coins(SELLER)).toBe(0)
    })

    it('trusts what comes out of storage as held, so it can go back in', async () => {
        await withdrawStorage(SELLER, 'cobblestone', 64)
        expect(await stored(SELLER, 'cobblestone')).toBe(36)
        const [row] = await db.select({ trusted: skyfarmIslands.trusted }).from(skyfarmIslands).where(eq(skyfarmIslands.userId, SELLER))
        expect(row!.trusted!.cobblestone).toBe(64)
    })
})
