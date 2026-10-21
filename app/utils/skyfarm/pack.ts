import * as THREE from 'three'
import { BLOCKS } from './blocks'

/*
 * The block pack: models and textures from a Minecraft resource pack
 * (Pixel Perfection Legacy, CC BY-SA 4.0, see public/skyfarm/pack/LICENSE.txt),
 * compiled by scripts/skyfarm-pack.ts. Models keep Minecraft's format:
 * elements from/to in pixels (0..16), per-face uv in pixels, a cull side and
 * a tint slot. Textures load into one texture array, a layer per texture
 * (animations get a layer per frame), so no tile ever bleeds into the next.
 */

export type Dir = 'down' | 'up' | 'north' | 'south' | 'west' | 'east'
export type Vec3 = [number, number, number]

export interface PackFace {
    t: number
    uv: [number, number, number, number]
    cull?: Dir
    tint?: number
    rot?: number
}

export interface PackElement {
    from: Vec3
    to: Vec3
    rot?: { origin: Vec3, axis: 'x' | 'y' | 'z', angle: number, rescale: boolean }
    shade: boolean
    faces: Partial<Record<Dir, PackFace>>
}

export interface PackModel {
    ao: boolean
    elements: PackElement[]
}

export interface PackVariant {
    model: number
    x: number
    y: number
    weight: number
}

interface PackJson {
    textures: { file: string, frames: number, timeline?: number[] }[]
    models: PackModel[]
    blocks: Record<string, { states: PackVariant[][], tints?: number[] }>
    icons: Record<string, string>
    /** Texture index of each of the ten mining crack stages. */
    crack: number[]
    /** Sound files by group (see sounds.ts). */
    sounds: Record<string, string[]>
}

/** Animated textures are numbered from 1; slot 0 is "not animated". */
export const MAX_ANIMATED = 15

export interface BlockLook {
    /** Variants per state (see stateOf in mesher.ts). */
    states: PackVariant[][]
    tints: number[]
}

export class BlockPack {
    /** Indexed by block id. */
    readonly looks: (BlockLook | null)[] = []
    /** First texture-array layer of each pack texture. */
    readonly layer: number[] = []
    /** Animation slot of each pack texture (0: still). */
    readonly anim: number[] = []
    /** Per animation slot, the frame to show on each tick of its loop. */
    readonly timelines: number[][] = []
    /** Current frame offset per animation slot: a shader uniform, updated by `tick`. */
    readonly frames = new Float32Array(MAX_ANIMATED + 1)

    constructor(readonly json: PackJson, readonly texture: THREE.DataArrayTexture, readonly base: string) {
        for (const b of BLOCKS) {
            const entry = json.blocks[b.key]
            this.looks[b.id] = entry ? { states: entry.states, tints: entry.tints ?? [] } : null
        }
        let layer = 0
        for (const t of json.textures) {
            this.layer.push(layer)
            if (t.timeline && this.timelines.length < MAX_ANIMATED) {
                this.timelines.push(t.timeline)
                this.anim.push(this.timelines.length)
            } else {
                this.anim.push(0)
            }
            layer += t.frames
        }
    }

    get models() {
        return this.json.models
    }

    /** Moves every animation to game tick `tick` (20 a second). */
    tick(tick: number) {
        for (let i = 0; i < this.timelines.length; i++) {
            const line = this.timelines[i]!
            this.frames[i + 1] = line[tick % line.length]!
        }
    }

    /** Texture-array layer of crack stage 0..9. */
    crackLayer(stage: number) {
        return this.layer[this.json.crack[Math.max(0, Math.min(9, stage))]!]!
    }

    /**
     * The texture a block's break particles are cut from (its first side face,
     * skipping overlays) and the tint that face takes.
     */
    particleOf(id: number): { layer: number, tint: number | null } | null {
        const look = this.looks[id]
        const model = look ? this.models[look.states[0]![0]!.model] : null
        if (!look || !model) return null
        for (const dir of ['north', 'up', 'south', 'east', 'west', 'down'] as Dir[]) {
            for (const e of model.elements) {
                const f = e.faces[dir]
                if (!f) continue
                return { layer: this.layer[f.t]!, tint: f.tint !== undefined ? (look.tints[f.tint] ?? null) : null }
            }
        }
        return null
    }

