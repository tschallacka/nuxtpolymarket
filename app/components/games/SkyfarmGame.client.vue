<template>
    <div class="relative h-screen w-full select-none overflow-hidden bg-black font-sans text-white">
        <div ref="viewport" class="absolute inset-0" />

        <!-- Loading -->
        <div v-if="phase === 'loading'" class="absolute inset-0 flex items-center justify-center bg-elevated">
            <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-muted" />
        </div>

        <template v-if="phase === 'playing'">
            <!-- Crosshair and mining progress -->
            <div v-if="hud.locked" class="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div class="relative size-5">
                    <span class="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-white/80 mix-blend-difference" />
                    <span class="absolute left-0 top-1/2 h-0.5 w-full -translate-y-1/2 bg-white/80 mix-blend-difference" />
                </div>
                <div v-if="hud.mining > 0" class="absolute left-1/2 top-1/2 mt-6 h-1 w-16 -translate-x-1/2 overflow-hidden rounded bg-black/40">
                    <div class="h-full bg-white" :style="{ width: Math.min(100, hud.mining * 100) + '%' }" />
                </div>
            </div>

            <!-- Top bar -->
            <div class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
                <div class="pointer-events-auto flex items-center gap-2">
                    <UButton to="/" icon="i-lucide-arrow-left" color="neutral" variant="soft" size="sm" />
                    <span class="rounded bg-black/50 px-2 py-1 text-sm font-semibold">Skyfarm</span>
                    <UButton
                        :icon="muted ? 'i-lucide-volume-x' : 'i-lucide-volume-2'"
                        color="neutral"
                        variant="soft"
                        size="sm"
                        :aria-label="muted ? 'Unmute' : 'Mute'"
                        @click="toggleMute"
                    />
                </div>
                <div class="flex flex-col items-end gap-1">
                    <span class="rounded bg-black/50 px-3 py-1 font-mono text-lg font-bold tabular-nums">
                        <UIcon name="i-lucide-coins" class="mr-1 size-4 align-[-2px] text-warning" />{{ formatNumber(balanceNum) }}
                    </span>
                    <span v-if="devMode" class="rounded bg-black/40 px-2 py-0.5 font-mono text-xs tabular-nums text-white/80" title="Frames a second, and the ms of work each frame takes">
                        {{ Math.round(hud.fps) }} fps · {{ hud.frameWork.toFixed(1) }} ms
                    </span>
                    <span v-if="hud.target && hud.locked" class="rounded bg-black/40 px-2 py-0.5 text-xs text-white/80">{{ hud.target }}</span>
                    <span v-if="saveState" class="rounded bg-black/40 px-2 py-0.5 text-xs text-white/60">{{ saveState }}</span>
                    <span v-for="e in hud.effects" :key="e.name" class="flex items-center gap-1.5 rounded bg-black/50 px-2 py-0.5 text-xs">
                        <img :src="hudSprite(`effect_${e.name}`)" alt="" class="sf-pixel size-4">
                        {{ EFFECT_NAMES[e.name] }} {{ clockText(e.seconds) }}
                    </span>
                </div>
            </div>

            <!-- Hotbar, with your hearts over its left end and air bubbles over its right -->
            <div class="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-1">
                <span v-if="hud.hotbar[hud.selected]" class="rounded bg-black/40 px-2 py-0.5 text-xs">{{ item(hud.hotbar[hud.selected]!.item).name }}</span>
                <div v-if="armorIcons.length" class="flex w-[29.5rem] max-w-full px-1">
                    <img v-for="(a, i) in armorIcons" :key="i" :src="hudSprite(a)" alt="" class="sf-pixel size-[18px]">
                </div>
                <div class="flex w-[29.5rem] max-w-full items-end justify-between px-1">
                    <div class="flex" :class="{ 'sf-low': hud.health <= 4 && !hud.dead }">
                        <span v-for="(h, i) in hearts" :key="i" class="sf-heart relative size-[18px]" :style="{ '--i': i }">
                            <img :src="hudSprite(`heart_${h.container}`)" alt="" class="sf-pixel absolute inset-0 size-full">
                            <img v-if="h.kind" :src="hudSprite(`heart_${h.kind}${h.blink ? '_blinking' : ''}`)" alt="" class="sf-pixel absolute inset-0 size-full">
                        </span>
                    </div>
                    <div class="flex flex-row-reverse">
                        <img v-for="(b, i) in bubbles" :key="i" :src="hudSprite(b)" alt="" class="sf-pixel size-[18px]">
                    </div>
                </div>
                <div class="flex gap-1 rounded-md bg-black/50 p-1">
                    <div
                        v-for="(s, i) in hud.hotbar"
                        :key="i"
                        class="relative size-12 rounded border-2"
                        :class="i === hud.selected ? 'border-white' : 'border-white/15'"
                    >
                        <SkyfarmSlot :stack="s" />
                        <span class="absolute left-1 top-0.5 text-[10px] text-white/50">{{ i + 1 }}</span>
                    </div>
                </div>
            </div>

            <!-- Died: red, and a way back to the spawn point (what you carried stays with you). -->
            <div v-if="hud.dead" class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-red-900/60">
                <h2 class="text-4xl font-bold drop-shadow">You died!</h2>
                <p class="text-sm text-white/80">You keep everything you carried.</p>
                <UButton size="lg" label="Respawn" icon="i-lucide-rotate-ccw" @click="respawn" />
            </div>

            <!-- Just closed a screen with Escape: still playing, one click takes the mouse back. -->
            <div v-if="!hud.locked && !panel && !away && continuing && !hud.dead" class="absolute inset-0 flex items-center justify-center" @click="resume">
                <span class="pointer-events-none mt-16 rounded bg-black/50 px-3 py-1 text-sm text-white/90">Click to continue</span>
            </div>

            <!-- Click to play: the pause screen, when Escape had nothing to close -->
            <div v-if="!hud.locked && !panel && !continuing && !hud.dead" class="absolute inset-0 flex items-center justify-center bg-black/45" @click="resume">
                <div class="max-w-md rounded-lg bg-elevated/95 p-6 text-center text-default shadow-xl">
                    <h2 class="text-2xl font-bold">Skyfarm</h2>
                    <p class="mt-2 text-sm text-muted">Build a cobblestone generator, automate your farms, sell everything.</p>
                    <div class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-left text-xs text-muted">
                        <span><kbd>WASD</kbd> move, <kbd>Space</kbd> jump</span>
                        <span><kbd>Shift</kbd> sneak, <kbd>W</kbd><kbd>W</kbd> sprint</span>
                        <span><kbd>Left</kbd> mine / attack</span>
                        <span><kbd>Right</kbd> place / open / bucket</span>
                        <span><kbd>1-9</kbd> or wheel: hotbar</span>
                        <span><kbd>E</kbd> inventory, <kbd>B</kbd> shop</span>
                    </div>
                    <UButton class="mt-5" size="lg" label="Play" icon="i-lucide-play" @click.stop="resume" />
                    <div class="mt-3">
                        <UButton
                            v-if="!confirmingReset"
                            size="xs"
                            color="error"
                            variant="link"
                            icon="i-lucide-rotate-ccw"
                            label="Reset island"
                            @click.stop="confirmingReset = true"
                        />
                        <div v-else class="rounded-md border border-error/40 bg-error/10 p-3 text-sm" @click.stop>
                            <p class="font-semibold text-error">Start over on a new island?</p>
                            <p class="mt-1 text-xs text-muted">Your island, inventory, chests, coins and upgrades are gone for good.</p>
                            <div class="mt-3 flex justify-center gap-2">
                                <UButton size="sm" color="neutral" variant="soft" label="Keep my island" :disabled="resetting" @click="confirmingReset = false" />
                                <UButton size="sm" color="error" label="Reset island" icon="i-lucide-rotate-ccw" :loading="resetting" @click="resetIsland" />
                            </div>
                        </div>
                    </div>
                    <p class="mt-4 text-[10px] text-dimmed">
                        Textures: Pixel Perfection by XSSheep, continued by Nova_Wostra,
                        <a class="underline" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener" @click.stop>CC BY-SA 4.0</a>
                    </p>
                </div>
            </div>

            <!-- Panels -->
            <div v-if="panel" class="absolute inset-0 flex items-center justify-center bg-black/55 p-4" @click.self="closePanel">
                <div class="max-h-full w-full max-w-3xl overflow-y-auto rounded-lg bg-elevated p-5 text-default shadow-xl">
                    <div class="mb-4 flex items-center justify-between">
                        <h2 class="text-lg font-bold">{{ panelTitle }}</h2>
                        <div class="flex items-center gap-2">
                            <UButton v-if="panel.kind !== 'shop'" size="sm" color="neutral" variant="soft" icon="i-lucide-store" label="Shop" @click="panel = { kind: 'shop' }" />
                            <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" @click="closePanel" />
                        </div>
                    </div>

                    <!-- Store depot: what goes in here goes to the store -->
                    <template v-if="panel.kind === 'depot'">
                        <p class="mb-2 text-xs text-muted">Anything put in here (or fed in by a hopper or dropper) goes to your storage, where you can sell it on the market. Find it under Storage in the shop.</p>
                        <SkyfarmGrid :slots="view(depotSlots.slots)" :cols="9" :marked="marksIn('depot')" @press="(i, c) => pressSlot('depot', i, c)" @enter="i => enterSlot('depot', i)" />
                        <p class="mt-2 text-xs text-muted">{{ pendingCount }} kinds of item on their way to storage.</p>
                        <div class="mt-4" />
                    </template>

                    <!-- Container -->
                    <template v-if="panel.kind === 'container' && container">
                        <SkyfarmGrid :slots="view(container.slots)" :cols="panel.cols ?? 9" :marked="marksIn('container')" @press="(i, c) => pressSlot('container', i, c)" @enter="i => enterSlot('container', i)" />
                        <div class="mt-4" />
                    </template>

                    <!-- Furnace: what smelts over the fuel, the result to the right -->
                    <div v-if="panel.kind === 'furnace' && container" class="mb-4 flex items-center justify-center gap-5">
                        <div class="flex flex-col items-center gap-1">
                            <SkyfarmGrid :slots="view(container.slots.slice(FURNACE_INPUT, FURNACE_INPUT + 1))" :cols="1" :marked="marksIn('container', FURNACE_INPUT, FURNACE_INPUT + 1)" @press="(_, c) => pressSlot('container', FURNACE_INPUT, c)" @enter="() => enterSlot('container', FURNACE_INPUT)" />
                            <div class="relative size-7" title="Fuel burning">
                                <UIcon name="i-lucide-flame" class="absolute inset-0 size-7 text-muted/40" />
                                <UIcon name="i-lucide-flame" class="absolute inset-0 size-7 text-orange-400" :style="{ clipPath: `inset(${(1 - furnaceGauge.flame) * 100}% 0 0 0)` }" />
                            </div>
                            <SkyfarmGrid :slots="view(container.slots.slice(FURNACE_FUEL, FURNACE_FUEL + 1))" :cols="1" :marked="marksIn('container', FURNACE_FUEL, FURNACE_FUEL + 1)" @press="(_, c) => pressSlot('container', FURNACE_FUEL, c)" @enter="() => enterSlot('container', FURNACE_FUEL)" />
                        </div>
                        <div class="h-2 w-16 overflow-hidden rounded bg-muted/40" title="Smelting">
                            <div class="h-full bg-default" :style="{ width: `${furnaceGauge.cook * 100}%` }" />
                        </div>
                        <SkyfarmGrid :slots="view(container.slots.slice(FURNACE_OUTPUT, FURNACE_OUTPUT + 1))" :cols="1" :marked="[]" @press="(_, c) => pressSlot('container', FURNACE_OUTPUT, c)" />
                    </div>

                    <!-- Trading: what the villager offers, at its prices for you -->
                    <div v-if="panel.kind === 'trading' && trader" class="mb-4">
                        <div class="mb-3 flex items-center gap-3">
                            <div class="h-1.5 flex-1 overflow-hidden rounded bg-muted/40" :title="`${trader.xp} experience`">
                                <div class="h-full bg-success" :style="{ width: `${traderProgress * 100}%` }" />
                            </div>
                            <span class="text-xs text-muted">{{ trader.level >= 5 ? 'Master' : `Next: ${LEVEL_NAMES[trader.level]}` }}</span>
                        </div>
                        <div class="flex flex-col gap-1">
                            <button
                                v-for="(o, i) in offers"
                                :key="i"
                                type="button"
                                class="flex items-center gap-2 rounded border border-default bg-black/20 p-1 text-left hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-50"
                                :disabled="o.soldOut || !o.afford"
                                :title="o.soldOut ? 'Out of stock until it restocks at its workstation' : 'Click to trade once, Shift-click to trade as often as you can'"
                                @click="e => tradeOffer(i, e.shiftKey)"
                            >
                                <div class="relative size-10 shrink-0"><SkyfarmSlot :stack="o.a" /></div>
                                <span v-if="o.was" class="text-xs text-error line-through">{{ o.was }}</span>
                                <template v-if="o.b">
                                    <span class="text-muted">+</span>
                                    <div class="size-10 shrink-0"><SkyfarmSlot :stack="o.b" /></div>
                                </template>
                                <UIcon :name="o.soldOut ? 'i-lucide-x' : 'i-lucide-arrow-right'" class="size-5" :class="o.soldOut ? 'text-error' : 'text-muted'" />
                                <div class="size-10 shrink-0"><SkyfarmSlot :stack="o.out" /></div>
                                <span class="ml-auto pr-2 text-xs text-muted">{{ item(o.out.item).name }}</span>
                            </button>
                        </div>
                    </div>

                    <!-- Stonecutter: a block in, then pick what to cut it into -->
                    <div v-if="panel.kind === 'stonecutter'" class="mb-4 flex items-center justify-center gap-5">
                        <SkyfarmGrid :slots="view(cutSlots.slots)" :cols="1" :marked="marksIn('cut')" @press="(i, c) => pressSlot('cut', i, c)" @enter="i => enterSlot('cut', i)" />
                        <UIcon name="i-lucide-arrow-right" class="size-6 text-muted" />
                        <div class="flex min-h-14 gap-1">
                            <button
                                v-for="c in cuts"
                                :key="c.item"
                                type="button"
                                class="size-14 rounded border-2 border-default bg-black/30 hover:bg-black/15"
                                :title="item(c.item).name"
                                @click="e => takeCut(c.item, e.shiftKey)"
                            >
                                <SkyfarmSlot :stack="c" />
                            </button>
                            <span v-if="!cuts.length" class="self-center text-xs text-muted">Put stone, cobblestone or stone bricks in to cut them.</span>
                        </div>
                    </div>

                    <!-- Crafting: 2x2 in the inventory, 3x3 at a crafting table -->
                    <div v-if="panel.kind === 'inventory' || panel.kind === 'crafting'" class="mb-4 flex items-center gap-4">
                        <!-- What you wear: helmet, chestplate, leggings, boots -->
                        <SkyfarmGrid v-if="panel.kind === 'inventory'" :slots="view(island!.armor.slots)" :cols="1" :marked="[]" class="mr-4" title="Armour" @press="(i, c) => pressSlot('armor', i, c)" />
                        <SkyfarmGrid :slots="view(craftSlots.slots)" :cols="craftSize" :marked="marksIn('craft')" @press="(i, c) => pressSlot('craft', i, c)" @enter="i => enterSlot('craft', i)" />
                        <UIcon name="i-lucide-arrow-right" class="size-6 text-muted" />
                        <button
                            type="button"
                            class="size-14 rounded border-2 border-default bg-black/30 hover:bg-black/15"
                            :title="craftResult ? item(craftResult.item).name : ''"
                            @click="e => clickResult(e.shiftKey)"
                        >
                            <SkyfarmSlot :stack="craftResult" />
                        </button>
                    </div>

                    <!-- Inventory (under a container or crafting grid; on its own for E) -->
                    <template v-if="panel.kind !== 'shop'">
                        <SkyfarmGrid :slots="view(island!.inventory.slots.slice(HOTBAR))" :cols="9" :marked="marksIn('inventory', HOTBAR)" @press="(i, c) => pressSlot('inventory', i + HOTBAR, c)" @enter="i => enterSlot('inventory', i + HOTBAR)" />
                        <div class="mt-2" />
                        <SkyfarmGrid :slots="view(island!.inventory.slots.slice(0, HOTBAR))" :cols="9" :marked="marksIn('inventory', 0, HOTBAR)" @press="(i, c) => pressSlot('inventory', i, c)" @enter="i => enterSlot('inventory', i)" />
                        <p class="mt-2 text-xs text-muted">Left click picks up or puts down a stack, right click splits or places one, Shift-click moves it across. The bottom row is your hotbar.</p>
                    </template>

                    <!-- Shop -->
                    <template v-if="panel.kind === 'shop'">
                        <UTabs v-model="shopTab" :items="shopTabs" class="mb-4" :content="false" />

                        <div v-if="shopTab === 'buy'">
                            <div v-for="(rows, section) in SHOP" :key="section" class="mb-4">
                                <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{{ section }}</h3>
                                <div v-for="row in rows" :key="row.item" class="flex items-center gap-3 border-b border-default py-2">
                                    <div class="size-9 shrink-0"><SkyfarmSlot :stack="{ item: row.item, count: 1 }" /></div>
                                    <div class="flex-1">
                                        <div class="text-sm">{{ item(row.item).name }}</div>
                                        <div class="text-xs text-muted">{{ row.hint }}</div>
                                    </div>
                                    <UButton size="xs" :disabled="coins < row.price || buying === row.item" :loading="buying === row.item" :label="formatNumber(row.price)" icon="i-lucide-coins" @click="buy(row.item)" />
                                </div>
                            </div>
                        </div>

                        <div v-else-if="shopTab === 'land'">
                            <p class="mb-3 text-sm text-muted">
                                Your island is built from 16×16×16 cubes. Buy one next to any side of a cube you own, above and below too. The next costs <strong class="text-default">{{ formatNumber(nextChunkPrice) }}</strong>, and each one after costs 1.2× more.
                            </p>
                            <SkyfarmLandMap v-if="island" :island="island" :coins="coins" :price="nextChunkPrice" :player="playerAt()" @bought="landBought" />
                        </div>

                        <div v-else-if="shopTab === 'store'">
                            <SkyfarmStoragePanel v-if="island" :island="island" :version="version" :accepted="storageAccepted" @changed="touch()" />
                        </div>

                        <div v-else-if="shopTab === 'generator'">
                            <p class="mb-3 text-sm text-muted">Upgrades make your cobblestone generators sometimes produce ore instead.</p>
                            <div v-for="(lvl, i) in ORE_LEVELS" :key="i" class="flex items-center gap-3 border-b border-default py-2" :class="i <= oreLevel ? 'opacity-60' : ''">
                                <span class="w-16 text-sm font-semibold">Level {{ i }}</span>
                                <span class="flex-1 text-xs text-muted">{{ oreLine(lvl) }}</span>
                                <UBadge v-if="i <= oreLevel" color="success" variant="soft" label="Owned" />
                                <UButton v-else-if="i === oreLevel + 1" size="xs" :disabled="coins < lvl.price || buying === 'generator'" :loading="buying === 'generator'" :label="formatNumber(lvl.price)" icon="i-lucide-coins" @click="upgradeOres" />
                                <span v-else class="text-xs text-muted">{{ formatNumber(lvl.price) }}</span>
                            </div>
                        </div>
                    </template>
                </div>
            </div>

            <!-- The stack you are carrying follows the mouse. -->
            <div
                v-if="panel && cursorView"
                class="pointer-events-none fixed z-50 size-11 -translate-x-1/2 -translate-y-1/2"
                :style="{ left: mouse.x + 'px', top: mouse.y + 'px' }"
            >
                <SkyfarmSlot :stack="cursorView" />
            </div>

            <!-- Time away -->
            <div v-if="away" class="absolute inset-0 flex items-center justify-center bg-black/55 p-4">
                <div class="w-full max-w-sm rounded-lg bg-elevated p-5 text-default shadow-xl">
                    <h2 class="text-lg font-bold">While you were away</h2>
                    <p class="mt-1 text-sm text-muted">{{ awayDuration }}</p>
                    <div v-for="(n, key) in away.items" :key="key" class="mt-1 text-sm">
                        +{{ formatNumber(n) }} {{ item(String(key)).name }}
                    </div>
                    <UButton class="mt-4" block label="Back to the island" @click="away = null" />
                </div>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { fetchIsland, saveIsland } from '~/utils/skyfarm/save-file'
