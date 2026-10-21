import * as THREE from 'three'
import { ARMOR_MATERIALS, item, type ArmorSlot } from './items'
import { DYE_COLORS } from './dyes'
import { CAT_VARIANTS, type Arrow, type Mob, type MobKind, type Mobs, type Potion } from './mobs'

/*
 * Draws the mobs with Minecraft's own models: boxes on jointed parts, their
 * texture mapped the way Minecraft's ModelPart.Cube maps it, posed by the
 * same chain (turn by 180 - yaw, flip x and y, drop 1.501), so the pack's
 * skins land where they belong. Animations are Minecraft's setupAnim
 * formulas: legs swinging with the walk, heads turning to look, zombies'
 * arms out, a skeleton drawing its bow, a creeper swelling and flashing, and
 * the topple over sideways when one dies.
 */

type V3 = [number, number, number]

interface Cube {
    uv: [number, number]
    from: V3
    size: V3
    grow?: number
    mirror?: boolean
}

interface Part {
    /** Where it hinges, in its parent's space (the model's, or `parent`'s). */
    pivot: V3
    rot?: V3
    cubes: Cube[]
    /** A part that moves with another (a witch's hat on its head); listed after that one. */
    parent?: string
}

interface ModelDef {
    texture: string
    size: [number, number]
    parts: Record<string, Part>
    /** Drawn smaller or larger than the model (the renderer's own scale: a cat's 0.8). */
    scale?: number
}

const box = (u: number, v: number, x: number, y: number, z: number, w: number, h: number, d: number, grow = 0, mirror = false): Cube => ({ uv: [u, v], from: [x, y, z], size: [w, h, d], grow, mirror })
const HALF_PI = Math.PI / 2

function quadruped(texture: string, size: [number, number], head: Part, body: Part, leg: Cube, legY: number, hindZ: number, frontZ: number, legX: number): ModelDef {
    return {
        texture,
        size,
        parts: {
            head,
            body,
            right_hind_leg: { pivot: [-legX, legY, hindZ], cubes: [leg] },
            left_hind_leg: { pivot: [legX, legY, hindZ], cubes: [{ ...leg, mirror: true }] },
            right_front_leg: { pivot: [-legX, legY, frontZ], cubes: [leg] },
            left_front_leg: { pivot: [legX, legY, frontZ], cubes: [{ ...leg, mirror: true }] }
        }
    }
}

function humanoid(texture: string, size: [number, number], arm: Cube, leftArm: Cube, leg: Cube, leftLeg: Cube, legX: number): ModelDef {
    return {
        texture,
        size,
        parts: {
            head: { pivot: [0, 0, 0], cubes: [box(0, 0, -4, -8, -4, 8, 8, 8), box(32, 0, -4, -8, -4, 8, 8, 8, 0.5)] },
            body: { pivot: [0, 0, 0], cubes: [box(16, 16, -4, 0, -2, 8, 12, 4)] },
            right_arm: { pivot: [-5, 2, 0], cubes: [arm] },
            left_arm: { pivot: [5, 2, 0], cubes: [leftArm] },
            right_leg: { pivot: [-legX, 12, 0], cubes: [leg] },
            left_leg: { pivot: [legX, 12, 0], cubes: [leftLeg] }
        }
    }
}

const spiderLegs = () => {
    const parts: Record<string, Part> = {}
    const names = ['hind', 'middle_hind', 'middle_front', 'front']
    names.forEach((n, i) => {
        parts[`right_${n}_leg`] = { pivot: [-4, 15, 2 - i], cubes: [box(18, 0, -15, -1, -1, 16, 2, 2)] }
        parts[`left_${n}_leg`] = { pivot: [4, 15, 2 - i], cubes: [box(18, 0, -1, -1, -1, 16, 2, 2)] }
    })
    return parts
}

/** Minecraft's SquidModel: a tall body and eight tentacles hanging from a ring under it. */
const squidParts = (): Record<string, Part> => {
    const parts: Record<string, Part> = { body: { pivot: [0, 8, 0], cubes: [box(0, 0, -6, -8, -6, 12, 16, 12)] } }
    for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI * 2) / 8
        parts[`tentacle${i}`] = { pivot: [Math.cos(a) * 5, 15, Math.sin(a) * 5], rot: [0, (i * -Math.PI * 2) / 8 + HALF_PI, 0], cubes: [box(48, 0, -1, 0, -1, 2, 18, 2)] }
    }
    return parts
}

