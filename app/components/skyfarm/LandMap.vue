<template>
    <div class="flex flex-col gap-2">
        <div class="relative h-80 w-full overflow-hidden rounded-md border border-default bg-black/30">
            <canvas ref="canvas" class="block size-full touch-none" />
            <div class="pointer-events-none absolute left-2 top-2 text-[11px] text-muted">
                Drag to turn, scroll to zoom, right-drag to move. Click a green cube to place a placeholder.
            </div>
        </div>
        <div class="flex min-h-9 items-center gap-3">
            <template v-if="picked">
                <span class="flex-1 text-sm">
                    Cube {{ picked.join(', ') }}
                    <span class="text-muted">({{ side(picked) }})</span>
                </span>
                <UButton size="sm" variant="ghost" color="neutral" label="Clear" @click="clearPick" />
                <UButton size="sm" icon="i-lucide-coins" :disabled="coins < price || busy" :loading="busy" :label="`Buy for ${formatNumber(price)}`" @click="buy" />
            </template>
            <span v-else class="text-sm text-muted">No placeholder placed.</span>
        </div>
    </div>
</template>

<script setup lang="ts">
import { LandMap, type Cube } from '~/utils/skyfarm/land-map'
import type { Island } from '~/utils/skyfarm/island'
import { STARTER_CUBE } from '~/utils/skyfarm/world'

const props = defineProps<{ island: Island, coins: number, price: number, player: { x: number, y: number, z: number } }>()
const emit = defineEmits<{ bought: [] }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const picked = ref<Cube | null>(null)
let map: LandMap | null = null

/** Where a cube lies from the one you started with, in words. */
function side([cx, cy, cz]: Cube) {
    const [sx, sy, sz] = STARTER_CUBE
    const parts = []
    if (cy !== sy) parts.push(cy > sy ? `${cy - sy} up` : `${sy - cy} down`)
    if (cz !== sz) parts.push(cz < sz ? `${sz - cz} north` : `${cz - sz} south`)
    if (cx !== sx) parts.push(cx > sx ? `${cx - sx} east` : `${sx - cx} west`)
    return parts.length ? `${parts.join(', ')} of the start` : 'the start'
}

function clearPick() {
    map?.pick(null)
}

const toast = useToast()
const { setBalance } = useAuth()
const busy = ref(false)

/** Pays for the cube in site coins on the server, then adds it (and the game saves at once, so paid land isn't lost). */
async function buy() {
    const c = picked.value
    if (!c || busy.value || !props.island.canBuyCube(...c)) return
    busy.value = true
    try {
        const res = await apiFetch<{ bought: number, balance: string }>('/api/skyfarm/land/buy', { method: 'POST' })
        props.island.addBoughtCube(...c, res.bought)
        setBalance(res.balance)
        picked.value = null
        map?.rebuild(props.player)
        emit('bought')
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not buy that land'), color: 'error' })
    } finally {
        busy.value = false
    }
}

onMounted(() => {
    map = new LandMap(canvas.value!, props.island.world, (cx, cy, cz) => props.island.canBuyCube(cx, cy, cz))
    map.onPick = (c) => {
        picked.value = c
    }
    map.rebuild(props.player)
})

onBeforeUnmount(() => {
    map?.dispose()
    map = null
})
</script>