import { ORE_LEVELS, SHOP } from '~/utils/skyfarm/economy'
import { cookProgress, FUEL, FURNACE_FUEL, FURNACE_INPUT, FURNACE_OUTPUT, smeltResult } from '~/utils/skyfarm/furnace'
import { AIR, SkyfarmEngine, type SkyfarmHud, type SkyfarmPanel } from '~/utils/skyfarm/engine'
import { HOTBAR, INVENTORY_SLOTS, Island, MAX_HEALTH, type AwayReport } from '~/utils/skyfarm/island'
import type { SlotClick } from '~/components/skyfarm/Grid.vue'
import { craft, STONECUTTING } from '~/utils/skyfarm/crafting'
import { LEVEL_NAMES, LEVEL_XP, priceOf } from '~/utils/skyfarm/trades'
import { canDragInto, clickSlot, craftAll, dragSplit, takeResult } from '~/utils/skyfarm/cursor'
import { ARMOR_SLOTS, item, Slots } from '~/utils/skyfarm/items'
import { loadBlockPack, type BlockPack } from '~/utils/skyfarm/pack'
import { SkyfarmSounds } from '~/utils/skyfarm/sounds'

const AUTOSAVE_MS = 30_000

const toast = useToast()
const viewport = ref<HTMLElement | null>(null)
const phase = ref<'loading' | 'playing'>('loading')
const hud = reactive<SkyfarmHud>({ locked: false, coins: 0, selected: 0, hotbar: [], target: null, mining: 0, inWater: false, health: MAX_HEALTH, armor: 0, hurt: false, air: AIR, dead: false, effects: [], fps: 0, frameWork: 0 })
/** Development only: the frame rate display (and creative flight, in the engine). */
const devMode = import.meta.dev