const MODELS: Record<MobKind, ModelDef> = {
    squid: { texture: 'squid.png', size: [64, 32], parts: squidParts() },
    cow: quadruped('cow.png', [64, 32],
        { pivot: [0, 4, -8], cubes: [box(0, 0, -4, -4, -6, 8, 8, 6), box(22, 0, -5, -5, -4, 1, 3, 1), box(22, 0, 4, -5, -4, 1, 3, 1)] },
        { pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], cubes: [box(18, 4, -6, -10, -7, 12, 18, 10), box(52, 0, -2, 2, -8, 4, 6, 1)] },
        box(0, 16, -2, 0, -2, 4, 12, 4), 12, 7, -6, 4),
    pig: quadruped('pig_temperate.png', [64, 64],
        { pivot: [0, 12, -6], cubes: [box(0, 0, -4, -4, -8, 8, 8, 8), box(16, 16, -2, 0, -9, 4, 3, 1)] },
        { pivot: [0, 11, 2], rot: [HALF_PI, 0, 0], cubes: [box(28, 8, -5, -10, -7, 10, 16, 8)] },
        box(0, 16, -2, 0, -2, 4, 6, 4), 18, 7, -5, 3),
    sheep: quadruped('sheep.png', [64, 32],
        { pivot: [0, 6, -8], cubes: [box(0, 0, -3, -4, -6, 6, 6, 8)] },
        { pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], cubes: [box(28, 8, -4, -10, -7, 8, 16, 6)] },
        box(0, 16, -2, 0, -2, 4, 12, 4), 12, 7, -5, 3),
    chicken: {
        texture: 'chicken_temperate.png',
        size: [64, 32],
        parts: {
            head: { pivot: [0, 15, -4], cubes: [box(0, 0, -2, -6, -2, 4, 6, 3), box(14, 0, -2, -4, -4, 4, 2, 2), box(14, 4, -1, -2, -3, 2, 2, 2)] },
            body: { pivot: [0, 16, 0], rot: [HALF_PI, 0, 0], cubes: [box(0, 9, -3, -4, -3, 6, 8, 6)] },
            right_leg: { pivot: [-2, 19, 1], cubes: [box(26, 0, -1, 0, -3, 3, 5, 3)] },
            left_leg: { pivot: [1, 19, 1], cubes: [box(26, 0, -1, 0, -3, 3, 5, 3)] },
            right_wing: { pivot: [-4, 13, 0], cubes: [box(24, 13, 0, 0, -3, 1, 4, 6)] },
            left_wing: { pivot: [4, 13, 0], cubes: [box(24, 13, -1, 0, -3, 1, 4, 6)] }
        }
    },
    zombie: humanoid('zombie.png', [64, 64], box(40, 16, -3, -2, -2, 4, 12, 4), box(32, 48, -1, -2, -2, 4, 12, 4), box(0, 16, -2, 0, -2, 4, 12, 4), box(16, 48, -2, 0, -2, 4, 12, 4), 1.9),
    skeleton: humanoid('skeleton.png', [64, 32], box(40, 16, -1, -2, -1, 2, 12, 2), box(40, 16, -1, -2, -1, 2, 12, 2, 0, true), box(0, 16, -1, 0, -1, 2, 12, 2), box(0, 16, -1, 0, -1, 2, 12, 2, 0, true), 2),
    creeper: quadruped('creeper.png', [64, 32],
        { pivot: [0, 6, 0], cubes: [box(0, 0, -4, -8, -4, 8, 8, 8)] },
        { pivot: [0, 6, 0], cubes: [box(16, 16, -4, 0, -2, 8, 12, 4)] },
        box(0, 16, -2, 0, -2, 4, 6, 4), 18, 4, -4, 2),
    // Minecraft's WitchModel (a villager with a crooked four-tier hat, a long nose and a mole).
    witch: {
        texture: 'witch.png',
        size: [64, 128],
        parts: {
            head: { pivot: [0, 0, 0], cubes: [box(0, 0, -4, -10, -4, 8, 10, 8)] },
            hat: { parent: 'head', pivot: [-5, -10.03125, -5], cubes: [box(0, 64, 0, 0, 0, 10, 2, 10)] },
            hat2: { parent: 'hat', pivot: [1.75, -4, 2], rot: [-0.05235988, 0, 0.02617994], cubes: [box(0, 76, 0, 0, 0, 7, 4, 7)] },
            hat3: { parent: 'hat2', pivot: [1.75, -4, 2], rot: [-0.10471976, 0, 0.05235988], cubes: [box(0, 87, 0, 0, 0, 4, 4, 4)] },
            hat4: { parent: 'hat3', pivot: [1.75, -2, 2], rot: [-0.20943952, 0, 0.10471976], cubes: [box(0, 95, 0, 0, 0, 1, 2, 1, 0.25)] },
            nose: { parent: 'head', pivot: [0, -2, 0], cubes: [box(24, 0, -1, -1, -6, 2, 4, 2)] },
            mole: { parent: 'nose', pivot: [0, -2, 0], cubes: [box(0, 0, 0, 3, -6.75, 1, 1, 1, -0.25)] },
            body: { pivot: [0, 0, 0], cubes: [box(16, 20, -4, 0, -3, 8, 12, 6), box(0, 38, -4, 0, -3, 8, 18, 6, 0.5)] },
            arms: { pivot: [0, 3, -1], rot: [-0.75, 0, 0], cubes: [box(44, 22, -8, -2, -2, 4, 8, 4), box(44, 22, 4, -2, -2, 4, 8, 4, 0, true), box(40, 38, -4, 2, -2, 8, 4, 4)] },
            right_leg: { pivot: [-2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4)] },
            left_leg: { pivot: [2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4, 0, true)] }
        }
    },
    // Minecraft's VillagerModel: a long head and nose, a robe, arms folded.
    villager: {
        texture: 'villager.png',
        size: [64, 64],
        parts: {
            head: { pivot: [0, 0, 0], cubes: [box(0, 0, -4, -10, -4, 8, 10, 8)] },
            // A hat and its brim: empty in the plain skin, filled in by some trades' clothes (a farmer's straw hat).
            hat: { parent: 'head', pivot: [0, 0, 0], cubes: [box(32, 0, -4, -10, -4, 8, 10, 8, 0.51)] },
            hat_rim: { parent: 'hat', pivot: [0, 0, 0], rot: [-HALF_PI, 0, 0], cubes: [box(30, 47, -8, -8, -6, 16, 16, 1)] },
            nose: { parent: 'head', pivot: [0, -2, 0], cubes: [box(24, 0, -1, -1, -6, 2, 4, 2)] },
            body: { pivot: [0, 0, 0], cubes: [box(16, 20, -4, 0, -3, 8, 12, 6), box(0, 38, -4, 0, -3, 8, 20, 6, 0.5)] },
            arms: { pivot: [0, 3, -1], rot: [-0.75, 0, 0], cubes: [box(44, 22, -8, -2, -2, 4, 8, 4), box(44, 22, 4, -2, -2, 4, 8, 4, 0, true), box(40, 38, -4, 2, -2, 8, 4, 4)] },
            right_leg: { pivot: [-2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4)] },
            left_leg: { pivot: [2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4, 0, true)] }
        }
    },
    // Minecraft's ZombieVillagerModel: a villager's head and robe with a zombie's outstretched arms.
    zombie_villager: {
        texture: 'zombie_villager.png',
        size: [64, 64],
        parts: {
            head: { pivot: [0, 0, 0], cubes: [box(0, 0, -4, -10, -4, 8, 10, 8), box(24, 0, -1, -3, -6, 2, 4, 2)] },
            hat: { parent: 'head', pivot: [0, 0, 0], cubes: [box(32, 0, -4, -10, -4, 8, 10, 8, 0.51)] },
            hat_rim: { parent: 'hat', pivot: [0, 0, 0], rot: [-HALF_PI, 0, 0], cubes: [box(30, 47, -8, -8, -6, 16, 16, 1)] },
            body: { pivot: [0, 0, 0], cubes: [box(16, 20, -4, 0, -3, 8, 12, 6), box(0, 38, -4, 0, -3, 8, 20, 6, 0.05)] },
            right_arm: { pivot: [-5, 2, 0], cubes: [box(44, 22, -3, -2, -2, 4, 12, 4)] },
            left_arm: { pivot: [5, 2, 0], cubes: [box(44, 22, -1, -2, -2, 4, 12, 4, 0, true)] },
            right_leg: { pivot: [-2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4)] },
            left_leg: { pivot: [2, 12, 0], cubes: [box(0, 22, -2, 0, -2, 4, 12, 4, 0, true)] }
        }
    },
    spider: {
        texture: 'spider.png',
        size: [64, 32],
        parts: {
            head: { pivot: [0, 15, -3], cubes: [box(32, 4, -4, -4, -8, 8, 8, 8)] },
            body0: { pivot: [0, 15, 0], cubes: [box(0, 0, -3, -3, -3, 6, 6, 6)] },
            body1: { pivot: [0, 15, 9], cubes: [box(0, 12, -5, -4, -6, 10, 8, 12)] },
            ...spiderLegs()
        }
    },
    // Minecraft's OcelotModel, which cats share, drawn at 0.8 (CatRenderer). The coat is picked per cat.
    cat: {
        texture: 'cat_tabby.png',
        size: [64, 32],
        scale: 0.8,
        parts: {
            head: { pivot: [0, 15, -9], cubes: [box(0, 0, -2.5, -2, -3, 5, 4, 5), box(0, 24, -1.5, -0.001, -4, 3, 2, 2), box(0, 10, -2, -3, 0, 1, 1, 2), box(6, 10, 1, -3, 0, 1, 1, 2)] },
            body: { pivot: [0, 12, -10], rot: [HALF_PI, 0, 0], cubes: [box(20, 0, -2, 3, -8, 4, 16, 6)] },
            tail1: { pivot: [0, 15, 8], rot: [0.9, 0, 0], cubes: [box(0, 15, -0.5, 0, 0, 1, 8, 1)] },
            tail2: { pivot: [0, 20, 14], rot: [1.7278761, 0, 0], cubes: [box(4, 15, -0.5, 0, 0, 1, 8, 1)] },
            left_hind_leg: { pivot: [1.1, 18, 5], cubes: [box(8, 13, -1, 0, 1, 2, 6, 2)] },
            right_hind_leg: { pivot: [-1.1, 18, 5], cubes: [box(8, 13, -1, 0, 1, 2, 6, 2)] },
            left_front_leg: { pivot: [1.2, 14.1, -5], cubes: [box(40, 0, -1, 0, 0, 2, 10, 2)] },
            right_front_leg: { pivot: [-1.2, 14.1, -5], cubes: [box(40, 0, -1, 0, 0, 2, 10, 2)] }
        }
    },
    // Minecraft's IronGolemModel (a 128x128 skin).
    iron_golem: {
        texture: 'iron_golem.png',
        size: [128, 128],
        parts: {
            head: { pivot: [0, -7, -2], cubes: [box(0, 0, -4, -12, -5.5, 8, 10, 8), box(24, 0, -1, -5, -7.5, 2, 4, 2)] },
            body: { pivot: [0, -7, 0], cubes: [box(0, 40, -9, -2, -6, 18, 12, 11), box(0, 70, -4.5, 10, -3, 9, 5, 6, 0.5)] },
            right_arm: { pivot: [0, -7, 0], cubes: [box(60, 21, -13, -2.5, -3, 4, 30, 6)] },
            left_arm: { pivot: [0, -7, 0], cubes: [box(60, 58, 9, -2.5, -3, 4, 30, 6)] },
            right_leg: { pivot: [-4, 11, 0], cubes: [box(37, 0, -3.5, -3, -3, 6, 16, 5)] },
            left_leg: { pivot: [5, 11, 0], cubes: [box(60, 0, -3.5, -3, -3, 6, 16, 5, 0, true)] }
        }
    }
}

