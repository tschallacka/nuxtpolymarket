<template>
    <div class="relative flex size-full items-center justify-center" :title="def?.name">
        <template v-if="stack">
            <img v-if="icon && 'flat' in icon" :src="icon.flat" alt="" class="sf-pixel size-[78%] object-cover object-top">
            <!-- A block: a little cube from its top and side faces, as tall as the block (half for a slab). -->
            <div v-else-if="icon" class="sf-cube">
                <div class="sf-face sf-top" :style="{ backgroundImage: `url(${icon.top})`, transform: `translateY(${(1 - icon.height) * 20}px) rotateX(90deg) translateZ(10px)` }" />
                <div class="sf-face sf-left" :style="{ backgroundImage: `url(${icon.side})`, ...sideClip(icon.height) }" />
                <div class="sf-face sf-right" :style="{ backgroundImage: `url(${icon.side})`, ...sideClip(icon.height) }" />
            </div>
            <div v-else class="size-[68%] rounded-sm" :style="{ backgroundColor: hex }" />
            <span v-if="stack.count > 1" class="absolute bottom-0 right-0.5 font-mono text-[11px] font-bold text-white [text-shadow:1px_1px_0_rgba(0,0,0,0.9)]">
                {{ stack.count }}
            </span>
        </template>
    </div>
</template>

<script setup lang="ts">
import type { ShallowRef } from 'vue'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { item } from '~/utils/skyfarm/items'
import type { BlockPack } from '~/utils/skyfarm/pack'

const props = defineProps<{ stack: ItemStack | null }>()
const pack = inject<ShallowRef<BlockPack | null>>('skyfarmPack', shallowRef(null))

const def = computed(() => (props.stack ? item(props.stack.item) : null))
const icon = computed(() => (props.stack && pack.value ? pack.value.icon(props.stack.item) : null))
/** A side face of a shorter block: only its lower part, showing the bottom of the texture. */
const sideClip = (height: number) => (height >= 1
    ? {}
    : { top: `${(1 - height) * 100}%`, height: `${height * 100}%`, backgroundPosition: 'bottom' })
const hex = computed(() => `#${(def.value?.color ?? 0).toString(16).padStart(6, '0')}`)
</script>

<style scoped>
.sf-pixel {
    image-rendering: pixelated;
}

/* translateZ takes no percentages, so the cube has a fixed size that fits every slot. */
.sf-cube {
    position: relative;
    width: 20px;
    height: 20px;
    transform-style: preserve-3d;
    transform: rotateX(-30deg) rotateY(45deg);
}

.sf-face {
    position: absolute;
    inset: 0;
    background-size: 100% auto;
    background-position: top;
    image-rendering: pixelated;
}

.sf-top {
    transform: rotateX(90deg) translateZ(10px);
}

.sf-left {
    transform: translateZ(10px);
    filter: brightness(0.8);
}

/* The cube is turned 45 degrees: the faces toward the viewer are +z and -x. */
.sf-right {
    transform: rotateY(-90deg) translateZ(10px);
    filter: brightness(0.6);
}
</style>
