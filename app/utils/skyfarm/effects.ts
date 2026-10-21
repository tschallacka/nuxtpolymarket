import * as THREE from 'three'
import { randomFloat } from '#shared/utils/random'
import { block } from './blocks'
import { item } from './items'
import { meshBlock, type MeshData } from './mesher'
import type { BlockPack } from './pack'
import type { SkyfarmSound } from './sounds'
import type { World } from './world'

/*
 * Everything that makes mining feel like mining: the crack creeping over the
 * block, chips flying off it, the drop popping out and flying to you, and the
 * arm in the corner of the screen swinging away. Purely visual (and audible):
 * none of it changes the island.
 */

/** Plays a sound for a block (`id`), `distance` blocks from the player (see sounds.ts). */
export type SoundHook = (sound: SkyfarmSound, id: number, distance?: number, pitch?: number) => void

/** Cosmetic randomness: where chips fly, which way a drop hops. */
const rand = (a: number, b: number) => a + randomFloat() * (b - a)

function geometryOf(d: MeshData) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(d.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3))
    g.setAttribute('color', new THREE.BufferAttribute(d.color, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2))
    g.setAttribute('layer', new THREE.BufferAttribute(d.layer, 1))
    g.setAttribute('anim', new THREE.BufferAttribute(d.anim, 1))
    g.setAttribute('light', new THREE.BufferAttribute(d.light, 2))
    g.setIndex(new THREE.BufferAttribute(d.index, 1))
    g.computeBoundingSphere()
    return g
}

export { geometryOf }

export interface BlockMaterials {
    opaque: THREE.Material
    cutout: THREE.Material
}

// ── Item looks ─────────────────────────────────────────────────────────

/**
 * How an item looks in the world or in your hand, about one unit across and
 * centred: a block is its model, anything else a flat sprite of its icon.
 */
export class ItemLooks {
    private blockGeo = new Map<number, THREE.BufferGeometry>()
    private sprites = new Map<string, THREE.Material>()
    private loader = new THREE.TextureLoader()
    private spriteGeo = new THREE.PlaneGeometry(1, 1)

    constructor(private readonly pack: BlockPack, private readonly materials: BlockMaterials) {
        // Load every item icon up front, so the first time you hold one it isn't blank while its image loads.
        for (const key of Object.keys(pack.json.icons)) this.spriteMaterial(key)
    }

    make(key: string): THREE.Object3D {
        const places = item(key).places
        const icon = this.pack.icon(key)
        // A block that places itself shows as the block; seeds and redstone show their icon.
        if (places !== undefined && (!icon || !('flat' in icon) || block(places).key === key)) {
            let g = this.blockGeo.get(places)
            if (!g) {
                g = geometryOf(meshBlock(this.pack, places))
                g.translate(-0.5, -0.5, -0.5)
                this.blockGeo.set(places, g)
            }
            const group = new THREE.Group()
            group.add(new THREE.Mesh(g, this.materials.cutout))
            return group
        }
        // A flat item is its icon with a pixel of thickness, as in Minecraft: front and
        // back faces, plus a side wall along every edge where a pixel meets a clear one.
        const group = new THREE.Group()
        const material = this.spriteMaterial(key)
        for (const z of [ITEM_DEPTH, -ITEM_DEPTH]) {
            const face = new THREE.Mesh(this.spriteGeo, material)
            face.position.z = z
            group.add(face)
        }
        void this.extrusion(key).then((geo) => {
            if (geo) group.add(new THREE.Mesh(geo, this.sideMaterial))
        })
        group.userData.sprite = true
        return group
    }

    private sideMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    private sides = new Map<string, Promise<THREE.BufferGeometry | null>>()

    /** The side walls of an item's 1-pixel-thick extrusion, built from its icon's pixels. */
    private extrusion(key: string) {
        let p = this.sides.get(key)
        if (!p) {
            const icon = this.pack.icon(key)
            const url = icon && 'flat' in icon ? icon.flat : null
            p = url ? extrude(url) : Promise.resolve(null)
            this.sides.set(key, p)
        }
        return p
    }