/** A golem's cracks as its health runs down (IronGolemCrackinessLayer): under 75%, 50% and 25%. */
function golemCracks(m: Mob): string | null {
    const f = m.health / m.def.health
    return f < 0.25 ? 'high' : f < 0.5 ? 'medium' : f < 0.75 ? 'low' : null
}

/** Minecraft's Mth.triangleWave: a sawtooth folded into a triangle, -1 to 1, over `period`. */
function triangleWave(x: number, period: number) {
    return (Math.abs((x % period + period) % period - period * 0.5) - period * 0.25) / (period * 0.25)
}

/**
 * A sheep's coat, a spider's glowing eyes, a villager's clothes: the same pose
 * drawn again over the body. `flush`: on the very same boxes, so it is pulled
 * a hair towards the camera to win against the skin under it.
 */
const LAYERS: Partial<Record<MobKind, { def: ModelDef, glow: boolean, flush?: boolean }>> = {
    sheep: {
        glow: false,
        def: quadruped('sheep_wool.png', [64, 32],
            { pivot: [0, 6, -8], cubes: [box(0, 0, -3, -4, -4, 6, 6, 6, 0.6)] },
            { pivot: [0, 5, 2], rot: [HALF_PI, 0, 0], cubes: [box(28, 8, -4, -10, -7, 8, 16, 6, 1.75)] },
            box(0, 16, -2, 0, -2, 4, 6, 4, 0.5), 12, 7, -5, 3)
    },
    spider: { glow: true, def: { ...MODELS.spider, texture: 'spider_eyes.png' } },
    // A plains villager's clothes, drawn over its skin on the same boxes.
    villager: { glow: false, flush: true, def: { ...MODELS.villager, texture: 'villager_plains.png' } },
    zombie_villager: { glow: false, flush: true, def: { ...MODELS.zombie_villager, texture: 'zombie_villager_plains.png' } }
}

