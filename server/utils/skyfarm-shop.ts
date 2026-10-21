import { eq, sql } from 'drizzle-orm'
import { db, type DbExecutor } from '#server/database'
import { skyfarmIslands } from '#server/database/schema'
import { debit, getBalance } from '#server/utils/balance'
import { paidFor } from '#server/utils/skyfarm-verify'
import { chunkPrice, ORE_LEVELS, SHOP } from '../../app/utils/skyfarm/economy'

/*
 * What Skyfarm sells, for site coins: shop items, land and generator upgrades.
 * The server charges your balance and keeps count of what land and upgrades
 * you paid for (a save can't claim more than that); the client then puts what
 * you bought on your island. Each purchase locks your island row, so a burst of
 * the same purchase pays once per purchase and prices follow one another.
 */

const PRICES = new Map(Object.values(SHOP).flat().map(r => [r.item, r.price]))
/** At most this many of an item in one purchase (a full inventory of a 64-stack). */
const MAX_COUNT = 36 * 64

async function lockIsland(tx: DbExecutor, userId: string) {
    const [row] = await tx.select({ bought: skyfarmIslands.bought, ore: skyfarmIslands.ore, map: skyfarmIslands.map }).from(skyfarmIslands)
        .where(eq(skyfarmIslands.userId, userId)).for('update')
    if (!row) throw createError({ statusCode: 400, statusMessage: 'Start your island first' })
    // An island from before these were kept: what its last save owns counts as paid for.
    const paid = row.bought === null || row.ore === null ? paidFor(row.map) : null
    return { bought: row.bought ?? paid?.bought ?? 0, ore: row.ore ?? paid?.ore ?? 0 }
}

/** Buys `count` of a shop item: charges for it and trusts it as held (bought items may go to storage). */
export async function buySkyfarmItem(userId: string, item: string, count: number) {
    const price = PRICES.get(item)
    if (price === undefined) throw createError({ statusCode: 400, statusMessage: 'The shop doesn\'t sell that' })
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw createError({ statusCode: 400, statusMessage: 'Buy a whole number of them' })
    await db.transaction(async (tx) => {
        await lockIsland(tx, userId)
        await debit(userId, (price * count).toFixed(4), 'skyfarm:shop', tx)
        await tx.update(skyfarmIslands)
            .set({ trusted: sql`jsonb_set(coalesce(${skyfarmIslands.trusted}, '{}'::jsonb), ${`{${item}}`}::text[], to_jsonb(coalesce((${skyfarmIslands.trusted} ->> ${item})::numeric, 0) + ${count}))` })
            .where(eq(skyfarmIslands.userId, userId))
    })
    return { item, count, balance: await getBalance(userId) }
}

/** Buys the next cube of land at its price (each 1.2x the last); returns how many you have now bought. */
export async function buyLand(userId: string) {
    const bought = await db.transaction(async (tx) => {
        const row = await lockIsland(tx, userId)
        await debit(userId, chunkPrice(row.bought).toFixed(4), 'skyfarm:land', tx)
        await tx.update(skyfarmIslands).set({ bought: row.bought + 1 }).where(eq(skyfarmIslands.userId, userId))
        return row.bought + 1
    })
    return { bought, balance: await getBalance(userId) }
}

/** Buys the generator's next ore level. */
export async function upgradeGenerator(userId: string) {
    const ore = await db.transaction(async (tx) => {
        const row = await lockIsland(tx, userId)
        const next = ORE_LEVELS[row.ore + 1]
        if (!next) throw createError({ statusCode: 400, statusMessage: 'The generator is fully upgraded' })
        await debit(userId, next.price.toFixed(4), 'skyfarm:generator', tx)
        await tx.update(skyfarmIslands).set({ ore: row.ore + 1 }).where(eq(skyfarmIslands.userId, userId))
        return row.ore + 1
    })
    return { oreLevel: ore, balance: await getBalance(userId) }
}
