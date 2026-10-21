import { randomFloat, randomPick } from '#shared/utils/random'
import { B } from './blocks'

/*
 * Skyfarm's sounds, from the block pack (public/skyfarm/pack/sounds). Each
 * block has a material (grass, gravel, wood, ...) and every action plays that
 * material's sound with Minecraft's volume and pitch for it: a quiet low tick
 * per mining hit, a full sound when the block breaks or is placed, a soft one
 * per footstep. The pack has no stone sounds; stone uses gravel, pitched down.
 */

export type SkyfarmSound = 'dig' | 'break' | 'place' | 'pop' | 'step' | 'chestOpen' | 'chestClose' | 'splash' | 'fizz' | 'ignite' | 'rain' | 'thunder'
    | 'hurt' | 'explode' | 'fuse' | 'bow' | 'arrowHit' | 'potion' | 'drink' | 'cure' | 'click'

type Material = 'grass' | 'gravel' | 'sand' | 'wood' | 'cloth' | 'glass' | 'stone'

function materialOf(id: number): Material {
    switch (id) {
        case B.Grass:
        case B.OakLeaves:
        case B.OakSapling:
        case B.Wheat:
        case B.SugarCane:
        case B.MelonStem:
        case B.PumpkinStem: return 'grass'
        case B.Dirt:
        case B.Farmland: return 'gravel'
        case B.Sand: return 'sand'
        case B.OakLog:
        case B.OakPlanks:
        case B.Chest:
        case B.SellChest:
        case B.CraftingTable:
        case B.Melon:
        case B.Pumpkin: return 'wood'
        case B.Cactus:
        case B.WhiteWool: return 'cloth'
        case B.Glass:
        case B.Ice: return 'glass'
        default: return 'stone'
    }
}

/** The pack group and pitch for a material (glass only shatters; it sounds like stone otherwise). */
function groupOf(m: Material, breaking: boolean): { group: string, pitch: number } {
    if (m === 'glass') return breaking ? { group: 'glass', pitch: 1 } : { group: 'gravel', pitch: 0.75 }
    if (m === 'stone') return { group: 'gravel', pitch: 0.75 }
    return { group: m, pitch: 1 }
}

const MUTE_KEY = 'skyfarm:muted'

export class SkyfarmSounds {
    private ctx: AudioContext | null = null
    private out: GainNode | null = null
    private buffers = new Map<string, AudioBuffer[]>()
    private loading: Promise<void> | null = null
    muted = false

    constructor(private readonly groups: Record<string, string[]>, private readonly base: string) {
        try {
            this.muted = localStorage.getItem(MUTE_KEY) === '1'
        } catch {
            // Storage blocked: start unmuted.
        }
    }

    /** Call from a user gesture: browsers only let audio start after one. Loads the sounds the first time. */
    unlock() {
        if (!this.ctx) {
            this.ctx = new AudioContext()
            this.out = this.ctx.createGain()
            this.out.gain.value = this.muted ? 0 : 0.8
            this.out.connect(this.ctx.destination)
            this.loading = this.load()
        }
        if (this.ctx.state === 'suspended') void this.ctx.resume()
    }

    setMuted(muted: boolean) {
        this.muted = muted
        if (this.out) this.out.gain.value = muted ? 0 : 0.8
        try {
            localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
        } catch {
            // Storage blocked: the setting lasts this visit only.
        }
    }

    private async load() {
        const ctx = this.ctx!
        await Promise.all(Object.entries(this.groups).map(async ([group, files]) => {
            const decoded = await Promise.all(files.map(async (f) => {
                try {
                    const data = await fetch(`${this.base}/sounds/${f}`).then(r => r.arrayBuffer())
                    return await ctx.decodeAudioData(data)
                } catch {
                    // A browser that can't decode Ogg (older Safari) just stays quiet for that sound.
                    return null
                }
            }))
            this.buffers.set(group, decoded.filter((b): b is AudioBuffer => !!b))
        }))
    }