/**
 * One box, as Minecraft's ModelPart.Cube builds it: eight corners (in model
 * pixels, y pointing down), six faces whose texture comes from the box's
 * net laid out from its texture offset. Each face is shaded by the way it
 * faces, as Minecraft's entity lighting roughly does.
 */
function cubeGeometry(c: Cube, [tw, th]: [number, number], out: { pos: number[], uv: number[], col: number[], idx: number[] }) {
    const [w, h, d] = c.size
    const g = c.grow ?? 0
    let x0 = c.from[0] - g, x1 = c.from[0] + w + g
    const y0 = c.from[1] - g, y1 = c.from[1] + h + g
    const z0 = c.from[2] - g, z1 = c.from[2] + d + g
    if (c.mirror) [x0, x1] = [x1, x0]
    const v: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
    const [u, t] = c.uv
    const j = u, k = u + d, l = u + d + w, m = u + d + w + w, n = u + d + w + d, o = u + d + w + d + w
    const p = t, q = t + d, r = t + d + h
    // Corners, texture rectangle (u1, v1, u2, v2), and shade. "Down" in model space is the top on screen.
    const faces: [number[], number, number, number, number, number][] = [
        [[5, 4, 0, 1], k, p, l, q, 1],
        [[2, 3, 7, 6], l, q, m, p, 0.5],
        [[0, 4, 7, 3], j, q, k, r, 0.6],
        [[1, 0, 3, 2], k, q, l, r, 0.8],
        [[5, 1, 2, 6], l, q, n, r, 0.6],
        [[4, 5, 6, 7], n, q, o, r, 0.8]
    ]
    for (const [corners, u1, v1, u2, v2, shade] of faces) {
        const uvs: [number, number][] = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]]
        const order = c.mirror ? [3, 2, 1, 0] : [0, 1, 2, 3]
        const base = out.pos.length / 3
        for (const i of order) {
            const vert = v[corners[i]!]!
            out.pos.push(vert[0] / 16, vert[1] / 16, vert[2] / 16)
            out.uv.push(uvs[i]![0] / tw, uvs[i]![1] / th)
            out.col.push(shade, shade, shade)
        }
        out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
}

interface Built {
    root: THREE.Object3D
    parts: Record<string, THREE.Object3D>
}

function build(def: ModelDef, material: THREE.Material): Built {
    const root = new THREE.Group()
    const parts: Record<string, THREE.Object3D> = {}
    for (const [name, part] of Object.entries(def.parts)) {
        const out = { pos: [] as number[], uv: [] as number[], col: [] as number[], idx: [] as number[] }
        for (const c of part.cubes) cubeGeometry(c, def.size, out)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3))
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2))
        geo.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3))
        geo.setIndex(out.idx)
        const mesh = new THREE.Mesh(geo, material)
        const joint = new THREE.Group()
        joint.position.set(part.pivot[0] / 16, part.pivot[1] / 16, part.pivot[2] / 16)
        joint.rotation.order = 'ZYX'
        joint.add(mesh)
        joint.userData.rest = part.rot ?? [0, 0, 0]
        joint.userData.pivot = part.pivot
        joint.rotation.set(...(part.rot ?? [0, 0, 0]))
        ;(part.parent ? parts[part.parent]! : root).add(joint)
        parts[name] = joint
    }
    return { root, parts }
}

/** A material that can be dimmed, tinted red, and flashed white (a creeper about to go). */
function mobMaterial(map: THREE.Texture, glow: boolean) {
    const m = new THREE.MeshBasicMaterial({ map, vertexColors: !glow, alphaTest: 0.1, side: THREE.FrontSide })
    if (glow) {
        m.transparent = true
        m.blending = THREE.AdditiveBlending
        m.depthWrite = false
        m.polygonOffset = true
        m.polygonOffsetFactor = -1
        return { material: m, flash: null }
    }
    const flash = { value: 0 }
    m.onBeforeCompile = (shader) => {
        shader.uniforms.uFlash = flash
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uFlash;')
            .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, vec3(1.0), uFlash);\n#include <opaque_fragment>')
    }
    m.customProgramCacheKey = () => 'skyfarm-mob'
    return { material: m, flash }
}

/**
 * Armour on a zombie or skeleton, Minecraft's humanoid armour model: the
 * helmet, chestplate and boots on a box 1 pixel out from the body (the
 * material's outer texture), the leggings half a pixel out (its leggings
 * texture). Joints sit where the mob's own are, so the armour moves with it.
 */
function armorModel(kind: MobKind, slot: ArmorSlot, material: string): ModelDef {
    const own = MODELS[kind].parts
    const at = (name: string, cubes: Cube[]): Record<string, Part> => ({ [name]: { pivot: own[name]!.pivot, cubes } })
    const outer = `armor/${material}.png`, inner = `armor/${material}_leggings.png`
    switch (slot) {
        case 'head': return { texture: outer, size: [64, 32], parts: at('head', [box(0, 0, -4, -8, -4, 8, 8, 8, 1)]) }
        case 'chest': return {
            texture: outer,
            size: [64, 32],
            parts: { ...at('body', [box(16, 16, -4, 0, -2, 8, 12, 4, 1)]), ...at('right_arm', [box(40, 16, -3, -2, -2, 4, 12, 4, 1)]), ...at('left_arm', [box(40, 16, -1, -2, -2, 4, 12, 4, 1, true)]) }
        }
        case 'legs': return {
            texture: inner,
            size: [64, 32],
            parts: { ...at('body', [box(16, 16, -4, 0, -2, 8, 12, 4, 0.5)]), ...at('right_leg', [box(0, 16, -2, 0, -2, 4, 12, 4, 0.5)]), ...at('left_leg', [box(0, 16, -2, 0, -2, 4, 12, 4, 0.5, true)]) }
        }
        case 'feet': return { texture: outer, size: [64, 32], parts: { ...at('right_leg', [box(0, 16, -2, 0, -2, 4, 12, 4, 1)]), ...at('left_leg', [box(0, 16, -2, 0, -2, 4, 12, 4, 1, true)]) } }
    }
}

