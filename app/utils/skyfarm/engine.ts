import * as THREE from 'three'
import { randomFloat } from '#shared/utils/random'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { DfInput } from '../dead-front/engine/input'
import { dfAdaptivePixelRatio, dfPixelRatioBounds, type DfPrBounds } from '../dead-front/engine/resolution'
import { B, block, FURNACES, solidRange } from './blocks'
import { Crack, Drops, geometryOf, Hand, ItemLooks, Particles, type SoundHook } from './effects'
import { HOTBAR, type AwayReport, type Island } from './island'
import { attackStats, item } from './items'
import { LightField, MAX_LIGHT } from './light'
import type { MeshJob, MeshResult } from './mesh-worker'
import { meshChunk, type ChunkMeshes } from './mesher'
import { MobRenderer } from './mobRender'
import type { Mob } from './mobs'
import type { BlockPack } from './pack'
import { EYE, HALF_WIDTH, HEIGHT as BODY_HEIGHT, pick, SNEAK_EYE, stepBody, type Body, type Hit } from './player'
import { TICKS_PER_SECOND } from './sim'
import { Sky } from './sky'
import { blockMaterial, lightUniforms } from './surface'
import { CHUNK, HEIGHT as WORLD_HEIGHT } from './world'

/*
 * The first-person view of an island: renders its chunks, walks the player
 * around them, mines and places, and runs the island's clock at 20 ticks a
 * second. Everything that is not a pixel lives on the Island, so the Vue
 * layer only ever reads it and calls its methods. The feel of it (crack,
 * chips, drops, the swinging arm) is in effects.ts.
 */

const REACH = 5
/** How far you can hit a mob (Minecraft's entity reach). */
const ENTITY_REACH = 3
const LOOK_SPEED = 0.0022
/** Mesh workers, and jobs each may have out at once. */
const MESH_WORKERS = 2
const JOBS_PER_WORKER = 2
/**
 * How often a chunk that keeps changing is rebuilt at most (ms): near and in
 * view, further off in view, and out of view. Within REMESH_NEAR blocks counts as near.
 */
const REMESH_NEAR = 48
const REMESH_NEAR_MS = 100
const REMESH_FAR_MS = 400
const REMESH_HIDDEN_MS = 3000
/** Without workers: the frame time re-meshing may take (it always does at least one). */
const REMESH_BUDGET_MS = 6
/** Below this the void hurts: four a half second until you die (Minecraft: 64 under the world). */
const VOID_Y = -64
/** Ticks of breath under water (fifteen seconds). */
export const AIR = 300
/** Seconds between hits while mining (Minecraft's six-tick swing): each swings the arm and makes a sound. */
const HIT_EVERY = 0.3
/** Minecraft's short pause after a block breaks before the next one starts. */
const BREAK_PAUSE = 0.25

export interface SkyfarmHud {
    locked: boolean
    coins: number
    selected: number
    hotbar: (ItemStack | null)[]
    /** Name of the block under the crosshair. */
    target: string | null
    /** Mining progress on that block, 0..1. */
    mining: number
    inWater: boolean
    /** Health, 0..20 (half hearts), and whether you just took a hit (the hearts blink). */
    health: number
    /** Armour points worn, 0..20 (the armour bar over the hearts). */
    armor: number
    hurt: boolean
    /** Breath left under water, 0..AIR; full means the bubbles are hidden. */
    air: number
    dead: boolean
    /** Potion effects on you, and how long they have left. */
    effects: { name: 'poison' | 'slowness' | 'weakness' | 'regeneration', seconds: number }[]
    /** Frames a second (smoothed), and the ms of work each frame takes: the dev display. */
    fps: number
    frameWork: number
}

export type SkyfarmPanel =
    | { kind: 'inventory' }
    | { kind: 'crafting' }
    | { kind: 'shop' }
    | { kind: 'container', x: number, y: number, z: number, sell: boolean, name?: string, cols?: number }
    | { kind: 'depot' }
    | { kind: 'furnace', x: number, y: number, z: number, name: string }
    | { kind: 'stonecutter' }
    | { kind: 'trading', mob: number }

export interface SkyfarmHooks {
    onHud: (hud: SkyfarmHud) => void
    /** The player opened a screen (E, a chest, the shop): the pointer is released for it. */
    onPanel: (panel: SkyfarmPanel) => void
    sound?: SoundHook
    /** The first click or key press: browsers only start audio after one. */
    onGesture?: () => void
    /** The tab slept a while (over a minute): what the island made meanwhile. */
    onAway?: (report: AwayReport) => void
}

/** A pause longer than this (the tab asleep) is caught up on rather than lost. */
const CATCH_UP_AFTER_MS = 2000

interface ChunkView {
    meshes: THREE.Mesh[]
    /** The chunk's light as of its last mesh, to light what moves through it. */
    light: LightField
}