/** The armour bar: ten icons, full, half or empty, shown only while you wear something. */
const armorIcons = computed(() => (hud.armor > 0 ? Array.from({ length: 10 }, (_, i) => (hud.armor - i * 2 >= 2 ? 'armor_full' : hud.armor - i * 2 === 1 ? 'armor_half' : 'armor_empty')) : []))

/** The ten hearts, Minecraft's way: full, half or empty (health rounds up), blinking just after a hit, green while poisoned. */
const hearts = computed(() => Array.from({ length: MAX_HEALTH / 2 }, (_, i) => {
    const left = Math.ceil(hud.health) - i * 2
    const poisoned = hud.effects.some(e => e.name === 'poison') ? 'poisoned_' : ''
    const kind = left >= 2 ? `${poisoned}full` : left === 1 ? `${poisoned}half` : null
    return { kind, container: hud.hurt ? 'container_blinking' : 'container', blink: hud.hurt && !!kind }
}))

const EFFECT_NAMES = { poison: 'Poison', slowness: 'Slowness', weakness: 'Weakness', regeneration: 'Regeneration' } as const
const clockText = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Air bubbles while you are under water: one popping as it runs out. */
const bubbles = computed(() => {
    if (hud.air >= AIR) return []
    const full = Math.max(0, Math.ceil(((hud.air - 2) * 10) / AIR))
    const popping = Math.max(0, Math.ceil((hud.air * 10) / AIR) - full)
    return [...Array(full).fill('air'), ...Array(popping).fill('air_bursting')] as string[]
})