/** What a mob's drawing is built from: when this changes (a villager takes up a trade) it is built afresh. */
const viewKey = (m: Mob) => `${m.kind}:${m.profession ?? ''}:${m.kind === 'cat' ? m.variant : ''}:${m.kind === 'iron_golem' ? golemCracks(m) : ''}`

interface View {
    mob: Mob
    key: string
    root: THREE.Group
    death: THREE.Group
    flip: THREE.Group
    parts: Record<string, THREE.Object3D>
    armor: { parts: Record<string, THREE.Object3D>, material: THREE.MeshBasicMaterial }[]
    layer: Record<string, THREE.Object3D> | null
    material: THREE.MeshBasicMaterial
    layerMaterial: THREE.MeshBasicMaterial | null
    flash: { value: number } | null
    fire: THREE.Mesh
    lean: THREE.Group
}

export class MobRenderer {
    private textures = new Map<string, THREE.Texture>()
    private views = new Map<number, View>()
    private arrows = new Map<number, THREE.Object3D>()
    private potionSprites = new Map<number, THREE.Sprite>()
    private arrowMaterial: THREE.MeshBasicMaterial
    private arrowGeometry: THREE.BufferGeometry
    private fireMaterial: THREE.MeshBasicMaterial
    private fireFrames = 32
    private fireGeometry: THREE.BufferGeometry
    private clock = 0
    private tint = new THREE.Color()

    constructor(private readonly scene: THREE.Scene, private readonly base: string) {
        this.arrowMaterial = new THREE.MeshBasicMaterial({ map: this.texture('arrow.png'), alphaTest: 0.1, side: THREE.DoubleSide })
        this.arrowGeometry = arrowGeometry()
        // Burning mobs wear the fire block's flames (an animated strip: a frame a tick).
        const fire = new THREE.TextureLoader().load(`${base}/textures/block__fire_0.png`, (t) => {
            this.fireFrames = Math.max(1, Math.round(t.image.height / t.image.width))
            t.repeat.set(1, 1 / this.fireFrames)
        })
        fire.magFilter = THREE.NearestFilter
        fire.minFilter = THREE.NearestFilter
        fire.colorSpace = THREE.SRGBColorSpace
        this.fireMaterial = new THREE.MeshBasicMaterial({ map: fire, alphaTest: 0.1, side: THREE.DoubleSide, depthWrite: false, transparent: true })
        this.fireGeometry = crossedPlanes()
    }

    private texture(file: string) {
        let t = this.textures.get(file)
        if (!t) {
            t = new THREE.TextureLoader().load(`${this.base}/entity/${file}`)
            t.magFilter = THREE.NearestFilter
            t.minFilter = THREE.NearestFilter
            // Mob skins are mapped top-down (Minecraft's UVs); sprites the usual way up.
            t.flipY = file.startsWith('potion_')
            t.colorSpace = THREE.SRGBColorSpace
            this.textures.set(file, t)
        }
        return t
    }

    private create(m: Mob): View {
        const def = MODELS[m.kind]
        const skin = m.kind === 'cat' ? `cat_${CAT_VARIANTS[m.variant] ?? 'tabby'}.png` : def.texture
        const { material, flash } = mobMaterial(this.texture(skin), false)
        const body = build(def, material)
        const root = new THREE.Group()
        const death = new THREE.Group()
        const flip = new THREE.Group()
        const offset = new THREE.Group()
        // Minecraft scales after the flip and before the 1.501 drop, so the drop scales too.
        const scale = def.scale ?? 1
        offset.scale.setScalar(scale)
        offset.position.y = -1.501 * scale
        offset.add(body.root)
        const extraLayers: View['armor'] = []
        let layer: Record<string, THREE.Object3D> | null = null
        let layerMaterial: THREE.MeshBasicMaterial | null = null
        const extra = LAYERS[m.kind]
        if (extra) {
            const made = mobMaterial(this.texture(extra.def.texture), extra.glow)
            layerMaterial = made.material
            if (extra.flush) {
                made.material.polygonOffset = true
                made.material.polygonOffsetFactor = -1
                made.material.polygonOffsetUnits = -1
            }
            const built = build(extra.def, made.material)
            offset.add(built.root)
            layer = built.parts
        }
        // A villager's work clothes go over its plains clothes, a hair nearer still (a zombie
        // villager still wears what it worked in).
        if ((m.kind === 'villager' || m.kind === 'zombie_villager') && m.profession) {
            const file = `${m.kind === 'villager' ? '' : 'zombie_'}profession_${m.profession}.png`
            const made = mobMaterial(this.texture(file), false)
            made.material.polygonOffset = true
            made.material.polygonOffsetFactor = -2
            made.material.polygonOffsetUnits = -2
            const built = build({ ...MODELS[m.kind], texture: file }, made.material)
            offset.add(built.root)
            extraLayers.push({ parts: built.parts, material: made.material })
        }
        // A golem's cracks, over its skin on the same boxes.
        const cracks = m.kind === 'iron_golem' ? golemCracks(m) : null
        if (cracks) {
            const file = `iron_golem_crackiness_${cracks}.png`
            const made = mobMaterial(this.texture(file), false)
            made.material.polygonOffset = true
            made.material.polygonOffsetFactor = -1
            made.material.polygonOffsetUnits = -1
            const built = build({ ...def, texture: file }, made.material)
            offset.add(built.root)
            extraLayers.push({ parts: built.parts, material: made.material })
        }
        const armor: View['armor'] = extraLayers
        for (const [slot, key] of Object.entries(m.armor) as [ArmorSlot, string][]) {
            const a = item(key).armor
            if (!a) continue
            const def = armorModel(m.kind, slot, ARMOR_MATERIALS[a.material].texture)
            const made = mobMaterial(this.texture(def.texture), false)
            const built = build(def, made.material)
            offset.add(built.root)
            armor.push({ parts: built.parts, material: made.material })
        }
        flip.add(offset)
        // A squid leans about a point half a block up, its model drawn 1.2 lower (SquidRenderer).
        const lean = new THREE.Group()
        if (m.kind === 'squid') {
            lean.position.y = 0.5
            flip.position.y = -1.2
        }
        lean.add(flip)
        death.add(lean)
        root.add(death)
        const fire = new THREE.Mesh(this.fireGeometry, this.fireMaterial)
        fire.scale.set(m.def.width * 1.4, m.def.height, m.def.width * 1.4)
        fire.visible = false
        root.add(fire)
        this.scene.add(root)
        return { mob: m, key: viewKey(m), root, death, lean, flip, parts: body.parts, armor, layer, material, layerMaterial, flash, fire }
    }