export class SkyfarmEngine {
    readonly input: DfInput
    selected = 0
    private renderer: THREE.WebGLRenderer
    private scene = new THREE.Scene()
    private camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400)
    private materials: Record<'opaque' | 'cutout' | 'translucent', THREE.Material>
    private light = lightUniforms()
    private sky: Sky
    private rainSoundTimer = 0
    private looks: ItemLooks
    private crack: Crack
    private particles: Particles
    private drops: Drops
    private hand: Hand

    private views = new Map<string, ChunkView>()
    /** Mesh workers; the chunks out with one (by job), and when each chunk was last shown rebuilt. */
    private workers: Worker[] = []
    private meshing = new Map<string, number>()
    private meshedAt = new Map<string, number>()
    private jobCount = 0
    private frustum = new THREE.Frustum()
    private frustumMatrix = new THREE.Matrix4()
    private chunkBox = new THREE.Box3()
    private mobRender: MobRenderer
    /** The mob under the crosshair (nearer than any block), and when you last swung at one. */
    private mobHit: { mob: Mob, t: number } | null = null
    private lastAttack = -10
    private air = AIR
    /** Ticks left burning (after lava or fire), the highest point of the current fall, and the hurt tilt (1 to 0). */
    private burning = 0
    private fallPeak: number | null = null
    private hurtTilt = 0
    private deathShown = false
    private body: Body
    private yaw: number
    private pitch: number
    private highlight: THREE.LineSegments
    private border: THREE.LineSegments | null = null
    private borderCubes = -1
    private hit: Hit | null = null
    private mining = { key: '', progress: 0, hitTimer: 0, chipTimer: 0 }
    private placeCooldown = 0
    private breakCooldown = 0
    private stepDistance = 0
    private sneaking = false
    private sprinting = false
    /** Seconds since start, and when W was last pressed (double-tap to sprint). */
    private clock = 0
    private lastForward = -1
    /** Creative flight (development only): on, and when jump was last pressed (for the double tap). */
    private flying = false
    private lastJump = -10
    /** Eye height, eased between standing and sneaking. */
    private eye = EYE
    private tickAcc = 0
    private hudAcc = 0
    private raf = 0
    private last = 0
    private resizeObserver: ResizeObserver
    private pr = 1
    private prBounds: DfPrBounds = { min: 1, max: 1 }
    private frameMs = 16
    private goodTime = 0
    private prLocked = false
    private look = { x: 0, y: 0 }
    private disposed = false

    constructor(private readonly host: HTMLElement, readonly island: Island, private readonly pack: BlockPack, private readonly hooks: SkyfarmHooks) {
        // Blocks are lit by their baked light levels (see surface.ts), not by lamps in the scene.
        this.materials = {
            opaque: blockMaterial(pack, this.light),
            cutout: blockMaterial(pack, this.light, { cutout: true }),
            translucent: blockMaterial(pack, this.light, { translucent: true })
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
        this.renderer.setClearColor(0x78a7ff)
        // The hand is drawn over the world in a second pass.
        this.renderer.autoClear = false
        host.appendChild(this.renderer.domElement)
        this.renderer.domElement.style.display = 'block'

        this.scene.background = new THREE.Color(0x78a7ff)
        this.scene.fog = new THREE.Fog(0x78a7ff, 60, 180)
        const base = pack.base
        this.sky = new Sky(this.scene, { sun: `${base}/sky/sun.png`, moon: `${base}/sky/moon_phases.png`, clouds: `${base}/sky/clouds.png`, rain: `${base}/sky/rain.png` }, this.light)
        // Lightning, then thunder a moment later (sound is slower than light).
        this.sky.onLightning = () => setTimeout(() => this.sound('thunder', 0), 400 + randomFloat() * 1600)

        this.highlight = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
            new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6 })
        )
        this.highlight.visible = false
        this.scene.add(this.highlight)
        this.drawBorder()
        this.startMeshWorkers(pack)

        // What you hold and what lies on the ground is lit by the light where you stand.
        this.looks = new ItemLooks(pack, {
            opaque: blockMaterial(pack, this.light, { held: true }),
            cutout: blockMaterial(pack, this.light, { cutout: true, held: true })
        })
        this.crack = new Crack(pack, this.scene)
        this.particles = new Particles(pack, this.scene, island.world)
        this.drops = new Drops(this.looks, this.scene, island.world)
        this.hand = new Hand(this.looks)

        const p = island.player
        this.body = { x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false }
        this.yaw = p.yaw
        this.pitch = p.pitch

        this.input = new DfInput(this.renderer.domElement)
        this.input.onLockChange = () => this.pushHud()
        this.input.onGesture = () => this.hooks.onGesture?.()
        // What decaying leaves drop pops out into the world, to be picked up.
        island.onDrop = (x, y, z, stack) => this.drops.spawn(stack.item, x, y, z, stack.count)
        // Something catching fire whooshes, fainter the further away it is.
        island.sim.onIgnite = (x, y, z) => {
            this.sound('ignite', B.Fire, Math.hypot(x + 0.5 - this.body.x, y + 0.5 - this.body.y - EYE, z + 0.5 - this.body.z))
        }
        // A generator forming a block fizzes, fainter the further away it is.
        island.sim.onForm = (x, y, z, id) => {
            const d = Math.hypot(x + 0.5 - this.body.x, y + 0.5 - this.body.y - EYE, z + 0.5 - this.body.z)
            this.sound('fizz', id, d)
        }
        // Mobs: drawn with Minecraft's models; their hurts, fuses and bows are heard where they are.
        this.mobRender = new MobRenderer(this.scene, pack.base)
        island.onMobSound = (name, x, y, z, pitch) => this.sound(name, 0, this.distanceTo(x, y, z), pitch)
        // Hurt: the view jolts, you are knocked away from what hit you.
        island.onPlayerHurt = (_, fx, fz) => {
            this.hurtTilt = 1
            this.sound('hurt', 0)
            if (fx === null || fz === null) return
            const dx = this.body.x - fx, dz = this.body.z - fz
            const d = Math.hypot(dx, dz) || 1
            this.body.vx = this.body.vx / 2 + (dx / d) * 8
            this.body.vz = this.body.vz / 2 + (dz / d) * 8
            if (this.body.onGround) this.body.vy = 8
        }
        island.onExplode = (x, y, z, knock) => {
            this.sound('explode', 0, this.distanceTo(x, y, z))
            for (let i = 0; i < 6; i++) this.particles.breakBlock(B.Cobblestone, Math.floor(x + randomFloat() * 4 - 2), Math.floor(y + randomFloat() * 3 - 1), Math.floor(z + randomFloat() * 4 - 2))
            if (knock) {
                this.body.vx += Math.max(-15, Math.min(15, knock[0] * 20))
                this.body.vy += Math.max(-15, Math.min(15, knock[1] * 20))
                this.body.vz += Math.max(-15, Math.min(15, knock[2] * 20))
            }
        }

        this.resizeObserver = new ResizeObserver(() => this.resize())
        this.resizeObserver.observe(host)
        this.resize()

        if (import.meta.dev) (window as unknown as { __skyfarm?: SkyfarmEngine }).__skyfarm = this

        this.last = performance.now()
        this.raf = requestAnimationFrame(this.frame)
    }

    lock() {
        // Dead: the death screen stays up until you respawn.
        if (this.island.dead) return
        this.input.lock()
    }

    /** Back at the spawn point after dying, with full health and breath. */
    respawn() {
        this.island.respawn()
        const s = this.island.spawn
        Object.assign(this.body, { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, vz: 0 })
        this.air = AIR
        this.burning = 0
        this.fallPeak = null
        this.deathShown = false
        this.syncPlayer()
        this.pushHud()
        this.lock()
    }

    private distanceTo(x: number, y: number, z: number) {
        return Math.hypot(x - this.body.x, y - this.body.y - EYE, z - this.body.z)
    }

    /**
     * Where the player stands and looks, written back to the island for
     * saving. With `collectDrops` (leaving the page), items still lying around
     * go into the inventory first, so closing the tab never loses them.
     */
    syncPlayer(collectDrops = false) {
        Object.assign(this.island.player, { x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.yaw, pitch: this.pitch })
        if (collectDrops) for (const d of this.drops.take()) this.island.inventory.add(d.key, d.count)
    }

    private sound(name: Parameters<SoundHook>[0], id: number, distance = 0, pitch = 1) {
        this.hooks.sound?.(name, id, distance, pitch)
    }

    private resize() {
        const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight)
        this.prBounds = dfPixelRatioBounds(window.devicePixelRatio || 1, w, h, 'high')
        this.pr = this.prBounds.max
        this.renderer.setPixelRatio(this.pr)
        this.renderer.setSize(w, h, false)
        this.renderer.domElement.style.width = '100%'
        this.renderer.domElement.style.height = '100%'
        this.camera.aspect = w / h
        this.camera.updateProjectionMatrix()
    }

    private frame = (now: number) => {
        if (this.disposed) return
        this.raf = requestAnimationFrame(this.frame)
        // The browser paused us (a tab in the background): nothing ran meanwhile. Rather
        // than replay it, move the island on to where it would be (its known production).
        const gap = now - this.last
        if (gap > CATCH_UP_AFTER_MS) {
            this.last = now
            const report = this.island.catchUp(gap)
            this.pushHud()
            if (gap > 60_000) this.hooks.onAway?.(report)
        }
        const dt = Math.min(0.05, (now - this.last) / 1000)
        this.frameMs += ((now - this.last) - this.frameMs) * 0.1
        this.last = now
        this.clock += dt
        this.adaptResolution(dt)

        if (this.input.locked) this.control(dt)
        else this.mining.progress = 0

        // The island's clock runs whether or not you are looking. Mobs only come for
        // you while you are playing: paused (or on a screen), they leave you be.
        const playing = this.input.locked && !this.island.dead
        this.island.mobs.target = { x: this.body.x, y: this.body.y, z: this.body.z, active: playing, held: this.heldKey, health: this.island.health, effects: this.island.effects }
        this.tickAcc += dt
        const tick = 1 / TICKS_PER_SECOND
        const simStart = performance.now()
        while (this.tickAcc >= tick) {
            this.island.step()
            if (playing) this.playerTick()
            this.tickAcc -= tick
        }
        const remeshStart = performance.now()
        this.measure('sim', remeshStart - simStart)
        this.pack.tick(this.island.sim.tick)
        if (this.island.dead && !this.deathShown) {
            this.deathShown = true
            this.mining.progress = 0
            this.input.unlock()
            this.pushHud()
        }

        const meshed = this.remesh()
        this.measure('remesh', performance.now() - remeshStart)
        this.measure('meshes', meshed)
        this.measure('dirty', this.island.world.dirty.size)
        this.camera.position.set(this.body.x, this.body.y + this.eye, this.body.z)
        // A hit jolts the view sideways for a moment (Minecraft's hurt tilt).
        this.hurtTilt = Math.max(0, this.hurtTilt - dt * 2)
        this.camera.rotation.set(this.pitch, this.yaw, -Math.sin(this.hurtTilt ** 4 * Math.PI) * (14 * Math.PI / 180), 'YXZ')
        this.camera.updateMatrixWorld()
        this.sky.update(dt, { dayTime: this.island.dayTime, day: this.island.day, weather: this.island.weather.kind }, this.camera, (x, z) => this.topAt(x, z))
        this.lightPlayer()
        this.rainSound(dt)
        this.updateTarget()

        const middle = new THREE.Vector3(this.body.x, this.body.y + 0.9, this.body.z)
        this.drops.update(dt, middle, (key, count) => this.island.inventory.add(key, count), () => this.sound('pop', 0))
        this.particles.update(dt, this.camera)
        this.mobRender.update(this.island.mobs, this.tickAcc * TICKS_PER_SECOND, dt, (x, y, z) => this.brightnessAt(x, y, z))
        this.hand.setHeld(this.heldKey)
        this.hand.update(dt, this.body.onGround ? Math.hypot(this.body.vx, this.body.vz) : 0)

        const renderStart = performance.now()
        this.renderer.clear()
        this.renderer.render(this.scene, this.camera)
        this.hand.render(this.renderer, this.camera.aspect)
        this.measure('render', performance.now() - renderStart)
        this.measure('frame', performance.now() - now)

        this.hudAcc += dt
        if (this.hudAcc > 0.1) {
            this.hudAcc = 0
            this.pushHud()
        }
        this.input.endFrame()
    }

    private adaptResolution(dt: number) {
        if (this.frameMs < 19.5) this.goodTime += dt
        else this.goodTime = 0
        const next = dfAdaptivePixelRatio(this.pr, this.frameMs, this.prBounds, this.goodTime, this.prLocked)
        if (next === this.pr) return
        if (next < this.pr) this.prLocked = true
        this.goodTime = 0
        this.pr = next
        this.renderer.setPixelRatio(next)
        this.renderer.setSize(this.host.clientWidth, this.host.clientHeight, false)
    }

    private control(dt: number) {
        const inp = this.input
        inp.takeLook(this.look)
        this.yaw -= this.look.x * LOOK_SPEED
        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - this.look.y * LOOK_SPEED))

        // Hotbar: number keys and the wheel.
        for (let i = 0; i < HOTBAR; i++) if (inp.pressed(`Digit${i + 1}`)) this.selected = i
        if (inp.wheel) this.selected = (this.selected + Math.sign(inp.wheel) + HOTBAR) % HOTBAR

        if (inp.pressed('KeyE')) return this.open({ kind: 'inventory' })
        if (inp.pressed('KeyB')) return this.open({ kind: 'shop' })

        let fx = 0, fz = 0
        if (inp.has('KeyW')) fz -= 1
        if (inp.has('KeyS')) fz += 1
        if (inp.has('KeyA')) fx -= 1
        if (inp.has('KeyD')) fx += 1
        // Slowness (a witch's potion) takes 15% off your speed.
        const len = (Math.hypot(fx, fz) || 1) / (this.island.effects.slowness > 0 ? 0.85 : 1)
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw)
        const wish: [number, number] = [(fx * c + fz * s) / len, (-fx * s + fz * c) / len]
        const bx = this.body.x, bz = this.body.z
        // Shift sneaks (slow, and keeps you on the edge of a block). Double-tapping W
        // sprints until you let go: not Ctrl, because Ctrl+W closes the tab on Windows and Linux.
        this.sneaking = inp.has('ShiftLeft') || inp.has('ShiftRight')
        if (inp.pressed('KeyW')) {
            if (this.clock - this.lastForward < 0.3) this.sprinting = true
            this.lastForward = this.clock
        }
        if (!inp.has('KeyW') || this.sneaking) this.sprinting = false
        // Development only: double-tap jump to fly, as in Minecraft's creative mode (and again to stop).
        if (import.meta.dev && inp.pressed('Space')) {
            if (this.clock - this.lastJump < 0.3) {
                this.flying = !this.flying
                this.lastJump = -10
            } else {
                this.lastJump = this.clock
            }
        }
        stepBody(this.island.world, this.body, dt, wish, inp.has('Space'), this.sprinting, this.sneaking, this.flying)
        // Coming down onto the ground ends a flight; a flight never ends in a fall.
        if (this.flying && this.body.onGround) this.flying = false
        if (this.flying) this.fallPeak = null
        this.eye += ((this.sneaking ? SNEAK_EYE : EYE) - this.eye) * Math.min(1, dt * 14)
        this.fallDamage()
        this.footsteps(Math.hypot(this.body.x - bx, this.body.z - bz))

        this.breakCooldown -= dt
        this.placeCooldown -= dt
        this.mine(dt)
        if (inp.has('Mouse2') && this.placeCooldown <= 0) {
            this.use(inp.pressed('Mouse2'))
            this.placeCooldown = 0.22
        }
        if (!inp.has('Mouse2')) this.placeCooldown = 0
    }

    /** Landing from more than three blocks up hurts a point per block over (water breaks the fall). */
    private fallDamage() {
        const b = this.body
        if (b.inWater) {
            this.fallPeak = null
            return
        }
        if (!b.onGround) {
            this.fallPeak = Math.max(this.fallPeak ?? b.y, b.y)
            return
        }
        if (this.fallPeak !== null && this.fallPeak - b.y > 3) this.island.hurtPlayer(Math.ceil(this.fallPeak - b.y - 3))
        this.fallPeak = null
    }

    /**
     * What hurts you each tick: lava and fire (and burning on after them),
     * running out of breath under water, and the void.
     */
    private playerTick() {
        const b = this.body
        const w = this.island.world
        const at = (dy: number) => w.get(Math.floor(b.x), Math.floor(b.y + dy), Math.floor(b.z))
        const feet = at(0.1), middle = at(0.9), head = at(this.eye)
        if (feet === B.Lava || middle === B.Lava) {
            this.island.hurtPlayer(4)
            this.burning = 300
        } else if (feet === B.Fire || middle === B.Fire) {
            this.island.hurtPlayer(1)
            this.burning = Math.max(this.burning, 160)
        }
        const underSky = this.topAt(Math.floor(b.x), Math.floor(b.z)) < b.y + this.eye
        if (b.inWater || (this.island.weather.kind !== 'clear' && underSky)) this.burning = 0
        if (this.burning > 0 && --this.burning % 20 === 0) this.island.hurtPlayer(1)
        // Fifteen seconds of breath, then two damage a second; it comes back four times as fast.
        if (head === B.Water) {
            if (--this.air <= -20) {
                this.air = 0
                this.island.hurtPlayer(2)
            }
        } else {
            this.air = Math.min(AIR, this.air + 4)
        }
        if (b.y < VOID_Y) this.island.hurtPlayer(4)
    }

    /** Hits the mob under the crosshair: Minecraft's attack strength, crits while falling, a harder knock while sprinting. */
    private attack(mob: Mob) {
        const stats = attackStats(this.heldKey)
        const ticks = (this.clock - this.lastAttack) * TICKS_PER_SECOND
        const strength = Math.max(0, Math.min(1, (ticks + 0.5) / (TICKS_PER_SECOND / stats.speed)))
        // Weakness takes 4 off every blow.
        const base = Math.max(0, stats.damage - (this.island.effects.weakness > 0 ? 4 : 0))
        let damage = base * (0.2 + strength * strength * 0.8)
        const b = this.body
        if (strength > 0.9 && b.vy < 0 && !b.onGround && !b.inWater) damage *= 1.5
        this.lastAttack = this.clock
        this.hand.swing()
        this.island.mobs.hurt(mob, damage, { x: b.x, z: b.z }, true, strength > 0.9 && this.sprinting ? 0.9 : 0.4)
    }

    /** How bright it is at a block (0..1): sky light by the time of day, or block light, as the shader works it out. */
    private brightnessAt(x: number, y: number, z: number) {
        const [sky, glow] = this.lightAt(x, y, z)
        const curve = (l: number) => l / ((1 - l) * 3 + 1)
        return Math.max(curve(sky / MAX_LIGHT) * this.light.uSfDay.value, curve(glow / MAX_LIGHT), 0.06)
    }

    /** A footstep every 1.7 blocks walked on the ground, in the sound of the block underfoot. */
    private footsteps(moved: number) {
        if (!this.body.onGround) return
        this.stepDistance += moved
        if (this.stepDistance < 1.7) return
        this.stepDistance = 0
        this.sound('step', this.island.world.get(Math.floor(this.body.x), Math.floor(this.body.y - 0.1), Math.floor(this.body.z)))
    }

    /** Tosses items out in front of the player (what didn't fit back in the inventory). */
    throwItems(key: string, count: number) {
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw)
        this.drops.spawn(key, Math.floor(this.body.x + fx), Math.floor(this.body.y + 1), Math.floor(this.body.z + fz), count)
    }

    private open(panel: SkyfarmPanel) {
        this.input.unlock()
        this.hooks.onPanel(panel)
    }

    private get heldKey() {
        return this.island.inventory.slots[this.selected]?.item ?? null
    }

    private updateTarget() {
        const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
        const eye = this.camera.position
        this.hit = this.input.locked ? pick(this.island.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, REACH) : null
        // A mob in front of the block you look at takes the click instead.
        this.mobHit = this.input.locked ? this.island.mobs.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, ENTITY_REACH) : null
        if (this.mobHit && this.hit) {
            const d = Math.hypot(this.hit.px - eye.x, this.hit.py - eye.y, this.hit.pz - eye.z)
            if (d < this.mobHit.t) this.mobHit = null
            else this.hit = null
        }
        const h = this.hit
        this.highlight.visible = !!h
        if (h) this.highlight.position.set(h.x + 0.5, h.y + 0.5, h.z + 0.5)
        this.crack.update(h, this.mining.progress)
    }

    private mine(dt: number) {
        if (this.mobHit && this.input.pressed('Mouse0')) {
            this.attack(this.mobHit.mob)
            this.mining.progress = 0
            return
        }
        const h = this.hit
        if (!this.input.has('Mouse0') || !h) {
            this.mining.progress = 0
            this.mining.hitTimer = 0
            // A click at nothing still swings.
            if (this.input.pressed('Mouse0')) this.hand.swing()
            return
        }
        if (this.breakCooldown > 0) return
        const key = `${h.x},${h.y},${h.z},${h.id},${this.selected}`
        if (key !== this.mining.key) this.mining = { key, progress: 0, hitTimer: 0, chipTimer: 0 }
        const { seconds } = this.island.breakTime(h.x, h.y, h.z, this.heldKey)

        // Every hit: a swing and a dig sound. A chip comes off the face every game tick.
        this.mining.hitTimer -= dt
        if (this.mining.hitTimer <= 0) {
            this.mining.hitTimer = HIT_EVERY
            this.hand.swing()
            this.sound('dig', h.id)
        }
        this.mining.chipTimer -= dt
        while (this.mining.chipTimer <= 0) {
            this.mining.chipTimer += 1 / TICKS_PER_SECOND
            this.particles.hit(h.id, h)
        }
        if (!Number.isFinite(seconds)) return
        this.mining.progress += dt / seconds
        if (this.mining.progress >= 1) {
            const id = h.id
            const drops = this.island.breakBlock(h.x, h.y, h.z, this.heldKey, false)
            this.island.built()
            // The satisfying bit: the block bursts into chips and its drops pop out.
            this.particles.breakBlock(id, h.x, h.y, h.z)
            for (const d of drops) this.drops.spawn(d.item, h.x, h.y, h.z, d.count)
            this.sound('break', id)
            this.mining = { key: '', progress: 0, hitTimer: 0, chipTimer: 0 }
            this.breakCooldown = BREAK_PAUSE
        }
    }

    /** Right click: open a chest, table or furnace, use a bucket, or place the held block. */
    private use(fresh: boolean) {
        const h = this.hit
        const held = this.heldKey
        // Sneaking places against a chest or table instead of opening it, as in Minecraft.
        if (h && fresh && h.id === B.CraftingTable && !this.sneaking) {
            this.hand.swing()
            return this.open({ kind: 'crafting' })
        }
        if (h && fresh && (h.id === B.Chest || h.id === B.SellChest) && !this.sneaking) {
            this.hand.swing()
            this.sound('chestOpen', h.id)
            return this.open({ kind: 'container', x: h.x, y: h.y, z: h.z, sell: h.id === B.SellChest })
        }
        if (h && fresh && FURNACES.has(h.id) && !this.sneaking) {
            this.hand.swing()
            return this.open({ kind: 'furnace', x: h.x, y: h.y, z: h.z, name: block(h.id).name })
        }
        // Redstone: flip a lever, press a button, set a repeater's delay.
        if (h && fresh && !this.sneaking && (h.id === B.Lever || h.id === B.Button || h.id === B.Repeater)) {
            this.hand.swing()
            if (h.id === B.Lever) this.island.redstone.toggleLever(h.x, h.y, h.z)
            else if (h.id === B.Button) this.island.redstone.pressButton(h.x, h.y, h.z)
            else this.island.redstone.cycleRepeater(h.x, h.y, h.z)
            this.sound('click', 0)
            return
        }
        if (h && fresh && !this.sneaking && (h.id === B.Hopper || h.id === B.Dropper || h.id === B.Dispenser)) {
            this.hand.swing()
            return this.open({ kind: 'container', x: h.x, y: h.y, z: h.z, sell: false, name: block(h.id).name, cols: h.id === B.Hopper ? 5 : 3 })
        }
        if (h && fresh && h.id === B.Depot && !this.sneaking) {
            this.hand.swing()
            return this.open({ kind: 'depot' })
        }
        if (h && fresh && h.id === B.Barrel && !this.sneaking) {
            this.hand.swing()
            this.sound('chestOpen', h.id)
            return this.open({ kind: 'container', x: h.x, y: h.y, z: h.z, sell: false, name: 'Barrel' })
        }
        if (h && fresh && h.id === B.Stonecutter && !this.sneaking) {
            this.hand.swing()
            return this.open({ kind: 'stonecutter' })
        }
        // A composter: take the bone meal out when it is full, else drop in what you hold.
        if (h && fresh && h.id === B.Composter && !this.sneaking) {
            if (this.island.emptyComposter(h.x, h.y, h.z)) {
                this.hand.swing()
                this.sound('place', B.Grass)
                return
            }
            const r = this.island.compost(this.selected, h.x, h.y, h.z)
            if (r.used) {
                this.hand.swing()
                this.sound(r.rose ? 'place' : 'step', B.Grass)
                return
            }
        }
        // A villager with a trade: right click trades with it (it stops to deal with you).
        const villager = this.mobHit?.mob
        if (fresh && villager?.kind === 'villager' && villager.offers.length && held !== 'golden_apple' && !held?.startsWith('splash_potion_')) {
            this.island.mobs.trader = villager.id
            return this.open({ kind: 'trading', mob: villager.id })
        }
        // Shears or a dye on the sheep you look at.
        const sheep = this.mobHit?.mob
        if (fresh && sheep?.kind === 'sheep' && held && (held === 'shears' || held.endsWith('_dye'))) {
            const done = held === 'shears' ? this.island.shearSheep(this.selected, sheep) : this.island.dyeSheep(this.selected, sheep)
            if (done) {
                this.hand.swing()
                this.sound('place', B.WhiteWool)
            }
            return
        }
        // A golden apple: to the zombie villager you look at (to cure it), else you eat it.
        if (held === 'golden_apple' && fresh) {
            const used = this.mobHit ? this.island.feedGoldenApple(this.selected, this.mobHit.mob).used : this.island.eatGoldenApple(this.selected)
            if (used) {
                this.hand.swing()
                this.sound('drink', 0)
            }
            return
        }
        // A splash potion: thrown (Minecraft aims it 20 degrees above your line of sight).
        if (held?.startsWith('splash_potion_') && fresh) {
            const up = Math.min(Math.PI / 2, this.pitch + (20 * Math.PI) / 180)
            const dx = -Math.sin(this.yaw) * Math.cos(up), dy = Math.sin(up), dz = -Math.cos(this.yaw) * Math.cos(up)
            if (this.island.throwPotion(this.selected, this.body.x, this.body.y + this.eye - 0.1, this.body.z, dx, dy, dz)) {
                this.hand.swing()
                this.sound('bow', 0)
            }
            return
        }
        // Armour in hand: right click puts it on (swapping out what was worn).
        if (held && fresh && item(held).armor) {
            if (this.island.equip(this.selected)) {
                this.hand.swing()
                this.sound('step', B.WhiteWool)
                this.pushHud()
            }
            return
        }
        if (held === 'bucket' || held === 'water_bucket' || held === 'lava_bucket') {
            if (!fresh) return
            const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation)
            const eye = this.camera.position
            const fh = pick(this.island.world, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, REACH, true)
            if (fh && this.island.useBucket(this.selected, fh)) {
                this.island.built()
                this.hand.swing()
                // Water splashes; lava has no sound of its own in the pack, and fizzes.
                const water = held === 'water_bucket' || fh.id === B.Water
                this.sound(water ? 'splash' : 'fizz', fh.id)
            }
            return
        }
        // A hoe tills, bone meal makes things grow.
        if (h && held && fresh && (item(held).tool?.kind === 'hoe' || held === 'bone_meal')) {
            if (this.island.useItem(this.selected, h)) {
                this.island.built()
                this.hand.swing()
                this.sound(held === 'bone_meal' ? 'place' : 'step', held === 'bone_meal' ? B.Grass : B.Dirt)
                // A puff of green where the bone meal landed.
                if (held === 'bone_meal') this.particles.breakBlock(B.TallGrass, h.x, h.y + 1, h.z)
            }
            return
        }
        if (!h || !held || item(held).places === undefined) return
        const places = item(held).places!
        if (this.island.placeAgainst(this.selected, h, (x, y, z, id, meta) => this.bodyOverlaps(x, y, z, id, meta), this.yaw, this.pitch)) {
            this.island.built()
            this.hand.swing()
            this.sound('place', places)
        }
    }

    /** Whether a block placed at (x, y, z) would be inside the player (only its solid part counts: a slab is half a cell). */
    private bodyOverlaps(x: number, y: number, z: number, id: number, meta: number) {
        const r = solidRange(id, meta)
        if (!r) return false
        const b = this.body
        return b.x + HALF_WIDTH > x && b.x - HALF_WIDTH < x + 1
            && b.y + BODY_HEIGHT > y + r[0] && b.y < y + r[1]
            && b.z + HALF_WIDTH > z && b.z - HALF_WIDTH < z + 1
    }

    /**
     * The edge of your land: a faint grid on every face of an owned cube that
     * opens onto a cube you don't own, so you can see where building stops.
     * Rebuilt when you buy a cube.
     */
    private drawBorder() {
        const cubes = this.island.world.cubes
        if (this.border && this.borderCubes === cubes.size) return
        this.borderCubes = cubes.size
        if (this.border) {
            this.scene.remove(this.border)
            this.border.geometry.dispose()
        }
        const pts: number[] = []
        const at = (a: number, p: number, u: number, v: number) => {
            const out = [0, 0, 0]
            out[a] = p
            out[(a + 1) % 3] = u
            out[(a + 2) % 3] = v
            return out
        }
        for (const key of cubes) {
            const c = key.split(',').map(Number)
            for (let a = 0; a < 3; a++) {
                for (const s of [-1, 1]) {
                    const n = [...c]
                    n[a]! += s
                    if (cubes.has(n.join(','))) continue
                    const p = (c[a]! + (s > 0 ? 1 : 0)) * CHUNK + s * 0.02
                    const u0 = c[(a + 1) % 3]! * CHUNK, v0 = c[(a + 2) % 3]! * CHUNK
                    for (let t = 0; t <= CHUNK; t += 4) {
                        pts.push(...at(a, p, u0 + t, v0), ...at(a, p, u0 + t, v0 + CHUNK))
                        pts.push(...at(a, p, u0, v0 + t), ...at(a, p, u0 + CHUNK, v0 + t))
                    }
                }
            }
        }
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
        this.border = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.14, depthWrite: false }))
        this.scene.add(this.border)
    }

    /**
     * Where each frame's time goes, smoothed (ms; meshes and dirty are counts):
     * the simulation, re-meshing changed chunks, drawing, and the whole frame's
     * own work. For development (read it from window.__skyfarm.perf).
     */
    readonly perf = { sim: 0, remesh: 0, meshes: 0, dirty: 0, render: 0, frame: 0 }

    private measure(what: keyof SkyfarmEngine['perf'], value: number) {
        this.perf[what] += (value - this.perf[what]) * 0.05
    }

    /**
     * Rebuilds the meshes of changed chunks; returns how many it started.
     * Building one (its light and faces) takes ~20 ms, so it happens in
     * workers when the browser has them, and the frame only swaps the result
     * in. Which go first: chunks never drawn, then what is in view, nearest
     * first. A chunk that keeps changing (a piston clock) is rebuilt at most
     * every so often, more often when near; one out of view waits longest. It
     * still simulates in full meanwhile: only its picture is left as it was,
     * until you look its way.
     */
    private remesh(): number {
        this.drawBorder()
        const world = this.island.world
        if (!world.dirty.size) return 0
        const now = performance.now()
        const cam = this.camera
        this.frustum.setFromProjectionMatrix(this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
        const wanted: { key: string, cx: number, cz: number, score: number }[] = []
        for (const key of world.dirty) {
            if (this.meshing.has(key)) continue
            const chunk = world.chunks.get(key)
            if (!chunk) {
                world.dirty.delete(key)
                this.dropView(key)
                continue
            }
            const x0 = chunk.cx * CHUNK, z0 = chunk.cz * CHUNK
            const dist = Math.hypot(x0 + CHUNK / 2 - this.body.x, z0 + CHUNK / 2 - this.body.z)
            this.chunkBox.min.set(x0, 0, z0)
            this.chunkBox.max.set(x0 + CHUNK, WORLD_HEIGHT, z0 + CHUNK)
            const inView = dist < CHUNK * 1.5 || this.frustum.intersectsBox(this.chunkBox)
            const drawn = this.views.has(key)
            const wait = !drawn ? 0 : !inView ? REMESH_HIDDEN_MS : dist < REMESH_NEAR ? REMESH_NEAR_MS : REMESH_FAR_MS
            if (now - (this.meshedAt.get(key) ?? -Infinity) < wait) continue
            wanted.push({ key, cx: chunk.cx, cz: chunk.cz, score: (drawn ? 0 : -1e6) + (inView ? 0 : 1e5) + dist })
        }
        wanted.sort((a, b) => a.score - b.score)
        let started = 0
        if (this.workers.length) {
            for (const w of wanted) {
                if (this.meshing.size >= this.workers.length * JOBS_PER_WORKER) break
                world.dirty.delete(w.key)
                this.sendMeshJob(w.key, w.cx, w.cz)
                started++
            }
            return started
        }
        // No workers: build here, as many as fit the frame's budget (at least one).
        for (const w of wanted) {
            if (started > 0 && performance.now() - now > REMESH_BUDGET_MS) break
            world.dirty.delete(w.key)
            const data = meshChunk(world, world.chunks.get(w.key)!, this.pack)
            this.showMesh(w.key, data, data.light)
            started++
        }
        return started
    }

    /** Starts the mesh workers and gives them the pack's model data (none where the browser has no workers). */
    private startMeshWorkers(pack: BlockPack) {
        if (typeof Worker === 'undefined') return
        const data = { looks: pack.looks, layer: pack.layer, anim: pack.anim, models: pack.models }
        for (let i = 0; i < MESH_WORKERS; i++) {
            try {
                const worker = new Worker(new URL('./mesh-worker.ts', import.meta.url), { type: 'module' })
                worker.onmessage = (e: MessageEvent<MeshResult>) => this.meshArrived(e.data)
                worker.onerror = () => this.stopMeshWorkers()
                worker.postMessage({ type: 'pack', pack: data })
                this.workers.push(worker)
            } catch {
                break
            }
        }
    }

    /** A worker failed: carry on meshing here, and redo what was out with them. */
    private stopMeshWorkers() {
        for (const w of this.workers) w.terminate()
        this.workers = []
        for (const key of this.meshing.keys()) this.island.world.dirty.add(key)
        this.meshing.clear()
    }

    /** Hands a chunk to a mesh worker: it and its neighbours' blocks (copied: the island moves on meanwhile). */
    private sendMeshJob(key: string, cx: number, cz: number) {
        const columns: MeshJob['columns'] = []
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const c = this.island.world.chunks.get(`${cx + dx},${cz + dz}`)
                if (c) columns.push({ cx: c.cx, cz: c.cz, blocks: c.blocks.slice(), meta: c.meta.slice() })
            }
        }
        const job = ++this.jobCount
        this.meshing.set(key, job)
        const worker = this.workers[job % this.workers.length]!
        worker.postMessage({ type: 'mesh', job, cx, cz, columns } satisfies MeshJob, columns.flatMap(c => [c.blocks.buffer, c.meta.buffer]))
    }

    /** A worker's mesh came back: show it (unless the chunk is gone, or a newer job for it is out). */
    private meshArrived(r: MeshResult) {
        const key = `${r.cx},${r.cz}`
        if (this.disposed || this.meshing.get(key) !== r.job) return
        this.meshing.delete(key)
        if (!this.island.world.chunks.has(key)) return
        const light = new LightField(r.cx, r.cz)
        light.sky.set(r.sky)
        light.block.set(r.block)
        this.showMesh(key, r, light)
    }

    private showMesh(key: string, data: Pick<ChunkMeshes, 'opaque' | 'cutout' | 'translucent'>, light: LightField) {
        this.dropView(key)
        const meshes: THREE.Mesh[] = []
        for (const pass of ['opaque', 'cutout', 'translucent'] as const) {
            if (data[pass].index.length === 0) continue
            const mesh = new THREE.Mesh(geometryOf(data[pass]), this.materials[pass])
            mesh.renderOrder = pass === 'translucent' ? 2 : 0
            this.scene.add(mesh)
            meshes.push(mesh)
        }
        this.views.set(key, { meshes, light })
        this.meshedAt.set(key, performance.now())
    }

    private dropView(key: string) {
        const old = this.views.get(key)
        if (!old) return
        for (const m of old.meshes) {
            this.scene.remove(m)
            m.geometry.dispose()
        }
        this.views.delete(key)
    }

    /** Sky and block light at a block (0..15), from its chunk's last mesh; open sky where nothing is known. */
    lightAt(x: number, y: number, z: number): [number, number] {
        const view = this.views.get(`${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`)
        return view ? view.light.at(x, y, z) : [MAX_LIGHT, 0]
    }

    /** The highest block in a column (rain stops on it); -1 for open void. */
    private topAt(x: number, z: number) {
        if (!this.island.world.owns(Math.floor(x / CHUNK), Math.floor(z / CHUNK))) return -1
        for (let y = 63; y >= 0; y--) if (this.island.world.get(x, y, z) !== B.Air) return y
        return -1
    }

    /**
     * The light where the player stands lights what they hold, what lies about
     * and the chips that fly: as bright as Minecraft's curve makes it.
     */
    private lightPlayer() {
        const [sky, glow] = this.lightAt(Math.floor(this.body.x), Math.floor(this.body.y + 1), Math.floor(this.body.z))
        this.light.uSfHeld.value.set(sky / MAX_LIGHT, glow / MAX_LIGHT)
        const curve = (l: number) => l / ((1 - l) * 3 + 1)
        const bright = Math.max(curve(sky / MAX_LIGHT) * this.light.uSfDay.value, curve(glow / MAX_LIGHT), 0.06)
        this.hand.setBrightness(bright)
        this.particles.setBrightness(bright)
        this.looks.setBrightness(bright)
    }

    /** Rain patters while it rains (quieter under a roof). */
    private rainSound(dt: number) {
        const wet = this.sky.rainAmount
        if (wet < 0.05) return
        this.rainSoundTimer -= dt
        if (this.rainSoundTimer > 0) return
        this.rainSoundTimer = 0.25 + randomFloat() * 0.35
        const covered = this.topAt(Math.floor(this.body.x), Math.floor(this.body.z)) > this.body.y + 1
        this.sound('rain', 0, covered ? 9 : 2 + (1 - wet) * 12)
    }

    private pushHud() {
        const h = this.hit
        this.hooks.onHud({
            locked: this.input.locked,
            coins: this.island.coins,
            selected: this.selected,
            hotbar: this.island.inventory.slots.slice(0, HOTBAR).map(s => (s ? { ...s } : null)),
            target: h ? block(h.id).name : null,
            mining: this.mining.progress,
            inWater: this.body.inWater,
            health: this.island.health,
            armor: this.island.armorPoints,
            hurt: this.hurtTilt > 0.5,
            air: this.air,
            dead: this.island.dead,
            effects: (Object.entries(this.island.effects) as [keyof typeof this.island.effects, number][])
                .filter(([, t]) => t > 0).map(([name, t]) => ({ name, seconds: Math.ceil(t / TICKS_PER_SECOND) })),
            fps: this.frameMs > 0 ? 1000 / this.frameMs : 0,
            frameWork: this.perf.frame
        })
    }

    /** The chunk the player stands in (the land map marks it). */
    /** Where you stand (your feet). */
    get position() {
        return { x: this.body.x, y: this.body.y, z: this.body.z }
    }

    dispose() {
        this.disposed = true
        cancelAnimationFrame(this.raf)
        this.island.sim.onForm = null
        this.island.sim.onIgnite = null
        this.island.onDrop = null
        this.island.onPlayerHurt = null
        this.island.onExplode = null
        this.island.onMobSound = null
        this.island.mobs.target = null
        this.mobRender.dispose()
        this.syncPlayer(true)
        this.resizeObserver.disconnect()
        this.input.dispose()
        for (const w of this.workers) w.terminate()
        this.workers = []
        for (const v of this.views.values()) for (const m of v.meshes) m.geometry.dispose()
        this.particles.dispose()
        this.sky.dispose()
        this.crack.dispose()
        this.hand.dispose()
        this.looks.dispose()
        for (const m of Object.values(this.materials)) m.dispose()
        this.pack.texture.dispose()
        this.highlight.geometry.dispose()
        this.renderer.dispose()
        this.renderer.domElement.remove()
        if (import.meta.dev) delete (window as unknown as { __skyfarm?: SkyfarmEngine }).__skyfarm
    }
}
