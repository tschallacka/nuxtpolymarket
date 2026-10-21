<template>
    <div class="flex flex-col gap-4">
        <p class="text-sm text-muted">
            What your store depots send in. Each save the server checks it against what your island could have made, and takes it into storage. From storage you sell it to the system or to other players, in site coins.
        </p>

        <!-- On its way: taken in by depots, not yet accepted -->
        <div v-if="pending.length">
            <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">On its way</h3>
            <div v-for="row in pending" :key="row.item" class="flex items-center gap-3 border-b border-default py-1.5">
                <div class="size-8 shrink-0"><SkyfarmSlot :stack="{ item: row.item, count: 1 }" /></div>
                <span class="flex-1 text-sm">{{ item(row.item).name }}</span>
                <span class="font-mono text-sm tabular-nums">{{ formatNumber(row.count) }}</span>
                <UButton size="xs" color="neutral" variant="soft" label="Take back 64" @click="takeBack(row.item)" />
            </div>
        </div>

        <!-- Storage, on the server -->
        <div>
            <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">In storage</h3>
            <div v-if="loading && !stored.length" class="py-4 text-center text-sm text-muted">Loading…</div>
            <div v-else-if="!stored.length" class="py-4 text-center text-sm text-muted">Nothing yet. Feed a Store Depot with hoppers, droppers or by hand.</div>
            <div v-for="row in stored" :key="row.item" class="flex flex-wrap items-center gap-2 border-b border-default py-1.5" :class="row.item === selected ? 'bg-primary/5' : ''">
                <div class="size-8 shrink-0"><SkyfarmSlot :stack="{ item: row.item, count: 1 }" /></div>
                <button type="button" class="flex-1 text-left text-sm hover:underline" @click="select(row.item)">{{ item(row.item).name }}</button>
                <span class="font-mono text-sm tabular-nums">{{ formatNumber(row.amount) }}</span>
                <UButton size="xs" color="neutral" variant="soft" label="Take 64" :loading="busy === `take:${row.item}`" @click="withdraw(row.item, Math.min(64, row.amount))" />
                <UButton v-if="row.systemPrice > 0" size="xs" icon="i-lucide-coins" :label="`Sell all ${formatNumber(row.systemPrice * row.amount, false)}`" :loading="busy === `sell:${row.item}`" @click="sellAll(row.item, row.amount)" />
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-chart-candlestick" title="Market" @click="select(row.item)" />
            </div>
        </div>

        <!-- One item's market -->
        <div v-if="book" class="rounded-md border border-default p-3">
            <div class="mb-2 flex items-center gap-2">
                <div class="size-7"><SkyfarmSlot :stack="{ item: book.item, count: 1 }" /></div>
                <h3 class="flex-1 text-sm font-semibold">{{ item(book.item).name }} market</h3>
                <span class="text-xs text-muted">System pays {{ formatNumber(book.systemPrice, false) }}</span>
            </div>
            <div class="grid grid-cols-2 gap-3 text-xs">
                <div>
                    <div class="mb-1 font-semibold text-success">Buying</div>
                    <div v-if="!book.bids.length" class="text-muted">No buyers</div>
                    <div v-for="b in book.bids.slice(0, 6)" :key="`b${b.price}`" class="flex justify-between font-mono tabular-nums">
                        <span>{{ formatNumber(b.price, false) }}</span><span class="text-muted">× {{ formatNumber(b.quantity) }}</span>
                    </div>
                </div>
                <div>
                    <div class="mb-1 font-semibold text-error">Selling</div>
                    <div v-if="!book.asks.length" class="text-muted">No sellers</div>
                    <div v-for="a in book.asks.slice(0, 6)" :key="`a${a.price}`" class="flex justify-between font-mono tabular-nums">
                        <span>{{ formatNumber(a.price, false) }}</span><span class="text-muted">× {{ formatNumber(a.quantity) }}</span>
                    </div>
                </div>
            </div>
            <div class="mt-3 flex flex-wrap items-end gap-2">
                <USelect v-model="side" :items="[{ label: 'Sell', value: 'sell' }, { label: 'Buy', value: 'buy' }]" size="sm" class="w-24" />
                <UInput v-model="price" size="sm" type="number" step="0.0001" min="0" placeholder="Price each" class="w-32" />
                <UInput v-model="quantity" size="sm" type="number" step="1" min="1" placeholder="How many" class="w-28" />
                <UButton size="sm" :label="side === 'sell' ? 'Place sell order' : 'Place buy order'" :loading="busy === 'place'" :disabled="!validOrder" @click="place" />
            </div>
            <p v-if="validOrder" class="mt-1 text-xs text-muted">
                {{ side === 'buy' ? 'Holds' : 'Brings' }} {{ formatNumber(orderTotal(Number(price), Number(quantity)), false) }} site coins.
            </p>
        </div>

        <!-- Your open orders -->
        <div v-if="orders.length">
            <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Your orders</h3>
            <div v-for="o in orders" :key="o.id" class="flex items-center gap-2 border-b border-default py-1.5 text-sm">
                <UBadge :color="o.side === 'buy' ? 'success' : 'error'" variant="soft" size="sm">{{ o.side === 'buy' ? 'Buy' : 'Sell' }}</UBadge>
                <span class="flex-1">{{ item(o.item).name }}</span>
                <span class="font-mono text-xs tabular-nums">{{ formatNumber(o.quantity - o.filled) }} × {{ formatNumber(o.price, false) }}</span>
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" title="Cancel" :loading="busy === `cancel:${o.id}`" @click="cancel(o.id)" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { INVENTORY_SLOTS, type Island } from '~/utils/skyfarm/island'
import { item, Slots } from '~/utils/skyfarm/items'
import { isValidPrice, isValidQuantity, orderTotal } from '~/utils/skyfarm/market'