    /**
     * Brings the drawing up to date with the mobs, `alpha` of the way from
     * the last tick to the next. `brightness` gives the light at a spot (0..1).
     */
    update(mobs: Mobs, alpha: number, dt: number, brightness: (x: number, y: number, z: number) => number) {
        this.clock += dt
        const seen = new Set<number>()
        for (const m of mobs.list) {
            seen.add(m.id)
            let view = this.views.get(m.id)
            if (view && view.key !== viewKey(m)) {
                this.drop(view)
                view = undefined
            }
            if (!view) {
                view = this.create(m)
                this.views.set(m.id, view)
            }
            this.pose(view, alpha, brightness)
        }
        for (const [id, view] of this.views) {
            if (seen.has(id)) continue
            this.drop(view)
            this.views.delete(id)
        }
        this.updateArrows(mobs.arrows, alpha)
        this.updatePotions(mobs.potions, alpha, brightness)
        const map = this.fireMaterial.map
        if (map) map.offset.y = 1 - (Math.floor(this.clock * 20) % this.fireFrames + 1) / this.fireFrames
    }

    private pose(v: View, a: number, brightness: (x: number, y: number, z: number) => number) {
        const m = v.mob
        const lerp = (p: number, c: number) => p + (c - p) * a
        const x = lerp(m.px, m.x), y = lerp(m.py, m.y), z = lerp(m.pz, m.z)
        const yaw = lerpAngle(m.prevYaw, m.yaw, a)
        const headYaw = lerpAngle(m.prevHeadYaw, m.headYaw, a)
        v.root.position.set(x, y, z)
        // A zombie villager being cured shakes (ZombieVillagerRenderer.isShaking).
        const shake = m.converting > 0 ? Math.cos((this.clock * 20) * 3.25) * 0.08 : 0
        v.root.rotation.y = Math.PI - yaw + shake
        // Dying: topple over onto its side in a second.
        const dying = m.dead ? Math.min(1, Math.sqrt(((m.deathTime + a - 1) / 20) * 1.6)) : 0
        v.death.rotation.z = dying * HALF_PI
        if (m.kind === 'squid') v.lean.rotation.x = lerp(m.swim.prevLean, m.swim.lean)
        // A creeper swells and flashes white as its fuse burns down (CreeperRenderer).
        let sx = 1, sy = 1
        if (m.kind === 'creeper' && v.flash) {
            const f = lerp(m.prevSwell, m.swell) / 28
            const g = 1 + Math.sin(f * 100) * f * 0.01
            const s = Math.min(1, Math.max(0, f)) ** 4
            sx = (1 + s * 0.4) * g
            sy = (1 + s * 0.1) / g
            v.flash.value = Math.floor(f * 10) % 2 === 0 ? 0 : Math.min(1, Math.max(0.5, f))
        }
        v.flip.scale.set(-sx, -sy, sx)

        const light = brightness(Math.floor(x), Math.floor(y + m.def.height / 2), Math.floor(z))
        const hurt = m.hurtTime > 0 || m.dead
        v.material.color.setRGB(light, hurt ? light * 0.55 : light, hurt ? light * 0.55 : light)
        if (v.layerMaterial && !LAYERS[m.kind]!.glow) v.layerMaterial.color.copy(v.material.color)
        // A sheep's coat takes its dye's colour (SheepWoolLayer), and is gone while it is shorn.
        if (m.kind === 'sheep' && v.layerMaterial && v.layer) {
            v.layerMaterial.color.multiply(this.tint.setHex(DYE_COLORS[m.color]?.[1] ?? 0xffffff))
            for (const part of Object.values(v.layer)) part.visible = !m.sheared
        }
        for (const a of v.armor) a.material.color.copy(v.material.color)
        v.fire.visible = m.fire > 0 && !m.dead

        const ls = m.limbSwing - m.limbAmount * (1 - a)
        const la = Math.min(1, lerp(m.prevLimbAmount, m.limbAmount))
        const head = {
            y: wrap(headYaw - yaw),
            x: m.pitch
        }
        for (const parts of [v.parts, v.layer, ...v.armor.map(x => x.parts)]) if (parts) this.animate(m, parts, ls, la, head, a)
    }