const hudSprite = (name: string) => `${pack.value?.base ?? ''}/gui/${name}.png`

function respawn() {
    engine?.respawn()
}
const panel = ref<SkyfarmPanel | null>(null)
const away = ref<AwayReport | null>(null)
const shopTab = ref('buy')
/** Everything is bought with your site coins (your balance). */
const { balanceNum, setBalance } = useAuth()
/** What is being bought right now (an item key, 'generator'): its button waits. */
const buying = ref('')
const saveState = ref('')
/** Bumped after anything in a panel changes the island, so the panel re-reads it. */
const version = ref(0)

// Not reactive on purpose (it changes 20 times a second); panels re-read it through `version`.
let island = null as Island | null
let engine: SkyfarmEngine | null = null
let revision = 0
/** The column files the server holds (by hash): a save leaves those out. */
let storedColumns = new Set<string>()
let saving = false
let blocked = false
let timer: ReturnType<typeof setInterval> | null = null
/** The block pack, for the slots' icons. */
const pack = shallowRef<BlockPack | null>(null)
provide('skyfarmPack', pack)
let sounds: SkyfarmSounds | null = null
const muted = ref(false)

function toggleMute() {
    muted.value = !muted.value
    sounds?.setMuted(muted.value)
}

// Closing a chest's screen, however it closes, shuts the lid.
watch(panel, (now, before) => {
    if (before?.kind === 'container' && now?.kind !== 'container') sounds?.play('chestClose', 23)
})