    private spriteMaterial(key: string) {
        let m = this.sprites.get(key)
        if (!m) {
            const icon = this.pack.icon(key)
            const url = icon && 'flat' in icon ? icon.flat : icon ? icon.side : null
            const tex = url ? this.loader.load(url) : null
            if (tex) {
                tex.colorSpace = THREE.SRGBColorSpace
                tex.magFilter = THREE.NearestFilter
                tex.minFilter = THREE.NearestFilter
                tex.generateMipmaps = false
                // Animated strips: show the first frame.
                tex.repeat.set(1, 1)
            }
            // Unlit, as Minecraft draws items: a lit flat sprite goes black whenever the sun is behind it.
            m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, color: tex ? 0xffffff : item(key).color })
            this.sprites.set(key, m)
        }
        return m
    }

    /** Flat items (tools, buckets) dim with the light around the player; blocks are lit by their material. */
    setBrightness(b: number) {
        for (const m of this.sprites.values()) (m as THREE.MeshBasicMaterial).color.setScalar(b)
        this.sideMaterial.color.setScalar(b)
    }

    dispose() {
        for (const g of this.blockGeo.values()) g.dispose()
        for (const m of this.sprites.values()) {
            ;(m as THREE.MeshBasicMaterial).map?.dispose()
            m.dispose()
        }
        for (const p of this.sides.values()) void p.then(g => g?.dispose())
        this.spriteGeo.dispose()
        this.sideMaterial.dispose()
    }
}

/** Half an item's thickness: one pixel of a 16-pixel icon, front to back. */
const ITEM_DEPTH = 1 / 32

/** Builds the side walls of an icon's extrusion (in a unit square centred on the origin). */
async function extrude(url: string): Promise<THREE.BufferGeometry | null> {
    const img = new Image()
    img.src = url
    try {
        await img.decode()
    } catch {
        return null
    }
    const w = img.width, h = Math.min(img.width, img.height)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, w, h).data
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && px[(y * w + x) * 4 + 3]! >= 128
    const pos: number[] = [], col: number[] = [], idx: number[] = []
    const quad = (a: number[], b: number[], c: number[], d: number[], rgb: number[]) => {
        const base = pos.length / 3
        pos.push(...a, ...b, ...c, ...d)
        for (let i = 0; i < 4; i++) col.push(...rgb)
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    const t = ITEM_DEPTH
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!solid(x, y)) continue
            const i = (y * w + x) * 4
            // The pixel's colour, a little darker (the walls are in shade), made linear.
            const rgb = [0, 1, 2].map(k => ((px[i + k]! / 255) * 0.75) ** 2)
            const x0 = x / w - 0.5, x1 = (x + 1) / w - 0.5
            const y1 = 0.5 - y / h, y0 = 0.5 - (y + 1) / h
            if (!solid(x - 1, y)) quad([x0, y0, -t], [x0, y0, t], [x0, y1, t], [x0, y1, -t], rgb)
            if (!solid(x + 1, y)) quad([x1, y0, t], [x1, y0, -t], [x1, y1, -t], [x1, y1, t], rgb)
            if (!solid(x, y - 1)) quad([x0, y1, t], [x1, y1, t], [x1, y1, -t], [x0, y1, -t], rgb)
            if (!solid(x, y + 1)) quad([x0, y0, -t], [x1, y0, -t], [x1, y0, t], [x0, y0, t], rgb)
        }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.setIndex(idx)
    g.computeBoundingSphere()
    return g
}

// ── The crack ──────────────────────────────────────────────────────────