    /** Minecraft's setupAnim for each kind of model. */
    private animate(m: Mob, p: Record<string, THREE.Object3D>, ls: number, la: number, head: { x: number, y: number }, a: number) {
        const rest = (name: string) => {
            const part = p[name]
            if (part) part.rotation.set(...(part.userData.rest as V3))
            return part
        }
        for (const name of Object.keys(p)) rest(name)
        const set = (name: string, x?: number, y?: number, z?: number) => {
            const part = p[name]
            if (!part) return
            if (x !== undefined) part.rotation.x = x
            if (y !== undefined) part.rotation.y = y
            if (z !== undefined) part.rotation.z = z
        }
        const swing = (o = 0) => Math.cos(ls * 0.6662 + o) * 1.4 * la
        set('head', head.x, head.y)
        switch (m.kind) {
            case 'sheep': {
                // Eating (SheepModel): the head drops nine pixels and nods at the grass for the middle of it.
                const t = m.eating > 0 ? m.eating - a : 0
                const drop = t <= 0 ? 0 : t >= 4 && t <= 36 ? 1 : t < 4 ? t / 4 : -(t - 40) / 4
                const pivot = (p.head?.userData.pivot as V3 | undefined)?.[1] ?? 6
                if (p.head) p.head.position.y = (pivot + drop * 9) / 16
                if (t > 4 && t <= 36) set('head', 0.62831855 + 0.21991149 * Math.sin(((t - 4) / 32) * 28.7))
                else if (t > 0) set('head', Math.PI / 5)
                set('right_hind_leg', swing())
                set('left_hind_leg', swing(Math.PI))
                set('right_front_leg', swing(Math.PI))
                set('left_front_leg', swing())
                break
            }
            case 'squid':
                for (let i = 0; i < 8; i++) set(`tentacle${i}`, lerpNum(m.swim.prevSpread, m.swim.spread, a))
                break
            case 'cow':
            case 'pig':
            case 'creeper':
                set('right_hind_leg', swing())
                set('left_hind_leg', swing(Math.PI))
                set('right_front_leg', swing(Math.PI))
                set('left_front_leg', swing())
                break
            case 'chicken': {
                set('right_leg', swing())
                set('left_leg', swing(Math.PI))
                const flap = m.onGround ? 0 : (Math.sin((this.clock + a / 20) * 24) + 1) * 0.8
                set('right_wing', undefined, undefined, flap)
                set('left_wing', undefined, undefined, -flap)
                break
            }
            case 'villager':
                set('right_leg', swing() * 0.5)
                set('left_leg', swing(Math.PI) * 0.5)
                break
            case 'zombie':
            case 'zombie_villager': {
                set('right_leg', swing())
                set('left_leg', swing(Math.PI))
                // Arms out in front, raised higher when it's after you, and a chop when it hits.
                const t = m.swing > 0 ? 1 - (m.swing - a) / 6 : 0
                const f = Math.sin(t * Math.PI)
                const g = Math.sin((1 - (1 - t) * (1 - t)) * Math.PI)
                const raise = -Math.PI / (m.targeting ? 1.5 : 2.25) + f * 1.2 - g * 0.4
                const bob = Math.cos(this.clock * 1.8) * 0.05 + 0.05
                set('right_arm', raise, -(0.1 - f * 0.6), bob)
                set('left_arm', raise, 0.1 - f * 0.6, -bob)
                break
            }
            case 'witch': {
                set('right_leg', swing() * 0.5)
                set('left_leg', swing(Math.PI) * 0.5)
                // Drinking: the head tips back. Throwing: the arms jerk.
                if (m.drinking > 0) set('head', -0.6, head.y)
                if (m.swing > 0) set('arms', -0.75 - Math.sin((1 - (m.swing - a) / 6) * Math.PI) * 0.8)
                break
            }
            case 'skeleton': {
                set('right_leg', swing())
                set('left_leg', swing(Math.PI))
                if (m.draw > 0 || (m.targeting && m.seeTarget)) {
                    // Drawing the bow: both arms up and along its line of sight.
                    set('right_arm', -HALF_PI + head.x, -0.1 + head.y)
                    set('left_arm', -HALF_PI + head.x, 0.1 + head.y + 0.4)
                } else {
                    set('right_arm', Math.cos(ls * 0.6662 + Math.PI) * la)
                    set('left_arm', Math.cos(ls * 0.6662) * la)
                }
                break
            }
            case 'cat':
                // OcelotModel's walk: the legs a little out of step, the tail's tip swaying.
                set('left_hind_leg', Math.cos(ls * 0.6662) * la)
                set('right_hind_leg', Math.cos(ls * 0.6662 + 0.3) * la)
                set('left_front_leg', Math.cos(ls * 0.6662 + Math.PI + 0.3) * la)
                set('right_front_leg', Math.cos(ls * 0.6662 + Math.PI) * la)
                set('tail2', 1.7278761 + (Math.PI / 4) * Math.cos(ls) * la)
                break
            case 'iron_golem': {
                set('right_leg', -1.5 * triangleWave(ls, 13) * la)
                set('left_leg', 1.5 * triangleWave(ls, 13) * la)
                // A blow: both arms swing up and down over ten ticks; walking, they swing with the legs.
                if (m.swing > 0) {
                    const arms = -2 + 1.5 * triangleWave(m.swing - a, 10)
                    set('right_arm', arms)
                    set('left_arm', arms)
                } else {
                    set('right_arm', (-0.2 + 1.5 * triangleWave(ls, 13)) * la)
                    set('left_arm', (-0.2 - 1.5 * triangleWave(ls, 13)) * la)
                }
                break
            }
            case 'spider': {
                const q = Math.PI / 4
                const k = ls * 0.6662 * 2
                const legs: [string, number, number, number, number][] = [
                    ['hind', q, -q, 0, 0],
                    ['middle_hind', Math.PI / 8, -q * 0.74, Math.PI, Math.PI],
                    ['middle_front', -Math.PI / 8, -q * 0.74, HALF_PI, HALF_PI],
                    ['front', -q, -q, Math.PI * 1.5, Math.PI * 1.5]
                ]
                for (const [n, yRot, zRot, yo, zo] of legs) {
                    const h = -(Math.cos(k + yo) * 0.4) * la
                    const l = Math.abs(Math.sin(ls * 0.6662 + zo) * 0.4) * la
                    set(`right_${n}_leg`, undefined, yRot + h, zRot + l)
                    set(`left_${n}_leg`, undefined, -yRot - h, -zRot - l)
                }
                break
            }
        }
    }