    /**
     * Plays `sound` for block `id`. `distance` (blocks from the player) fades
     * it out; beyond 16 blocks it isn't heard (an explosion carries further).
     * `pitch` raises or lowers it (a chicken's hurt squeak against a cow's).
     */
    play(sound: SkyfarmSound, id = 0, distance = 0, pitch = 1) {
        const range = sound === 'explode' ? 48 : 16
        if (!this.ctx || !this.out || this.muted || distance > range) return
        const fade = 1 - distance / range
        switch (sound) {
            case 'hurt': return this.fire({ group: 'hurt', pitch }, 0.8 * fade, 0.9 + randomFloat() * 0.2)
            case 'explode': return this.fire({ group: 'explode', pitch: 1 }, 1 * fade, (1 + (randomFloat() - randomFloat()) * 0.2) * 0.7)
            case 'fuse': return this.fire({ group: 'fuse', pitch: 1 }, 1 * fade, 0.5)
            case 'bow': return this.fire({ group: 'bow', pitch: 1 }, 1 * fade, 1 / (randomFloat() * 0.4 + 0.8))
            case 'arrowHit': return this.fire({ group: 'arrowHit', pitch: 1 }, 1 * fade, 1.2 / (randomFloat() * 0.2 + 0.9))
            // A splash potion breaks like glass; a witch's drink glugs.
            case 'potion': return this.fire({ group: 'glass', pitch: 1 }, 1 * fade, 0.9 + randomFloat() * 0.1)
            case 'drink': return this.fire({ group: 'drink', pitch: 1 }, 0.5 * fade, 0.9 + randomFloat() * 0.1)
            // A zombie villager cured: the pack has no villager sounds, so a bright chime.
            case 'cure': return this.fire({ group: 'cure', pitch: 1 }, 0.8 * fade, 1)
            // A lever, button or repeater clicking.
            case 'click': return this.fire({ group: 'click', pitch: 1 }, 0.3 * fade, 0.6)
        }
        const m = materialOf(id)
        // Minecraft's numbers: hits are quiet and low, breaks and placements full and a bit low.
        switch (sound) {
            case 'dig': return this.fire(groupOf(m, false), 0.25 * fade, 0.5)
            case 'break': return this.fire(groupOf(m, true), 0.9 * fade, 0.8)
            case 'place': return this.fire(groupOf(m, false), 0.9 * fade, 0.8)
            case 'step': return this.fire(groupOf(m, false), 0.18 * fade, 1)
            case 'pop': return this.fire({ group: 'pop', pitch: 1 }, 0.25 * fade, 1.4 + randomFloat() * 0.6)
            case 'chestOpen': return this.fire({ group: 'chestOpen', pitch: 1 }, 0.5 * fade, 0.9 + randomFloat() * 0.1)
            case 'chestClose': return this.fire({ group: 'chestClose', pitch: 1 }, 0.5 * fade, 0.9 + randomFloat() * 0.1)
            case 'splash': return this.fire({ group: 'splash', pitch: 1 }, 0.4 * fade, 1)
            case 'fizz': return this.fire({ group: 'fizz', pitch: 1 }, 0.4 * fade, 2.6 + randomFloat() * 0.8)
            case 'ignite': return this.fire({ group: 'ignite', pitch: 1 }, 0.6 * fade, 0.8 + randomFloat() * 0.4)
            case 'rain': return this.fire({ group: 'rain', pitch: 1 }, 0.12 * fade, 0.9 + randomFloat() * 0.2)
            // Thunder rolls in from far away: loud, low, not faded by distance.
            case 'thunder': return this.fire({ group: 'thunder', pitch: 1 }, 0.9, 0.7 + randomFloat() * 0.25)
        }
    }

    private fire(g: { group: string, pitch: number }, volume: number, rate: number) {
        const list = this.buffers.get(g.group)
        if (!list?.length || volume <= 0) return
        const ctx = this.ctx!
        const src = ctx.createBufferSource()
        src.buffer = randomPick(list)
        src.playbackRate.value = rate * g.pitch
        const gain = ctx.createGain()
        gain.gain.value = volume
        src.connect(gain).connect(this.out!)
        src.start()
    }

    /** Resolves once the sounds are decoded (for tests and the dev hook). */
    get ready() {
        return this.loading ?? Promise.resolve()
    }

    dispose() {
        void this.ctx?.close()
        this.ctx = null
    }
}