    /** An image URL and frame count for a pack texture (frame 0 is the top square). */
    textureUrl(t: number) {
        const file = this.json.textures[t]?.file
        return file ? `${this.base}/textures/${file}` : null
    }

    /**
     * What an item looks like in a slot: a flat icon, or a block drawn as a
     * little cube from its top and side faces.
     */
    icon(key: string): { flat: string } | { top: string, side: string, height: number } | null {
        const own = this.json.icons[key]
        if (own) return { flat: `${this.base}/icons/${own}` }
        const def = BLOCKS.find(b => b.key === key)
        const look = def ? this.looks[def.id] : null
        const model = look ? this.models[look.states[0]![0]!.model] : null
        if (!model) return null
        const first = (dirs: Dir[]) => {
            for (const e of model.elements) for (const d of dirs) if (e.faces[d]) return this.textureUrl(e.faces[d]!.t)
            return null
        }
        // A block that fills its footprint is drawn as a little cube, as tall as it is
        // (a full block, or half for a slab).
        const body = model.elements.find(e => e.to[0] - e.from[0] >= 14 && e.to[2] - e.from[2] >= 14 && e.to[1] - e.from[1] >= 7)
        const side = first(['north', 'south', 'east', 'west'])
        const top = first(['up'])
        if (body && side && top) return { top, side, height: Math.min(1, (body.to[1] - body.from[1]) / 16) }
        return side || top ? { flat: (side ?? top)! } : null
    }
}

/** Every layer is drawn at this size; 16x16 textures are scaled up (nearest), the 64x64 chest sheet fits as is. */
const LAYER = 64

function loadImage(url: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`Could not load ${url}`))
        img.src = url
    })
}

export async function loadBlockPack(base = '/skyfarm/pack'): Promise<BlockPack> {
    const json = await $fetch<PackJson>(`${base}/blocks.json`)
    const layers = json.textures.reduce((n, t) => n + t.frames, 0)
    const data = new Uint8Array(LAYER * LAYER * 4 * layers)
    const canvas = document.createElement('canvas')
    canvas.width = LAYER
    canvas.height = LAYER
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingEnabled = false
    const images = await Promise.all(json.textures.map(t => (t.file ? loadImage(`${base}/textures/${t.file}`) : Promise.resolve(null))))
    let layer = 0
    for (let i = 0; i < json.textures.length; i++) {
        const t = json.textures[i]!
        const img = images[i]
        for (let f = 0; f < t.frames; f++) {
            ctx.clearRect(0, 0, LAYER, LAYER)
            if (img) {
                const w = img.width
                ctx.drawImage(img, 0, f * w, w, Math.min(w, img.height), 0, 0, LAYER, LAYER)
            } else {
                // A missing texture: Minecraft's magenta and black.
                ctx.fillStyle = '#f0f'
                ctx.fillRect(0, 0, LAYER, LAYER)
                ctx.fillStyle = '#000'
                ctx.fillRect(0, 0, LAYER / 2, LAYER / 2)
                ctx.fillRect(LAYER / 2, LAYER / 2, LAYER / 2, LAYER / 2)
            }
            data.set(ctx.getImageData(0, 0, LAYER, LAYER).data, layer * LAYER * LAYER * 4)
            layer++
        }
    }
    const texture = new THREE.DataArrayTexture(data, LAYER, LAYER, layers)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    // Mipmaps keep distant faces from shimmering; nearest within a level keeps the pixels crisp.
    texture.minFilter = THREE.NearestMipmapLinearFilter
    texture.generateMipmaps = true
    texture.needsUpdate = true
    return new BlockPack(json, texture, base)
}