    private updateArrows(list: Arrow[], a: number) {
        const seen = new Set<number>()
        for (const arrow of list) {
            seen.add(arrow.id)
            let obj = this.arrows.get(arrow.id)
            if (!obj) {
                obj = new THREE.Mesh(this.arrowGeometry, this.arrowMaterial)
                this.scene.add(obj)
                this.arrows.set(arrow.id, obj)
            }
            obj.position.set(arrow.px + (arrow.x - arrow.px) * a, arrow.py + (arrow.y - arrow.py) * a, arrow.pz + (arrow.z - arrow.pz) * a)
            // Point it along its flight (a stuck arrow keeps the last way it was going).
            if (!arrow.stuck) {
                const h = Math.hypot(arrow.vx, arrow.vz)
                obj.rotation.set(0, Math.atan2(arrow.vx, arrow.vz), 0, 'YXZ')
                obj.rotation.x = -Math.atan2(arrow.vy, h)
            }
        }
        for (const [id, obj] of this.arrows) {
            if (seen.has(id)) continue
            this.scene.remove(obj)
            this.arrows.delete(id)
        }
    }

    /** Takes a mob's drawing out of the scene and frees it. */
    private drop(view: View) {
        this.scene.remove(view.root)
        disposeTree(view.root, this.fireGeometry)
        view.material.dispose()
        view.layerMaterial?.dispose()
        for (const a of view.armor) a.material.dispose()
    }

    /** Thrown potions: the splash potion's item picture, facing the camera, a quarter block across. */
    private updatePotions(list: Potion[], a: number, brightness: (x: number, y: number, z: number) => number) {
        const seen = new Set<number>()
        for (const p of list) {
            seen.add(p.id)
            let sprite = this.potionSprites.get(p.id)
            if (!sprite) {
                sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture(`potion_${p.kind}.png`), alphaTest: 0.1 }))
                sprite.scale.setScalar(0.3)
                this.scene.add(sprite)
                this.potionSprites.set(p.id, sprite)
            }
            const x = p.px + (p.x - p.px) * a, y = p.py + (p.y - p.py) * a, z = p.pz + (p.z - p.pz) * a
            sprite.position.set(x, y, z)
            sprite.material.color.setScalar(brightness(Math.floor(x), Math.floor(y), Math.floor(z)))
        }
        for (const [id, sprite] of this.potionSprites) {
            if (seen.has(id)) continue
            this.scene.remove(sprite)
            sprite.material.dispose()
            this.potionSprites.delete(id)
        }
    }

    dispose() {
        for (const s of this.potionSprites.values()) {
            this.scene.remove(s)
            s.material.dispose()
        }
        this.potionSprites.clear()
        for (const v of this.views.values()) {
            this.scene.remove(v.root)
            disposeTree(v.root, this.fireGeometry)
            v.material.dispose()
            v.layerMaterial?.dispose()
            for (const a of v.armor) a.material.dispose()
        }
        this.views.clear()
        for (const obj of this.arrows.values()) this.scene.remove(obj)
        this.arrows.clear()
        for (const t of this.textures.values()) t.dispose()
        this.arrowMaterial.dispose()
        this.arrowGeometry.dispose()
        this.fireMaterial.map?.dispose()
        this.fireMaterial.dispose()
        this.fireGeometry.dispose()
    }
}

/** An arrow: two crossed strips, half a block long along +z, with the pack's arrow texture (32x32, shaft in the top 5 rows). */
function arrowGeometry() {
    const pos: number[] = [], uv: number[] = [], idx: number[] = []
    const len = 0.5, half = 0.08
    const strip = (ax: [number, number, number], bx: [number, number, number]) => {
        const base = pos.length / 3
        const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
        for (const [s, t] of corners) {
            pos.push(ax[0] * t * half + bx[0] * s * len / 2, ax[1] * t * half + bx[1] * s * len / 2, ax[2] * t * half + bx[2] * s * len / 2)
            uv.push((1 - (s + 1) / 2) * 0.5, ((t + 1) / 2) * (5 / 32))
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    strip([1, 0, 0], [0, 0, 1])
    strip([0, 1, 0], [0, 0, 1])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    return g
}

/**
 * A burning mob's flames, a unit tall standing on the origin: two bands of
 * crossed squares, the upper one turned 45 degrees, so the fire climbs the
 * whole body as Minecraft's entity fire does.
 */
function crossedPlanes() {
    const pos: number[] = [], uv: number[] = [], idx: number[] = []
    const plane = (angle: number, y0: number, y1: number) => {
        const c = Math.cos(angle) * 0.5, s = Math.sin(angle) * 0.5
        const base = pos.length / 3
        pos.push(-c, y0, -s, c, y0, s, c, y1, s, -c, y1, -s)
        uv.push(0, 0, 1, 0, 1, 1, 0, 1)
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    for (const [turn, y0, y1] of [[0, 0, 0.62], [Math.PI / 4, 0.42, 1.04]] as const) {
        plane(turn, y0, y1)
        plane(turn + Math.PI / 2, y0, y1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    return g
}

/** Frees a mob's own geometry (not `shared`, which every mob uses). */
function disposeTree(obj: THREE.Object3D, shared: THREE.BufferGeometry) {
    obj.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry !== shared) o.geometry.dispose()
    })
}

function wrap(a: number) {
    let d = a % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return d
}

function lerpNum(a: number, b: number, t: number) {
    return a + (b - a) * t
}

function lerpAngle(a: number, b: number, t: number) {
    return a + wrap(b - a) * t
}