/*
 * Storage and the market (the shop's Storage tab). Storage is on the server:
 * what the depots took in waits on the island ("on its way") until a save
 * gets it accepted. Selling and trading are in site coins, so they go through
 * the server and refresh your balance.
 */

/** `version`: the game's change counter (redraws what is on its way); `accepted`: bumps when a save got something into storage. */
const props = defineProps<{ island: Island, version: number, accepted: number }>()
const emit = defineEmits<{ changed: [] }>()

interface Stored { item: string, amount: number, systemPrice: number }
interface Order { id: string, item: string, side: 'buy' | 'sell', price: number, quantity: number, filled: number }
interface Book { item: string, systemPrice: number, bids: { price: number, quantity: number }[], asks: { price: number, quantity: number }[] }

const toast = useToast()
const { fetchSession } = useAuth()
const stored = ref<Stored[]>([])
const orders = ref<Order[]>([])
const loading = ref(true)
const busy = ref('')
const selected = ref<string | null>(null)
const book = ref<Book | null>(null)
const side = ref<'buy' | 'sell'>('sell')
const price = ref('')
const quantity = ref('')

const pending = computed(() => {
    void props.version
    return [...props.island.store].map(([key, count]) => ({ item: key, count })).sort((a, b) => b.count - a.count)
})

const validOrder = computed(() => isValidPrice(Number(price.value)) && isValidQuantity(Number(quantity.value)))

async function refresh() {
    try {
        const data = await apiFetch<{ items: Stored[], orders: Order[] }>('/api/skyfarm/storage')
        stored.value = data.items
        orders.value = data.orders
        if (selected.value) book.value = await apiFetch<Book>(`/api/skyfarm/market/${selected.value}`)
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not load your storage'), color: 'error' })
    } finally {
        loading.value = false
    }
}

/** Runs a storage or market action, then shows the new state (and the new site coin balance). */
async function act(key: string, run: () => Promise<unknown>, fallback: string) {
    if (busy.value) return
    busy.value = key
    try {
        await run()
        await Promise.all([refresh(), fetchSession()])
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, fallback), color: 'error' })
    } finally {
        busy.value = ''
    }
}

async function select(key: string) {
    selected.value = key
    const row = stored.value.find(r => r.item === key)
    price.value = row?.systemPrice ? String(row.systemPrice) : ''
    quantity.value = row ? String(row.amount) : ''
    side.value = 'sell'
    try {
        book.value = await apiFetch<Book>(`/api/skyfarm/market/${key}`)
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not load that market'), color: 'error' })
    }
}

function withdraw(key: string, n: number) {
    // Only what fits in the inventory comes out (tried on a copy of it).
    const take = n - new Slots(INVENTORY_SLOTS, props.island.inventory.slots).add(key, n)
    if (take <= 0) {
        toast.add({ title: 'No room in your inventory', color: 'warning' })
        return
    }
    return act(`take:${key}`, async () => {
        await apiFetch('/api/skyfarm/storage/withdraw', { method: 'POST', body: { item: key, quantity: take } })
        props.island.inventory.add(key, take)
        emit('changed')
    }, 'Could not take that out')
}

function sellAll(key: string, n: number) {
    return act(`sell:${key}`, () => apiFetch('/api/skyfarm/storage/sell', { method: 'POST', body: { item: key, quantity: n } }), 'Could not sell that')
}

function place() {
    const key = selected.value
    if (!key || !validOrder.value) return
    return act('place', () => apiFetch('/api/skyfarm/market/place', { method: 'POST', body: { item: key, side: side.value, price: Number(price.value), quantity: Number(quantity.value) } }), 'Could not place that order')
}

function cancel(id: string) {
    return act(`cancel:${id}`, () => apiFetch('/api/skyfarm/market/cancel', { method: 'POST', body: { orderId: id } }), 'Could not cancel that order')
}

function takeBack(key: string) {
    if (props.island.withdraw(key, 64) === 0) toast.add({ title: 'No room in your inventory', color: 'warning' })
    emit('changed')
}

// Storage changes when a save gets something accepted: show it again then.
watch(() => props.accepted, () => void refresh())
onMounted(refresh)
</script>
