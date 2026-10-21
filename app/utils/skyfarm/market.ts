import { itemId } from '#shared/utils/skyfarm/item-ids'
import { SELL } from './economy'

/*
 * The Skyfarm market's rules, shared by the server and the screen: what the
 * system pays for an item, and what makes an order valid. Trading is in site
 * coins (your balance), as Polytown's market is: buy orders hold their coins
 * and sell orders their items until they fill or are cancelled. Selling to the
 * system fills players' standing buy orders at or above its price first.
 */

/** Site coins the system pays per coin of an item's sell value (economy.ts): one for one (Q57). */
export const SYSTEM_RATE = 1
export const MARKET_MIN_PRICE = 0.0001
export const MARKET_MAX_PRICE = 1_000_000_000
export const MARKET_MAX_QUANTITY = 1_000_000
export const MARKET_MAX_OPEN_ORDERS = 20

const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** What the system pays for one, in site coins (0: it doesn't buy this). */
export function systemPrice(item: string): number {
    return round4((SELL[item] ?? 0) * SYSTEM_RATE)
}

/** Whether an item can be stored and traded: everything with a save id. */
export const isMarketItem = (item: string) => itemId(item) > 0

export const isValidPrice = (p: number) => Number.isFinite(p) && p >= MARKET_MIN_PRICE && p <= MARKET_MAX_PRICE
    && Math.abs(p * 10_000 - Math.round(p * 10_000)) < 1e-6

export const isValidQuantity = (q: number) => Number.isInteger(q) && q >= 1 && q <= MARKET_MAX_QUANTITY

/** What `quantity` cost at `price`, in site coins, to four decimals. */
export function orderTotal(price: number, quantity: number): number {
    return Math.round(price * 10_000) * quantity / 10_000
}
