<template>
    <div class="grid w-fit gap-1" :style="{ gridTemplateColumns: `repeat(${cols}, 2.75rem)` }">
        <button
            v-for="(s, i) in slots"
            :key="i"
            type="button"
            class="size-11 rounded border bg-black/30 hover:bg-black/15"
            :class="marked?.includes(i) ? 'border-primary bg-primary/15' : i === selected ? 'border-primary' : 'border-default'"
            @mousedown.prevent="e => emit('press', i, { right: e.button === 2, shift: e.shiftKey })"
            @mouseenter="emit('enter', i)"
            @contextmenu.prevent
        >
            <SkyfarmSlot :stack="s" />
        </button>
    </div>
</template>

<script setup lang="ts">
import type { ItemStack } from '#shared/utils/skyfarm/save'

export interface SlotClick {
    /** Right button: take half, or put one down. */
    right: boolean
    /** Shift held: move the stack across in one go. */
    shift: boolean
}

withDefaults(defineProps<{ slots: (ItemStack | null)[], cols: number, selected?: number | null, marked?: number[] }>(), { selected: null, marked: () => [] })
/**
 * `press` on mouse down; `enter` as the mouse moves over a slot (for a drag
 * across slots). The screen decides what a press and a release add up to.
 */
const emit = defineEmits<{ press: [index: number, click: SlotClick], enter: [index: number] }>()
</script>