/** Bumps each time a save gets something into storage (the Storage tab reloads then). */
const storageAccepted = ref(0)
/** How many kinds of item the depots took in that storage hasn't accepted yet (the depot panel's note). */
const pendingCount = computed(() => (version.value, island?.store.size ?? 0))

/** The depot's slots: whatever lands in them is sent to the store at once. */
const depotSlots = new Slots(9)
function flushDepot() {
    if (!island) return
    for (let i = 0; i < depotSlots.slots.length; i++) {
        const s = depotSlots.slots[i]
        if (!s) continue
        island.deposit(s.item, s.count)
        depotSlots.slots[i] = null
    }
}

const shopTabs = [
    { label: 'Buy', value: 'buy', icon: 'i-lucide-shopping-cart' },
    { label: 'Storage', value: 'store', icon: 'i-lucide-warehouse' },
    { label: 'Land', value: 'land', icon: 'i-lucide-map' },
    { label: 'Generator', value: 'generator', icon: 'i-lucide-pickaxe' }
]

const touch = () => {
    // Whatever was put in the depot's slots has gone to the store.
    if (panel.value?.kind === 'depot') flushDepot()
    version.value++
}

/** A plain copy of some slots, so the template tracks `version` rather than the island's internals. */
function view(slots: (ItemStack | null)[]) {
    void version.value
    return slots.map(s => (s ? { ...s } : null))
}

const coins = computed(() => balanceNum.value)
const oreLevel = computed(() => (version.value, island?.oreLevel ?? 0))
const nextChunkPrice = computed(() => (version.value, island?.nextChunkPrice ?? 0))

const container = computed(() => {
    void version.value
    const p = panel.value
    if (!island) return null
    if (p?.kind === 'container') return island.containerAt(p.x, p.y, p.z)
    if (p?.kind === 'furnace') return island.furnace(p.x, p.y, p.z)?.box ?? null
    return null
})

/** The open furnace's fire (0..1 of the fuel left) and smelting progress (0..1). */
const furnaceGauge = computed(() => {
    void version.value
    const p = panel.value
    const it = p?.kind === 'furnace' ? island?.furnace(p.x, p.y, p.z) : null
    if (!it) return { flame: 0, cook: 0 }
    const f = it.state
    return { flame: f.burnMax ? f.burn / f.burnMax : 0, cook: cookProgress(f, it.kind) }
})

// A furnace works while you watch it: its slots and gauges re-read four times a second.
let furnaceTimer: ReturnType<typeof setInterval> | null = null
watch(panel, (now) => {
    if (furnaceTimer) clearInterval(furnaceTimer)
    furnaceTimer = now?.kind === 'furnace' ? setInterval(touch, 250) : null
})
onBeforeUnmount(() => {
    if (furnaceTimer) clearInterval(furnaceTimer)
})

const panelTitle = computed(() => {
    const p = panel.value
    if (!p) return ''
    if (p.kind === 'shop') return 'Shop'
    if (p.kind === 'inventory') return 'Inventory'
    if (p.kind === 'crafting') return 'Crafting Table'
    if (p.kind === 'furnace') return p.name
    if (p.kind === 'stonecutter') return 'Stonecutter'
    if (p.kind === 'depot') return 'Store Depot'
    if (p.kind === 'trading') {
        const m = trader.value
        const prof = m?.profession ?? ''
        return m ? `${LEVEL_NAMES[m.level - 1]} ${prof[0]?.toUpperCase() ?? ''}${prof.slice(1)}` : 'Villager'
    }
    return p.name ?? (p.sell ? 'Sell Chest' : 'Chest')
})

/** The villager you are trading with, and its offers as the screen shows them. */
const trader = computed(() => {
    void version.value
    const p = panel.value
    return p?.kind === 'trading' && island ? island.mobs.list.find(m => m.id === p.mob && !m.dead) ?? null : null
})
const offers = computed(() => {
    void version.value
    const m = trader.value
    if (!m || !island) return []
    return m.offers.map((o) => {
        const price = priceOf(o, m.reputation)
        const out = o.uses >= o.max
        const afford = island!.inventory.count(price.item) >= price.count + (o.b?.item === price.item ? o.b.count : 0) && (!o.b || island!.inventory.count(o.b.item) >= o.b.count)
        return { a: price, was: price.count < o.a.count ? o.a.count : null, b: o.b ?? null, out: o.out, soldOut: out, afford }
    })
})
/** Progress through the villager's current level, 0..1 (full at Master). */
const traderProgress = computed(() => {
    const m = trader.value
    if (!m || m.level >= 5) return 1
    const lo = LEVEL_XP[m.level - 1]!, hi = LEVEL_XP[m.level]!
    return Math.min(1, (m.xp - lo) / (hi - lo))
})

