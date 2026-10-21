import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '#server/database'
import { skyfarmIslands, skyfarmOrders, skyfarmStorage, skyfarmTrades } from '#server/database/schema'
import { credit, debit } from '#server/utils/balance'
import { itemId } from '#shared/utils/skyfarm/item-ids'
import { matchGemOrder } from '#shared/utils/gamelogic/gem-exchange'
import { isMarketItem, isValidPrice, isValidQuantity, MARKET_MAX_OPEN_ORDERS, orderTotal, systemPrice } from '../../app/utils/skyfarm/market'

/*
 * Skyfarm storage and its market, on the server: the storage table is the one
 * place items become worth site coins, so every change to it happens here, in
 * a transaction. Same shape as Polytown's market (server/utils/town.ts): one
 * advisory lock per item's book, then every player a trade touches locked in a
 * sorted pass (their island row), so two trades can't deadlock.
 */

const CATEGORY = 'skyfarm:market'
const CATEGORY_REFUND = 'skyfarm:market-refund'
const CATEGORY_SYSTEM = 'skyfarm:system'
/** App-unique advisory lock keys, one per item (offset by its save id). */
const LOCK_BASE = 761_552_300

const unknown = () => createError({ statusCode: 400, statusMessage: 'Unknown item' })

async function lockBook(tx: DbExecutor, item: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_BASE + itemId(item)})`)
}

/** Locks a player's island row (the market's per-player lock); one without an island can't trade. */
async function lockPlayer(tx: DbExecutor, userId: string) {
    const [row] = await tx.select({ id: skyfarmIslands.id }).from(skyfarmIslands).where(eq(skyfarmIslands.userId, userId)).for('update')
    if (!row) throw createError({ statusCode: 400, statusMessage: 'Start your island first' })
}

export async function addStorage(tx: DbExecutor, userId: string, item: string, n: number) {
    if (n <= 0) return
    await tx.insert(skyfarmStorage).values({ userId, item, amount: n })
        .onConflictDoUpdate({ target: [skyfarmStorage.userId, skyfarmStorage.item], set: { amount: sql`${skyfarmStorage.amount} + ${n}` } })
}

/** Takes `n` of an item out of storage; throws when there isn't that much (the update is the guard). */
export async function takeStorage(tx: DbExecutor, userId: string, item: string, n: number) {
    if (n <= 0) return
    const [row] = await tx.update(skyfarmStorage).set({ amount: sql`${skyfarmStorage.amount} - ${n}` })
        .where(and(eq(skyfarmStorage.userId, userId), eq(skyfarmStorage.item, item), gte(skyfarmStorage.amount, n)))
        .returning({ amount: skyfarmStorage.amount })
    if (!row) throw createError({ statusCode: 400, statusMessage: 'Not that many in storage' })
}

/** Your storage, your open orders, and the system's price for each item you hold. */
export async function storageView(userId: string) {
    const items = await db.select({ item: skyfarmStorage.item, amount: skyfarmStorage.amount }).from(skyfarmStorage)
        .where(and(eq(skyfarmStorage.userId, userId), sql`${skyfarmStorage.amount} > 0`))
    const orders = await db.select().from(skyfarmOrders)
        .where(and(eq(skyfarmOrders.userId, userId), eq(skyfarmOrders.status, 'open'))).orderBy(desc(skyfarmOrders.createdAt))
    return {
        items: items.map(r => ({ item: r.item, amount: r.amount, systemPrice: systemPrice(r.item) })).sort((a, b) => b.amount - a.amount),
        orders: orders.map(o => ({ id: o.id, item: o.item, side: o.side as 'buy' | 'sell', price: parseFloat(o.price), quantity: o.quantity, filled: o.filled }))
    }
}

/** One item's book: the best ten buy and sell prices (summed per price), recent trades, and the system's price. */
export async function bookView(item: string) {
    if (!isMarketItem(item)) throw unknown()
    const side = async (s: 'buy' | 'sell') => (await db.select({ price: skyfarmOrders.price, quantity: sql<number>`sum(${skyfarmOrders.quantity} - ${skyfarmOrders.filled})`.mapWith(Number) })
        .from(skyfarmOrders)
        .where(and(eq(skyfarmOrders.item, item), eq(skyfarmOrders.status, 'open'), eq(skyfarmOrders.side, s)))
        .groupBy(skyfarmOrders.price)
        .orderBy(s === 'buy' ? desc(skyfarmOrders.price) : asc(skyfarmOrders.price))
        .limit(10)).map(r => ({ price: parseFloat(r.price), quantity: r.quantity }))
    const trades = await db.select({ price: skyfarmTrades.price, quantity: skyfarmTrades.quantity, at: skyfarmTrades.createdAt }).from(skyfarmTrades)
        .where(eq(skyfarmTrades.item, item)).orderBy(desc(skyfarmTrades.createdAt)).limit(20)
    return {
        item,
        systemPrice: systemPrice(item),
        bids: await side('buy'),
        asks: await side('sell'),
        trades: trades.map(t => ({ price: parseFloat(t.price), quantity: t.quantity, at: t.at.getTime() }))
    }
}

/** Takes `n` out of storage back into the game (the island will hold them: they count as held from now on). */
export async function withdrawStorage(userId: string, item: string, n: number) {
    if (!isMarketItem(item)) throw unknown()
    if (!isValidQuantity(n)) throw createError({ statusCode: 400, statusMessage: 'Quantity must be a whole number' })
    return db.transaction(async (tx) => {
        await lockPlayer(tx, userId)
        await takeStorage(tx, userId, item, n)
        // What comes out of storage is trusted as held, or it couldn't go back in.
        await tx.update(skyfarmIslands)
            .set({ trusted: sql`jsonb_set(coalesce(${skyfarmIslands.trusted}, '{}'::jsonb), ${`{${item}}`}::text[], to_jsonb(coalesce((${skyfarmIslands.trusted} ->> ${item})::numeric, 0) + ${n}))` })
            .where(eq(skyfarmIslands.userId, userId))
        return { item, withdrawn: n }
    })
}

/**
 * Sells to the system: players' standing buy orders at or above the system's
 * price fill first (best price first), the system takes the rest at its price.
 */
export async function sellToSystem(userId: string, item: string, quantity: number) {
    if (!isMarketItem(item)) throw unknown()
    if (!isValidQuantity(quantity)) throw createError({ statusCode: 400, statusMessage: 'Quantity must be a whole number' })
    const floor = systemPrice(item)
    return db.transaction(async (tx) => {
        await lockBook(tx, item)
        const rows = await tx.select().from(skyfarmOrders)
            .where(and(eq(skyfarmOrders.item, item), eq(skyfarmOrders.status, 'open'), eq(skyfarmOrders.side, 'buy'), gte(skyfarmOrders.price, Math.max(floor, 0.0001).toFixed(4))))
            .orderBy(desc(skyfarmOrders.price), asc(skyfarmOrders.createdAt))
        const book = rows.filter(r => r.userId !== userId).map(r => ({ id: r.id, userId: r.userId, price: parseFloat(r.price), remaining: r.quantity - r.filled }))
        const { fills, remaining } = matchGemOrder({ side: 'sell', price: Math.max(floor, 0.0001), quantity, book })
        if (remaining > 0 && floor <= 0) throw createError({ statusCode: 400, statusMessage: 'Nobody buys that: put up a sell order instead' })
        for (const id of [...new Set([userId, ...fills.map(f => f.userId)])].sort()) await lockPlayer(tx, id)
        await takeStorage(tx, userId, item, quantity)
        let toPlayers = 0
        for (const fill of fills) {
            await fillResting(tx, fill.orderId, fill.quantity)
            await addStorage(tx, fill.userId, item, fill.quantity)
            await tx.insert(skyfarmTrades).values({ item, buyerId: fill.userId, sellerId: userId, price: fill.price.toFixed(4), quantity: fill.quantity })
            toPlayers += orderTotal(fill.price, fill.quantity)
        }
        const toSystem = orderTotal(floor, remaining)
        if (toPlayers > 0) await credit(userId, toPlayers.toFixed(4), CATEGORY, tx)
        if (toSystem > 0) await credit(userId, toSystem.toFixed(4), CATEGORY_SYSTEM, tx)
        return { item, quantity, toPlayers, toSystem, total: toPlayers + toSystem, filledByPlayers: quantity - remaining }
    })
}

async function fillResting(tx: DbExecutor, orderId: string, n: number) {
    const [resting] = await tx.update(skyfarmOrders)
        .set({
            filled: sql`${skyfarmOrders.filled} + ${n}`,
            status: sql`case when ${skyfarmOrders.filled} + ${n} >= ${skyfarmOrders.quantity} then 'filled' else 'open' end`,
            updatedAt: new Date()
        })
        .where(and(eq(skyfarmOrders.id, orderId), eq(skyfarmOrders.status, 'open')))
        .returning({ id: skyfarmOrders.id })
    if (!resting) throw createError({ statusCode: 500, statusMessage: 'Order book conflict' })
}

/**
 * Places a limit order: a buy holds its site coins, a sell its stored items.
 * It fills what it can against the other side at once (at their prices); the
 * rest stands in the book.
 */
export async function placeOrder(userId: string, item: string, side: 'buy' | 'sell', price: number, quantity: number) {
    if (!isMarketItem(item)) throw unknown()
    if (!isValidPrice(price)) throw createError({ statusCode: 400, statusMessage: 'Price must be above zero, with at most 4 decimals' })
    if (!isValidQuantity(quantity)) throw createError({ statusCode: 400, statusMessage: 'Quantity must be a whole number' })
    return db.transaction(async (tx) => {
        await lockBook(tx, item)
        const opposite = side === 'buy' ? 'sell' : 'buy'
        const priceStr = price.toFixed(4)
        const rows = await tx.select().from(skyfarmOrders)
            .where(and(
                eq(skyfarmOrders.item, item), eq(skyfarmOrders.status, 'open'), eq(skyfarmOrders.side, opposite),
                side === 'buy' ? lte(skyfarmOrders.price, priceStr) : gte(skyfarmOrders.price, priceStr)
            ))
            .orderBy(side === 'buy' ? asc(skyfarmOrders.price) : desc(skyfarmOrders.price), asc(skyfarmOrders.createdAt))
        // Your own orders don't trade with each other.
        const book = rows.filter(r => r.userId !== userId).map(r => ({ id: r.id, userId: r.userId, price: parseFloat(r.price), remaining: r.quantity - r.filled }))
        const { fills, remaining } = matchGemOrder({ side, price, quantity, book })
        for (const id of [...new Set([userId, ...fills.map(f => f.userId)])].sort()) await lockPlayer(tx, id)

        const [count] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(skyfarmOrders)
            .where(and(eq(skyfarmOrders.userId, userId), eq(skyfarmOrders.status, 'open')))
        if ((count?.n ?? 0) >= MARKET_MAX_OPEN_ORDERS) throw createError({ statusCode: 400, statusMessage: `All ${MARKET_MAX_OPEN_ORDERS} market slots are in use` })

        if (side === 'buy') await debit(userId, orderTotal(price, quantity).toFixed(4), CATEGORY, tx)
        else await takeStorage(tx, userId, item, quantity)

        let coins = 0
        for (const fill of fills) {
            await fillResting(tx, fill.orderId, fill.quantity)
            const total = orderTotal(fill.price, fill.quantity)
            if (side === 'buy') {
                await addStorage(tx, userId, item, fill.quantity)
                // Bought below your price: the difference comes back.
                const change = orderTotal(price, fill.quantity) - total
                if (change > 0) await credit(userId, change.toFixed(4), CATEGORY_REFUND, tx)
                await credit(fill.userId, total.toFixed(4), CATEGORY, tx)
            } else {
                await addStorage(tx, fill.userId, item, fill.quantity)
                await credit(userId, total.toFixed(4), CATEGORY, tx)
            }
            coins += total
            await tx.insert(skyfarmTrades).values({
                item,
                buyerId: side === 'buy' ? userId : fill.userId,
                sellerId: side === 'buy' ? fill.userId : userId,
                price: fill.price.toFixed(4),
                quantity: fill.quantity
            })
        }
        const filled = quantity - remaining
        const [order] = await tx.insert(skyfarmOrders)
            .values({ userId, item, side, price: priceStr, quantity, filled, status: remaining === 0 ? 'filled' : 'open' })
            .returning({ id: skyfarmOrders.id })
        return { orderId: order!.id, item, side, price, quantity, filled, remaining, coins }
    })
}

/** Cancels your open order: what it still held (coins or items) comes back. */
export async function cancelOrder(userId: string, orderId: string) {
    return db.transaction(async (tx) => {
        const [existing] = await tx.select({ item: skyfarmOrders.item }).from(skyfarmOrders)
            .where(and(eq(skyfarmOrders.id, orderId), eq(skyfarmOrders.userId, userId)))
        if (!existing) throw createError({ statusCode: 400, statusMessage: 'Order not found' })
        await lockBook(tx, existing.item)
        // Claim-then-refund: only the request that flips it to cancelled gets anything back.
        const [order] = await tx.update(skyfarmOrders).set({ status: 'cancelled', updatedAt: new Date() })
            .where(and(eq(skyfarmOrders.id, orderId), eq(skyfarmOrders.userId, userId), eq(skyfarmOrders.status, 'open')))
            .returning()
        if (!order) throw createError({ statusCode: 400, statusMessage: 'Order is no longer open' })
        const left = order.quantity - order.filled
        await lockPlayer(tx, userId)
        if (left > 0) {
            if (order.side === 'buy') await credit(userId, orderTotal(parseFloat(order.price), left).toFixed(4), CATEGORY_REFUND, tx)
            else await addStorage(tx, userId, order.item, left)
        }
        return { orderId, item: order.item, side: order.side, returned: left }
    })
}