// Three's default shader mode (not GLSL3): it still compiles as WebGL2 GLSL, so
// texture arrays work, and it defines gl_FragColor, which GLSL3 mode does not.
const CRACK_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const CRACK_FRAG = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform float uLayer;
varying vec2 vUv;
void main() {
    vec4 t = texture(uAtlas, vec3(vUv, uLayer));
    // Multiplied in twice (src * dst * 2): mid grey leaves the block as it is, darker cracks it.
    gl_FragColor = vec4(mix(vec3(0.5), t.rgb, t.a), 1.0);
}`

/** Minecraft's destroy stages over the block being mined, ten steps from a hairline to shattered. */
export class Crack {
    readonly mesh: THREE.Mesh
    private material: THREE.ShaderMaterial

    constructor(private readonly pack: BlockPack, scene: THREE.Scene) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: CRACK_VERT,
            fragmentShader: CRACK_FRAG,
            uniforms: { uAtlas: { value: pack.texture }, uLayer: { value: 0 } },
            blending: THREE.CustomBlending,
            blendSrc: THREE.DstColorFactor,
            blendDst: THREE.SrcColorFactor,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -4
        })
        this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), this.material)
        this.mesh.visible = false
        this.mesh.renderOrder = 3
        scene.add(this.mesh)
    }

    /** Shows the crack at (x, y, z) for mining progress 0..1, or hides it (null). */
    update(at: { x: number, y: number, z: number } | null, progress: number) {
        if (!at || progress <= 0) {
            this.mesh.visible = false
            return
        }
        this.mesh.visible = true
        this.mesh.position.set(at.x + 0.5, at.y + 0.5, at.z + 0.5)
        this.material.uniforms.uLayer!.value = this.pack.crackLayer(Math.floor(progress * 10))
    }

    dispose() {
        this.mesh.geometry.dispose()
        this.material.dispose()
    }
}

// ── Particles ──────────────────────────────────────────────────────────

const CHIP_VERT = /* glsl */`
attribute float layer;
attribute vec3 tint;
varying vec2 vUv;
varying float vLayer;
varying vec3 vTint;
void main() {
    vUv = uv;
    vLayer = layer;
    vTint = tint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const CHIP_FRAG = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
uniform float uBright;
varying vec2 vUv;
varying float vLayer;
varying vec3 vTint;
void main() {
    vec4 t = texture(uAtlas, vec3(vUv, vLayer));
    if (t.a < 0.5) discard;
    gl_FragColor = vec4(t.rgb * vTint * uBright, 1.0);
    #include <colorspace_fragment>
}`

interface Chip {
    mesh: THREE.Mesh
    vel: THREE.Vector3
    life: number
}

/** Little squares cut from the block's own texture: a few per hit, a burst when it breaks. */
export class Particles {
    private chips: Chip[] = []
    private material: THREE.ShaderMaterial

    constructor(private readonly pack: BlockPack, private readonly scene: THREE.Scene, private readonly world: World) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: CHIP_VERT,
            fragmentShader: CHIP_FRAG,
            uniforms: { uAtlas: { value: pack.texture }, uBright: { value: 1 } },
            side: THREE.DoubleSide
        })
    }

    /**
     * A block breaking, the way Minecraft does it: a 4x4x4 grid of chips through
     * the whole block, each flying out from the centre and a little up.
     */
    breakBlock(id: number, x: number, y: number, z: number) {
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                for (let k = 0; k < 4; k++) {
                    const ox = (i + 0.5) / 4, oy = (j + 0.5) / 4, oz = (k + 0.5) / 4
                    const dir = new THREE.Vector3(ox - 0.5 + rand(-0.4, 0.4), oy - 0.5 + rand(-0.4, 0.4), oz - 0.5 + rand(-0.4, 0.4))
                    // Minecraft: 0.06 to 0.18 blocks a tick outward, plus 0.1 a tick up.
                    const vel = dir.normalize().multiplyScalar(rand(1.2, 3.6))
                    vel.y += 2
                    this.spawn(id, x + ox, y + oy, z + oz, vel, 1)
                }
            }
        }
    }

    /** One chip knocked off the face being mined (Minecraft makes one a tick), smaller and slower. */
    hit(id: number, h: { x: number, y: number, z: number, nx: number, ny: number, nz: number }) {
        const px = h.x + 0.5 + h.nx * 0.55 + (h.nx ? 0 : rand(-0.45, 0.45))
        const py = h.y + 0.5 + h.ny * 0.55 + (h.ny ? 0 : rand(-0.45, 0.45))
        const pz = h.z + 0.5 + h.nz * 0.55 + (h.nz ? 0 : rand(-0.45, 0.45))
        const vel = new THREE.Vector3(h.nx + rand(-0.6, 0.6), h.ny + rand(0, 0.8), h.nz + rand(-0.6, 0.6)).multiplyScalar(rand(0.6, 1.4))
        this.spawn(id, px, py, pz, vel, 0.6)
    }

    private spawn(id: number, x: number, y: number, z: number, vel: THREE.Vector3, scale: number) {
        if (this.chips.length >= 600) return
        const p = this.pack.particleOf(id)
        if (!p) return
        const tint = p.tint !== null ? [((p.tint >> 16) & 255) / 255, ((p.tint >> 8) & 255) / 255, (p.tint & 255) / 255] : [1, 1, 1]
        // Minecraft's terrain particles: 0.1 to 0.2 of a block across, a random 4x4-texel patch of the texture.
        const size = rand(0.05, 0.1) * scale
        const u = rand(0, 0.75), v = rand(0, 0.75), s = 0.25
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-size, -size, 0, size, -size, 0, size, size, 0, -size, size, 0]), 3))
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([u, v + s, u + s, v + s, u + s, v, u, v]), 2))
        g.setAttribute('layer', new THREE.BufferAttribute(new Float32Array([p.layer, p.layer, p.layer, p.layer]), 1))
        g.setAttribute('tint', new THREE.BufferAttribute(new Float32Array([...tint, ...tint, ...tint, ...tint]), 3))
        g.setIndex([0, 1, 2, 0, 2, 3])
        const mesh = new THREE.Mesh(g, this.material)
        mesh.position.set(x, y, z)
        this.scene.add(mesh)
        // Lifetime 4 / (r * 0.9 + 0.1) ticks: mostly short, a few linger up to two seconds.
        this.chips.push({ mesh, vel, life: 4 / (randomFloat() * 0.9 + 0.1) / 20 })
    }

    /** How bright the light around the player is (chips are lit by it). */
    setBrightness(b: number) {
        this.material.uniforms.uBright!.value = b
    }

    update(dt: number, camera: THREE.Camera) {
        for (let i = this.chips.length - 1; i >= 0; i--) {
            const c = this.chips[i]!
            c.life -= dt
            // Minecraft's terrain particle: gravity 0.04 a tick squared, 2% drag a tick.
            c.vel.y -= 16 * dt
            c.vel.multiplyScalar(0.98 ** (dt * 20))
            const p = c.mesh.position
            const solidAt = (x: number, y: number, z: number) => block(this.world.get(Math.floor(x), Math.floor(y), Math.floor(z))).solid
            // Per axis, so a chip that lands slides along the ground rather than sticking.
            const nx = p.x + c.vel.x * dt
            if (solidAt(nx, p.y, p.z)) c.vel.x = 0
            else p.x = nx
            const nz = p.z + c.vel.z * dt
            if (solidAt(p.x, p.y, nz)) c.vel.z = 0
            else p.z = nz
            const ny = p.y + c.vel.y * dt
            if (solidAt(p.x, ny, p.z)) {
                c.vel.y = 0
                c.vel.x *= 0.7
                c.vel.z *= 0.7
            } else {
                p.y = ny
            }
            c.mesh.quaternion.copy(camera.quaternion)
            if (c.life <= 0) {
                this.scene.remove(c.mesh)
                c.mesh.geometry.dispose()
                this.chips.splice(i, 1)
            }
        }
    }

    dispose() {
        for (const c of this.chips) {
            this.scene.remove(c.mesh)
            c.mesh.geometry.dispose()
        }
        this.chips = []
        this.material.dispose()
    }
}

// ── Drops ──────────────────────────────────────────────────────────────

interface Drop {
    key: string
    count: number
    obj: THREE.Object3D
    pos: THREE.Vector3
    vel: THREE.Vector3
    age: number
    grounded: boolean
    /** Being pulled in by the player. */
    pulled: boolean
}

const DROP_SIZE = 0.25
const PICKUP_DELAY = 0.45
const PICKUP_RANGE = 1.6
/** A drop nobody picks up flies to you anyway after this long, so nothing is lost to the void. */
const AUTO_COLLECT = 30

/** Items in the world: they pop out of a broken block, land, bob and spin, and fly to you when you come close. */
export class Drops {
    private drops: Drop[] = []

    constructor(private readonly looks: ItemLooks, private readonly scene: THREE.Scene, private readonly world: World) {}

    spawn(key: string, x: number, y: number, z: number, count = 1) {
        const obj = this.looks.make(key)
        obj.scale.setScalar(obj.userData.sprite ? DROP_SIZE * 1.5 : DROP_SIZE)
        const pos = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)
        // A little hop up and to a random side, as in Minecraft.
        const vel = new THREE.Vector3(rand(-1.2, 1.2), rand(3.5, 5), rand(-1.2, 1.2))
        obj.position.copy(pos)
        obj.rotation.y = rand(0, Math.PI * 2)
        this.scene.add(obj)
        this.drops.push({ key, count, obj, pos, vel, age: 0, grounded: false, pulled: false })
    }

    /**
     * Moves the drops. `player` is the point they fly to (about the player's
     * middle); `give` puts items in the inventory and returns how many did not fit.
     */
    update(dt: number, player: THREE.Vector3, give: (key: string, count: number) => number, onPickup: () => void) {
        for (let i = this.drops.length - 1; i >= 0; i--) {
            const d = this.drops[i]!
            d.age += dt
            const dist = d.pos.distanceTo(player)
            if (d.age > PICKUP_DELAY && (dist < PICKUP_RANGE || d.age > AUTO_COLLECT)) d.pulled = true
            if (d.pulled) {
                // Accelerate toward the player; land in the inventory on arrival.
                const pull = player.clone().sub(d.pos)
                const len = pull.length()
                if (len < 0.35) {
                    const left = give(d.key, d.count)
                    if (left < d.count) onPickup()
                    if (left <= 0) {
                        this.remove(i)
                        continue
                    }
                    // Inventory full: it drops back down and waits.
                    d.count = left
                    d.pulled = false
                    d.age = 0
                    d.vel.set(rand(-1, 1), 3, rand(-1, 1))
                } else {
                    d.vel.lerp(pull.multiplyScalar(14 / len), Math.min(1, dt * 10))
                    d.pos.addScaledVector(d.vel, dt)
                }
            } else {
                this.fall(d, dt)
            }
            // Spin, and bob gently once landed.
            d.obj.rotation.y += dt * 1.6
            d.obj.position.set(d.pos.x, d.pos.y + (d.grounded ? 0.08 + Math.sin(d.age * 2.5) * 0.06 : 0), d.pos.z)
            if (d.pos.y < -40) this.remove(i)
        }
    }

    private fall(d: Drop, dt: number) {
        d.vel.y -= 16 * dt
        const half = DROP_SIZE / 2
        const solid = (x: number, y: number, z: number) => block(this.world.get(Math.floor(x), Math.floor(y), Math.floor(z))).solid
        // Per axis, so a drop slides along a wall rather than sticking to it.
        const nx = d.pos.x + d.vel.x * dt
        if (solid(nx + Math.sign(d.vel.x) * half, d.pos.y, d.pos.z)) d.vel.x = 0
        else d.pos.x = nx
        const nz = d.pos.z + d.vel.z * dt
        if (solid(d.pos.x, d.pos.y, nz + Math.sign(d.vel.z) * half)) d.vel.z = 0
        else d.pos.z = nz
        const ny = d.pos.y + d.vel.y * dt
        if (d.vel.y < 0 && solid(d.pos.x, ny - half, d.pos.z)) {
            d.pos.y = Math.floor(ny - half) + 1 + half
            d.vel.y = 0
            d.grounded = true
        } else {
            d.pos.y = ny
            d.grounded = false
        }
        // Friction on the ground.
        if (d.grounded) {
            d.vel.x *= 1 - Math.min(1, dt * 8)
            d.vel.z *= 1 - Math.min(1, dt * 8)
        }
    }

    /** Everything still lying around (to put in the inventory before a save). */
    take(): { key: string, count: number }[] {
        const all = this.drops.map(d => ({ key: d.key, count: d.count }))
        while (this.drops.length) this.remove(this.drops.length - 1)
        return all
    }

    private remove(i: number) {
        this.scene.remove(this.drops[i]!.obj)
        this.drops.splice(i, 1)
    }
}

// ── The hand ───────────────────────────────────────────────────────────

/** Minecraft's swing: six ticks. */
const SWING_TIME = 0.3
const PI = Math.PI

/** Builds a transform by composing steps in order, the way Minecraft's pose stack does. */
class Pose {
    readonly m = new THREE.Matrix4()
    private step = new THREE.Matrix4()

    reset() {
        this.m.identity()
        return this
    }

    move(x: number, y: number, z: number) {
        this.m.multiply(this.step.makeTranslation(x, y, z))
        return this
    }

    turnX(degrees: number) {
        this.m.multiply(this.step.makeRotationX(THREE.MathUtils.degToRad(degrees)))
        return this
    }

    turnY(degrees: number) {
        this.m.multiply(this.step.makeRotationY(THREE.MathUtils.degToRad(degrees)))
        return this
    }

    turnZ(degrees: number) {
        this.m.multiply(this.step.makeRotationZ(THREE.MathUtils.degToRad(degrees)))
        return this
    }

    scale(k: number) {
        this.m.multiply(this.step.makeScale(k, k, k))
        return this
    }
}

/**
 * Your arm (or what it holds) in the bottom-right corner, drawn in its own
 * scene over the world so it never clips into blocks. The poses and the swing
 * follow Minecraft's first-person numbers, measured against its footage frame
 * by frame: the bare arm punches forward and in to the crosshair; a held
 * tool is big and upright on the right, and its swing is a chop, the head
 * sweeping up and over and coming down diagonally onto the block. The bare
 * arm only shows with an empty hand, as in Minecraft.
 */
export class Hand {
    readonly scene = new THREE.Scene()
    readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 10)
    private arm = new THREE.Group()
    private held: THREE.Object3D | null = null
    private heldKey: string | null | undefined = undefined
    private pose = new Pose()
    private swingT = 1
    private bob = 0
    private equip = 1

    private lamps: THREE.Light[]

    constructor(private readonly looks: ItemLooks) {
        // The bare arm is lit by lamps, turned up and down with the light where you stand.
        this.lamps = [new THREE.HemisphereLight(0xe4f0ff, 0x5a4a3a, 1.6), new THREE.DirectionalLight(0xfff4e0, 1.5)]
        this.lamps[1]!.position.set(0.5, 1, 0.3)
        for (const l of this.lamps) this.scene.add(l)
        // Minecraft's right arm: a 4x12x4-pixel box below its shoulder pivot (model units are
        // pixels / 16), skin with the shirt's sleeve at the shoulder end.
        const px = 1 / 16
        const skin = new THREE.Mesh(new THREE.BoxGeometry(4 * px, 8 * px, 4 * px), new THREE.MeshLambertMaterial({ color: 0xc69477 }))
        skin.position.set(-6 * px, 8 * px, 0)
        const sleeve = new THREE.Mesh(new THREE.BoxGeometry(4.2 * px, 4 * px, 4.2 * px), new THREE.MeshLambertMaterial({ color: 0x2ca8b4 }))
        sleeve.position.set(-6 * px, 2 * px, 0)
        this.arm.add(skin, sleeve)
        this.arm.matrixAutoUpdate = false
        this.scene.add(this.arm)
    }

    /** Swings once (placing, a hit). Mining keeps calling it, so the swing repeats. */
    swing() {
        if (this.swingT >= 1) this.swingT = 0
    }

    setHeld(key: string | null) {
        if (key === this.heldKey) return
        this.heldKey = key
        if (this.held) this.scene.remove(this.held)
        this.held = null
        this.arm.visible = !key
        if (key) {
            this.held = this.looks.make(key)
            this.held.matrixAutoUpdate = false
            this.scene.add(this.held)
        }
        // A new item comes up from below.
        this.equip = 0
    }

    update(dt: number, walkSpeed: number) {
        this.swingT = Math.min(1, this.swingT + dt / SWING_TIME)
        this.bob += dt * walkSpeed * 2.2
        this.equip = Math.min(1, this.equip + dt * 5)
        const s = this.swingT >= 1 ? 0 : this.swingT
        const sq = Math.sqrt(s)
        const lowered = 1 - this.equip
        const walk = Math.min(1, walkSpeed / 4)
        const p = this.pose.reset().move(Math.sin(this.bob) * 0.03 * walk, -Math.abs(Math.cos(this.bob)) * 0.04 * walk, 0)

        if (!this.held) {
            // The bare arm (Minecraft's renderPlayerArm): out and in toward the crosshair, then back.
            p.move(-0.3 * Math.sin(sq * PI) + 0.64, 0.4 * Math.sin(sq * PI * 2) - 0.6 - 0.6 * lowered, -0.4 * Math.sin(s * PI) - 0.72)
                .turnY(45)
                .turnY(Math.sin(sq * PI) * 70)
                .turnZ(Math.sin(s * s * PI) * -20)
                .move(-1, 3.6, 3.5)
                .turnZ(120)
                .turnX(200)
                .turnY(-135)
                .move(5.6, 0, 0)
            this.arm.matrix.copy(p.m)
            return
        }

        // A held item (Minecraft's item-in-hand transform, then the attack swing).
        p.move(-0.4 * Math.sin(sq * PI), 0.2 * Math.sin(sq * PI * 2), -0.2 * Math.sin(s * PI))
            .move(0.56, -0.52 - 0.6 * lowered, -0.72)
            .turnY(45 + Math.sin(s * s * PI) * -20)
            .turnZ(Math.sin(sq * PI) * -20)
            .turnX(Math.sin(sq * PI) * -80)
            .turnY(-45)
        // How the model sits in the hand (Minecraft's firstperson_righthand display):
        // a flat item or tool is turned edge-on and tipped back; a block is turned 45 degrees.
        if (this.held.userData.sprite) p.move(1.13 / 16, 3.2 / 16, 1.13 / 16).turnY(-90).turnZ(25).scale(0.68)
        else p.turnY(45).scale(0.4)
        this.held.matrix.copy(p.m)
    }

    render(renderer: THREE.WebGLRenderer, aspect: number) {
        this.camera.aspect = aspect
        this.camera.updateProjectionMatrix()
        // The last thing drawn (the crack, water) may have left depth writes off, and
        // with them off a depth clear does nothing: the hand would then hide behind walls.
        renderer.state.buffers.depth.setMask(true)
        renderer.clearDepth()
        renderer.render(this.scene, this.camera)
    }

    /** How bright the light around the player is, 0..1 (the arm darkens at night). */
    setBrightness(b: number) {
        this.lamps[0]!.intensity = 1.6 * b
        this.lamps[1]!.intensity = 1.5 * b
    }

    /** For checks: the swing's progress, 0..1 (1 is at rest). */
    setSwing(t: number) {
        this.swingT = t
    }

    dispose() {
        for (const m of this.arm.children as THREE.Mesh[]) {
            m.geometry.dispose()
            ;(m.material as THREE.Material).dispose()
        }
    }
}