function tradeOffer(i: number, shift: boolean) {
    const m = trader.value
    if (!m || !island) return
    island.trade(m, i, shift ? 64 : 1)
    touch()
}

// A villager stops to trade only while its screen is open.
watch(panel, (now) => {
    if (island && now?.kind !== 'trading') island.mobs.trader = null
})

/** The stonecutter's input slot (given back when the screen closes), and the cuts it offers. */
let cutSlots = new Slots(1)
const cuts = computed(() => {
    void version.value
    const input = cutSlots.slots[0]
    return input ? STONECUTTING[input.item] ?? [] : []
})

/** Takes one cut: onto the cursor, or with Shift, the whole stack's worth into the inventory. */
function takeCut(output: string, shift: boolean) {
    if (!island) return
    if (shift) {
        while (cutSlots.slots[0]) {
            const made = island.cutStone(cutSlots, 0, output)
            if (!made) break
            const left = island.inventory.add(made.item, made.count)
            if (left > 0) engine?.throwItems(made.item, left)
        }
    } else {
        const next = cutSlots.slots[0] ? STONECUTTING[cutSlots.slots[0].item]?.find(c => c.item === output) : undefined
        if (!next || (cursor && (cursor.item !== output || cursor.count + next.count > item(output).maxStack))) return
        const made = island.cutStone(cutSlots, 0, output)
        if (made) cursor = cursor ? { item: output, count: cursor.count + made.count } : made
    }
    touch()
}


/** Where you stand now, for the land map's marker. */
function playerAt() {
    const at = engine?.position ?? island?.player
    return { x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0 }
}

const awayDuration = computed(() => {
    const s = away.value?.seconds ?? 0
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
    return h > 0 ? `You were gone ${h}h ${m}m.` : `You were gone ${m}m.`
})

function oreLine(lvl: (typeof ORE_LEVELS)[number]) {
    const parts = [['coal', lvl.coal], ['iron', lvl.iron], ['gold', lvl.gold], ['diamond', lvl.diamond]]
        .filter(([, p]) => (p as number) > 0)
        .map(([k, p]) => `${k} ${((p as number) * 100).toFixed(1).replace(/\.0$/, '')}%`)
    return parts.length ? parts.join(', ') : 'Cobblestone only'
}

// ── Panel actions ──────────────────────────────────────────────────────

/** The stack picked up in a screen, carried by the mouse until it is put down. */
let cursor: ItemStack | null = null
const cursorView = computed(() => (version.value, cursor ? { ...cursor } : null))
const mouse = reactive({ x: 0, y: 0 })
const trackMouse = (e: MouseEvent) => {
    mouse.x = e.clientX
    mouse.y = e.clientY
}

/** The crafting grid of the open screen: 2x2 in the inventory, 3x3 at a crafting table. */
let craftSlots = new Slots(4)
const craftSize = computed(() => (panel.value?.kind === 'crafting' ? 3 : 2))
const craftResult = computed(() => (version.value, craft(craftSlots.slots, craftSize.value)))

type Area = 'inventory' | 'container' | 'craft' | 'armor' | 'cut' | 'depot'

function slotsOf(area: Area): Slots | null {
    if (area === 'inventory') return island?.inventory ?? null
    if (area === 'container') return container.value
    if (area === 'armor') return island?.armor ?? null
    if (area === 'cut') return cutSlots
    if (area === 'depot') return depotSlots
    return craftSlots
}

/** Whether `key` can be worn in armour slot `i` (a helmet on the head, and so on). */
const fitsArmor = (key: string, i: number) => item(key).armor?.slot === ARMOR_SLOTS[i]

/** Shift-click: where a stack goes from where it is (as in Minecraft). */
function quickMove(area: Area, i: number) {
    const from = slotsOf(area)
    const s = from?.slots[i]
    if (!from || !s || !island) return
    let to: Slots | null = null
    const armorSlot = item(s.item).armor ? ARMOR_SLOTS.indexOf(item(s.item).armor!.slot) : -1
    if (area === 'inventory' && !container.value && armorSlot >= 0 && !island.armor.slots[armorSlot]) {
        // Armour from the inventory goes on, if that slot is free.
        island.armor.slots[armorSlot] = s
        from.slots[i] = null
        return
    }
    if (area === 'container' || area === 'craft' || area === 'armor' || area === 'cut') {
        to = island.inventory
    } else if (container.value && panel.value?.kind === 'furnace') {
        // Into a furnace: what smelts here goes on top, fuel underneath, anything else stays put.
        const p = panel.value
        const kind = island.furnace(p.x, p.y, p.z)?.kind ?? 'furnace'
        const target = smeltResult(kind, s.item) ? FURNACE_INPUT : FUEL[s.item] ? FURNACE_FUEL : -1
        if (target < 0) return
        const one = new Slots(1, [container.value.slots[target] ?? null])
        const left = one.add(s.item, s.count)
        container.value.slots[target] = one.slots[0] ?? null
        from.slots[i] = left > 0 ? { item: s.item, count: left } : null
        return
    } else if (panel.value?.kind === 'depot') {
        // Into the depot: straight to the store.
        island.deposit(s.item, s.count)
        from.slots[i] = null
        return
    } else if (panel.value?.kind === 'stonecutter') {
        // Into the stonecutter, if it can cut it.
        if (!STONECUTTING[s.item]) return
        to = cutSlots
    } else if (container.value) {
        to = container.value
    } else {
        // Inventory alone: hotbar to the main inventory and back.
        const toMain = i < HOTBAR
        const range = toMain ? [HOTBAR, island.inventory.slots.length] : [0, HOTBAR]
        const part = new Slots(range[1]! - range[0]!, island.inventory.slots.slice(range[0], range[1]))
        const left = part.add(s.item, s.count)
        island.inventory.slots.splice(range[0]!, part.slots.length, ...part.slots)
        from.slots[i] = left > 0 ? { item: s.item, count: left } : null
        return
    }
    const left = to.add(s.item, s.count)
    from.slots[i] = left > 0 ? { item: s.item, count: left } : null
}

const isFurnaceOutput = (area: Area, i: number) => area === 'container' && panel.value?.kind === 'furnace' && i === FURNACE_OUTPUT

/** A drag in progress: the stack in hand spreads over these slots when the button comes up. */
let drag: { right: boolean, targets: { area: Area, i: number }[] } | null = null
const dragMarks = ref<{ area: Area, i: number }[]>([])

/** The slots of `area` marked by the drag, numbered within a grid that starts at `from` (and ends before `to`). */
function marksIn(area: Area, from = 0, to = Infinity) {
    return dragMarks.value.filter(m => m.area === area && m.i >= from && m.i < to).map(m => m.i - from)
}

/**
 * Mouse down on a slot. Shift moves the stack across; with nothing in hand the
 * stack (or half of it) comes up at once; with a stack in hand a drag starts,
 * settled when the button comes up.
 */
function pressSlot(area: Area, i: number, c: SlotClick) {
    const slots = slotsOf(area)
    if (!slots) return
    if (isFurnaceOutput(area, i) && cursor && !c.shift) {
        // Nothing goes into a furnace's output; a matching stack in hand picks more up.
        const out = slots.slots[i]
        if (out && out.item === cursor.item) {
            const n = Math.min(out.count, item(out.item).maxStack - cursor.count)
            cursor.count += n
            out.count -= n
            if (out.count === 0) slots.slots[i] = null
        }
        touch()
        return
    }
    if (area === 'armor' && cursor && !c.shift) {
        // Only the right piece goes in an armour slot; it swaps with what is worn.
        if (fitsArmor(cursor.item, i)) cursor = clickSlot(slots.slots, i, cursor, false)
        touch()
        return
    }
    if (c.shift) {
        quickMove(area, i)
    } else if (!cursor) {
        cursor = clickSlot(slots.slots, i, null, c.right)
    } else {
        drag = { right: c.right, targets: [{ area, i }] }
        dragMarks.value = [...drag.targets]
    }
    touch()
}

/** The mouse moves over a slot mid-drag: it joins the drag if the stack can go there. */
function enterSlot(area: Area, i: number) {
    const slots = slotsOf(area)
    if (!drag || !cursor || !slots || isFurnaceOutput(area, i) || area === 'armor') return
    if (drag.targets.some(t => t.area === area && t.i === i)) return
    if (!canDragInto({ slots: slots.slots, i }, cursor)) return
    drag.targets.push({ area, i })
    dragMarks.value = [...drag.targets]
}

/** The button comes up: one slot is an ordinary click, several share the stack out. */
function releaseDrag() {
    if (!drag) return
    const d = drag
    drag = null
    dragMarks.value = []
    if (!cursor) return
    const refs = d.targets.map(t => ({ slots: slotsOf(t.area)?.slots ?? [], i: t.i }))
    if (refs.length === 1) cursor = clickSlot(refs[0]!.slots, refs[0]!.i, cursor, d.right)
    else cursor = dragSplit(refs, cursor, d.right)
    touch()
}

/** The result slot: take one craft onto the cursor, or with Shift as many as fit into the inventory. */
function clickResult(shift: boolean) {
    if (!island) return
    if (shift) craftAll(craftSlots.slots, craftSize.value, island.inventory)
    else cursor = takeResult(craftSlots.slots, craftSize.value, cursor)
    touch()
}

/** Puts what is left in the crafting grid and on the cursor back in the inventory; what doesn't fit is thrown out. */
function returnItems() {
    if (!island) return
    const loose = [...craftSlots.slots, ...cutSlots.slots, cursor].filter((s): s is ItemStack => !!s)
    craftSlots = new Slots(craftSize.value * craftSize.value)
    cutSlots = new Slots(1)
    cursor = null
    for (const s of loose) {
        const left = island.inventory.add(s.item, s.count)
        if (left > 0) engine?.throwItems(s.item, left)
    }
    touch()
}

// Leaving a screen (closing it, or switching to the shop) gives back what was in the grid or in hand.
watch(panel, (now, before) => {
    if (before && before.kind !== 'shop' && now?.kind !== before.kind) returnItems()
    craftSlots = new Slots(now?.kind === 'crafting' ? 9 : 4)
    touch()
})

/** Buys one of a shop item for site coins: the server charges, then it goes in your inventory. */
async function buy(key: string) {
    if (!island || buying.value) return
    if (!island.hasRoom(key, 1)) {
        toast.add({ title: 'No room in your inventory', color: 'warning' })
        return
    }
    buying.value = key
    try {
        const res = await apiFetch<{ balance: string }>('/api/skyfarm/shop/buy', { method: 'POST', body: { item: key, count: 1 } })
        island.received(key, 1)
        setBalance(res.balance)
        touch()
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not buy that'), color: 'error' })
    } finally {
        buying.value = ''
    }
}


/** Land was paid for: save straight away, so the island owns what you paid for. */
function landBought() {
    touch()
    void save()
}

/** Buys the generator's next ore level for site coins. */
async function upgradeOres() {
    if (!island || buying.value) return
    buying.value = 'generator'
    try {
        const res = await apiFetch<{ oreLevel: number, balance: string }>('/api/skyfarm/generator/upgrade', { method: 'POST' })
        island.setOreLevel(res.oreLevel)
        setBalance(res.balance)
        touch()
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not upgrade the generator'), color: 'error' })
    } finally {
        buying.value = ''
    }
}

function closePanel() {
    panel.value = null
    resume()
}

function resume() {
    engine?.lock()
}

/**
 * After Escape closed a screen: you are still playing, not paused. Browsers
 * refuse to take the mouse back from the Escape key itself, so the next click
 * anywhere does it, and the pause screen stays away.
 */
const continuing = ref(false)
watch(() => hud.locked, (locked) => {
    if (locked) continuing.value = false
})

/**
 * Escape closes whatever screen is open (or the away report) and leaves you
 * in the game. Only with nothing to close does it pause. E closes a screen
 * too, and goes straight back in.
 */
function onKey(e: KeyboardEvent) {
    if (e.code === 'Escape') {
        if (away.value) {
            away.value = null
            continuing.value = true
        } else if (panel.value) {
            panel.value = null
            continuing.value = true
        } else if (continuing.value) {
            // Nothing left to close: now it is a pause.
            continuing.value = false
        }
    } else if (e.code === 'KeyE' && panel.value && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        closePanel()
    }
}

// ── Saving ─────────────────────────────────────────────────────────────

/**
 * The island as saved, with whatever sits in the crafting grid or on the
 * cursor counted into the inventory: those only live in the open screen, and
 * a reload or a closed tab must not lose them. The live screen is untouched.
 */
function saveWithLooseItems() {
    const data = island!.toSave()
    const loose = [...craftSlots.slots, cursor].filter((s): s is ItemStack => !!s)
    if (loose.length) {
        const inv = new Slots(INVENTORY_SLOTS, data.state.inventory)
        for (const s of loose) inv.add(s.item, s.count)
        data.state.inventory = inv.slots
    }
    return data
}

/** Saves the island; `leaving` (hidden or closed page) first collects any drops still lying around. */
async function save(leaving = false) {
    if (!island || !engine || saving || blocked) return
    saving = true
    engine.syncPlayer(leaving)
    try {
        const res = await saveIsland(saveWithLooseItems(), storedColumns, body => apiFetch<{ revision: number, savedAt: number }>('/api/skyfarm/island', {
            method: 'PUT',
            body,
            headers: { 'content-type': 'application/octet-stream', 'x-skyfarm-revision': String(revision) },
            // Leaving (a closed tab, a reload): let the save finish after the page is gone.
            keepalive: leaving
        }))
        revision = res.revision
        storedColumns = res.stored
        // What storage took is no longer on its way.
        if (Object.keys(res.accepted).length) {
            island.accepted(res.accepted)
            storageAccepted.value++
            touch()
        }
        saveState.value = ''
    } catch (e) {
        const status = (e as { statusCode?: number })?.statusCode
        if (status === 409) {
            // Another tab saved: stop, rather than overwrite it.
            blocked = true
            saveState.value = 'Not saving: open in another tab'
            toast.add({ title: 'This island is open somewhere else', description: 'Reload to continue from the latest save.', color: 'warning' })
        } else {
            saveState.value = 'Save failed, retrying'
        }
    } finally {
        saving = false
    }
}

function startEngine() {
    engine = new SkyfarmEngine(viewport.value!, island!, pack.value!, {
        sound: (s, id, distance, pitch) => sounds?.play(s, id, distance, pitch),
        onGesture: () => sounds?.unlock(),
        onHud: (h) => {
            Object.assign(hud, h)
            // Mining, buckets and chests change the inventory and coins from inside the engine.
            version.value++
        },
        onPanel: (p) => {
            panel.value = p
        },
        // The tab slept over a minute: show what the island made meanwhile.
        onAway: (report) => {
            away.value = report
            touch()
        }
    })
    touch()
}

// ── Starting over ──────────────────────────────────────────────────────

const confirmingReset = ref(false)
const resetting = ref(false)

/** Throws the island away for a fresh starter island, and saves that straight away. */
async function resetIsland() {
    if (!island || resetting.value) return
    resetting.value = true
    panel.value = null
    away.value = null
    engine?.dispose()
    island = Island.fresh()
    startEngine()
    await save()
    resetting.value = false
    confirmingReset.value = false
}

function saveOnHide() {
    if (document.visibilityState === 'hidden') void save(true)
}

onMounted(async () => {
    // Development only: ?test=busy plays the busy test island (100 cubes of machines), never saved.
    if (import.meta.dev && new URLSearchParams(location.search).get('test') === 'busy') {
        const [{ busyIsland }, blocks] = await Promise.all([import('~/utils/skyfarm/test-island'), loadBlockPack()])
        pack.value = blocks
        island = busyIsland()
        blocked = true
        saveState.value = 'Test island: not saved'
        phase.value = 'playing'
        await nextTick()
        sounds = new SkyfarmSounds(pack.value.json.sounds, pack.value.base)
        startEngine()
        window.addEventListener('keydown', onKey)
        window.addEventListener('mousemove', trackMouse)
        window.addEventListener('mouseup', releaseDrag)
        return
    }
    try {
        const [data, blocks] = await Promise.all([
            fetchIsland(),
            loadBlockPack()
        ])
        pack.value = blocks
        revision = data.revision
        storedColumns = data.stored
        if (data.island) {
            island = Island.fromSave(data.island)
            const report = island.catchUp(Math.max(0, data.now - (data.savedAt ?? data.now)))
            if (report.seconds > 60 && (report.coins > 0 || Object.keys(report.items).length > 0)) away.value = report
        } else {
            island = Island.fresh()
        }
    } catch (e) {
        toast.add({ title: apiErrorMessage(e, 'Could not load your island'), color: 'error' })
        return
    }
    phase.value = 'playing'
    await nextTick()
    sounds = new SkyfarmSounds(pack.value!.json.sounds, pack.value!.base)
    muted.value = sounds.muted
    startEngine()
    if (revision === 0) void save()
    timer = setInterval(() => void save(), AUTOSAVE_MS)
    document.addEventListener('visibilitychange', saveOnHide)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousemove', trackMouse)
    window.addEventListener('mouseup', releaseDrag)
})

onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', saveOnHide)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('mousemove', trackMouse)
    window.removeEventListener('mouseup', releaseDrag)
    void save(true)
    engine?.dispose()
    engine = null
    sounds?.dispose()
    sounds = null
})
</script>

<style scoped>
.sf-pixel {
    image-rendering: pixelated;
}

/* At two hearts or less they shake, each on its own beat (Minecraft's low-health jiggle). */
.sf-low .sf-heart {
    animation: sf-jiggle 0.3s steps(2) infinite;
    animation-delay: calc(var(--i) * -0.07s);
}

@keyframes sf-jiggle {
    0% {
        transform: translateY(0);
    }

    50% {
        transform: translateY(-2px);
    }
}
</style>
