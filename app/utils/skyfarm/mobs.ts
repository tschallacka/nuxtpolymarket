import { randomChance, randomFloat, randomInt, randomPick } from '#shared/utils/random'
import type { ItemStack } from '#shared/utils/skyfarm/save'
import { B, block, solidRange, spawnableOn, WORKSTATIONS } from './blocks'
import { afterArmor, ARMOR_MATERIALS, ARMOR_SLOTS, armorKey, armorValue, attackStats, Slots, type ArmorMaterial, type ArmorSlot } from './items'
import { CURED_REPUTATION, levelFor, newOffers, type Offer } from './trades'
import { DYE_COLORS, woolKey } from './dyes'
import { CHUNK, type World } from './world'

/*
 * Mobs, Minecraft's way. Everything here runs in game ticks (1/20 s) and in
 * blocks per tick, on the island, with no rendering: the engine draws what
 * this leaves behind.
 *
 * Spawning follows Minecraft's natural spawner (NaturalSpawner): each tick,
 * each chunk near the player gets one try at a random spot in a random column
 * below its top block, from which up to three groups of up to four mobs
 * spread out. A spot must be more than 24 blocks from the player and from the
 * world spawn, on a block a mob can stand on, with room for its body.
 * Animals want grass and light 9 or more, and are only tried every 400 ticks;
 * monsters want darkness: no block light at all, sky light under a random
 * 0 to 31, and the light as dimmed by night at most a random 0 to 7. The
 * caps are a single player's: 70 monsters and 10 animals (the void around an
 * island is loaded, spawnable chunks too).
 */

export type MobKind = 'cow' | 'pig' | 'sheep' | 'chicken' | 'zombie' | 'skeleton' | 'creeper' | 'spider' | 'witch' | 'zombie_villager' | 'villager' | 'cat' | 'iron_golem' | 'squid'
/** Animals that spawn on grass. */
export const PASSIVE: MobKind[] = ['cow', 'pig', 'sheep', 'chicken']
export const HOSTILE: MobKind[] = ['zombie', 'zombie_villager', 'skeleton', 'creeper', 'spider', 'witch']
/** The undead: harming heals them, poison does nothing, daylight burns them. */
export const UNDEAD = new Set<MobKind>(['zombie', 'zombie_villager', 'skeleton'])
/** What the island keeps in a save: animals, villagers, cats and golems, and a zombie villager being cured (or that was a villager). */
export const SAVED_KINDS: MobKind[] = [...PASSIVE, 'villager', 'zombie_villager', 'cat', 'iron_golem']
/** A village cat's coat, as the save numbers them (Minecraft's, less the all-black witch's cat): append only. */
export const CAT_VARIANTS = ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie'] as const
/** Zombies, who hunt villagers. */
const ZOMBIES = new Set<MobKind>(['zombie', 'zombie_villager'])
/** A saved sheep's `v`: its colour, plus this bit once shorn. */
export const SHEARED = 16
/** Most squid about at once (Minecraft's water creature cap). */
const SQUID_CAP = 5
/** Ticks a squid lasts out of water before it starts to suffocate (Minecraft's air supply). */
const SQUID_AIR = 300

/**
 * A new sheep's colour (Sheep.getRandomSheepColor): one in twenty each black,
 * gray and light gray, one in five hundred pink, the rest white (Minecraft's
 * three in a hundred brown are white here: there is no brown).
 */
export function sheepColor(roll = randomFloat): number {
    const r = Math.floor(roll() * 100)
    const pick = r < 5 ? 'black' : r < 10 ? 'gray' : r < 15 ? 'light_gray' : roll() < 1 / 500 ? 'pink' : 'white'
    return DYE_COLORS.findIndex(([c]) => c === pick)
}

/** Splash potions: harming at once, the others for a while. */
export type PotionKind = 'harming' | 'poison' | 'slowness' | 'weakness'
/** Effects on you or a mob, in ticks left (regeneration from a golden apple). */
export interface Effects {
    poison: number
    slowness: number
    weakness: number
    regeneration: number
}
export const noEffects = (): Effects => ({ poison: 0, slowness: 0, weakness: 0, regeneration: 0 })
/** How long a splash potion's effect lasts at the heart of the splash (Minecraft's potion durations). */
export const POTION_TICKS: Record<Exclude<PotionKind, 'harming'>, number> = { poison: 900, slowness: 1800, weakness: 1800 }
/** A golden apple cures a zombie villager under weakness every time; without it, one time in ten. */
export const CURE_WITHOUT_WEAKNESS = 0.1
/** A villager's own inventory, as in Minecraft. */
export const VILLAGER_SLOTS = 8
/** A farmer works crops this far (blocks) from its composter, and gives a task up after this many ticks. */
const FARM_RANGE = 6
const FARM_GIVE_UP = 200
const FARM_SPEED = 0.7
/** Seeds a farmer keeps to sow (the rest it composts), and wheat it holds before sharing the extra. */
const KEEP_SEEDS = 16
const SHARE_WHEAT = 12
/** Spare seeds a farmer gathers before it takes them to the composter. */
const COMPOST_AT = 8

/** A witch's loot: one to three picks of nought to two each, sticks twice as likely (Minecraft's witch loot table). */
function witchDrops(): ItemStack[] {
    const table: [string, number][] = [['glowstone_dust', 1], ['sugar', 1], ['redstone', 1], ['spider_eye', 1], ['glass_bottle', 1], ['gunpowder', 1], ['stick', 2]]
    const total = table.reduce((s, [, w]) => s + w, 0)
    const out = new Map<string, number>()
    for (let roll = n(1, 3); roll > 0; roll--) {
        let r = randomFloat() * total
        const pick = table.find(([, w]) => (r -= w) < 0)![0]
        out.set(pick, (out.get(pick) ?? 0) + n(0, 2))
    }
    return stacks(...out)
}

const n = (lo: number, hi: number) => lo + Math.floor(randomFloat() * (hi - lo + 1))

interface MobDef {
    hostile: boolean
    health: number
    width: number
    height: number
    eye: number
    /** Minecraft's movement speed attribute. */
    speed: number
    /** How much faster it runs when hurt. */
    panic?: number
    /** What it follows when you hold it, and how fast. */
    tempt?: string[]
    temptSpeed?: number
    /** Spawn weight, as on plains. */
    weight: number
    /** Undead: catches fire in daylight. */
    burns?: boolean
    /** Melee damage (normal difficulty). */
    attack?: number
    /** How far away it notices you. */
    follow?: number
    /** Most that spawn together (Minecraft's group size); 4 unless said. */
    group?: number
    /** What it drops: `fire` when it died burning (meat comes out cooked). */
    drops: (fire: boolean, byPlayer: boolean, m: Mob) => ItemStack[]
}

const stacks = (...list: [string, number][]) => list.filter(([, c]) => c > 0).map(([item, count]) => ({ item, count }))

export const MOBS: Record<MobKind, MobDef> = {
    cow: { hostile: false, health: 10, width: 0.9, height: 1.4, eye: 1.3, speed: 0.2, panic: 2, tempt: ['wheat'], temptSpeed: 1.25, weight: 8, drops: f => stacks(['leather', n(0, 2)], [f ? 'cooked_beef' : 'beef', n(1, 3)]) },
    pig: { hostile: false, health: 10, width: 0.9, height: 0.9, eye: 0.8, speed: 0.25, panic: 1.25, weight: 10, drops: f => stacks([f ? 'cooked_porkchop' : 'porkchop', n(1, 3)]) },
    sheep: { hostile: false, health: 8, width: 0.9, height: 1.3, eye: 1.2, speed: 0.23, panic: 1.25, tempt: ['wheat'], temptSpeed: 1.1, weight: 12, drops: (f, _, m) => stacks([woolKey(DYE_COLORS[m.color]?.[0] ?? 'white'), m.sheared ? 0 : 1], [f ? 'cooked_mutton' : 'mutton', n(1, 2)]) },
    chicken: { hostile: false, health: 4, width: 0.4, height: 0.7, eye: 0.6, speed: 0.25, panic: 1.4, tempt: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds'], temptSpeed: 1, weight: 10, drops: f => stacks(['feather', n(0, 2)], [f ? 'cooked_chicken' : 'chicken', 1]) },
    // Zombies now and then drop an iron ingot when you kill them (2.5%).
    zombie: { hostile: true, health: 20, width: 0.6, height: 1.95, eye: 1.74, speed: 0.23, burns: true, attack: 3, follow: 35, weight: 95, drops: (_, p) => stacks(['rotten_flesh', n(0, 2)], ['iron_ingot', p && randomFloat() < 0.025 ? 1 : 0]) },
    // A zombie in all but looks; one in twenty zombies (Minecraft's 5 against 95). A golden apple can cure it.
    zombie_villager: { hostile: true, health: 20, width: 0.6, height: 1.95, eye: 1.74, speed: 0.23, burns: true, attack: 3, follow: 35, weight: 5, drops: (_, p) => stacks(['rotten_flesh', n(0, 2)], ['iron_ingot', p && randomFloat() < 0.025 ? 1 : 0]) },
    // What a cured zombie villager becomes: wanders, runs when hit, never spawns on its own.
    // Speed: Minecraft's 0.5 at its usual half-speed stroll.
    villager: { hostile: false, health: 20, width: 0.6, height: 1.95, eye: 1.62, speed: 0.25, panic: 1.5, weight: 0, drops: () => [] },
    skeleton: { hostile: true, health: 20, width: 0.6, height: 1.99, eye: 1.74, speed: 0.25, burns: true, follow: 16, weight: 100, drops: () => stacks(['arrow', n(0, 2)], ['bone', n(0, 2)]) },
    creeper: { hostile: true, health: 20, width: 0.6, height: 1.7, eye: 1.45, speed: 0.25, follow: 16, weight: 100, drops: () => stacks(['gunpowder', n(0, 2)]) },
    // A spider killed by you drops an eye one time in three.
    spider: { hostile: true, health: 16, width: 1.4, height: 0.9, eye: 0.65, speed: 0.3, attack: 2, follow: 16, weight: 100, drops: (_, p) => stacks(['string', n(0, 2)], ['spider_eye', p && randomFloat() < 1 / 3 ? 1 : 0]) },
    // Rare (5 against the others' 100) and alone; throws potions, drinks them, doesn't burn.
    witch: { hostile: true, health: 26, width: 0.6, height: 1.95, eye: 1.62, speed: 0.25, follow: 16, weight: 5, group: 1, drops: witchDrops },
    // A stray village cat: keeps away from you, and creepers keep away from it.
    cat: { hostile: false, health: 10, width: 0.6, height: 0.7, eye: 0.6, speed: 0.3, panic: 1.5, weight: 0, drops: () => stacks(['string', n(0, 2)]) },
    // Villagers call one up when scared or gossiping; it fights monsters for them (not creepers).
    iron_golem: { hostile: false, health: 100, width: 1.4, height: 2.7, eye: 2.3, speed: 0.25, attack: 15, follow: 16, weight: 0, drops: () => stacks(['iron_ingot', n(3, 5)], ['poppy', n(0, 2)]) },
    // Spawns in water three or more deep; swims in spurts, darts off when hit, suffocates on land.
    squid: { hostile: false, health: 10, width: 0.8, height: 0.8, eye: 0.4, speed: 0, panic: 1, weight: 0, group: 4, drops: () => stacks(['ink_sac', n(1, 3)]) }
}

/** Minecraft's brightness for a light level (0..15): what the undead and spiders go by. */
export function brightness(level: number) {
    const f = Math.max(0, Math.min(15, level)) / 15
    return f / (4 - 3 * f)
}

/** A path node: a cell a mob's feet can be in. */
type Node = [number, number, number]

let nextId = 1

export class Mob {
    readonly id = nextId++
    readonly def: MobDef
    // Position (feet, centre), and where it was a tick ago (the renderer blends between them).
    px: number
    py: number
    pz: number
    vx = 0
    vy = 0
    vz = 0
    yaw: number
    prevYaw: number
    /** Where it looks: the head turns on its own, within reason. */
    headYaw: number
    prevHeadYaw: number
    pitch = 0
    onGround = false
    inWater = false
    hitWall = false
    fall = 0
    health: number
    /** Ticks left of the red hurt flash, and of not taking the same hit again. */
    hurtTime = 0
    invulnerable = 0
    private lastHurt = 0
    /** Ticks since it died (it topples over, then is gone at 20). */
    deathTime = -1
    /** Ticks left burning. */
    fire = 0
    /** Walk direction (unit, or zero), speed modifier, and whether to jump this tick. */
    moveX = 0
    moveZ = 0
    moveSpeed = 0
    jump = false
    path: { nodes: Node[], i: number, goal: Node } | null = null
    pathAge = 0
    stuck = 0
    panic = 0
    lookTicks = 0
    // Hostile state.
    targeting = false
    angry = false
    seeTarget = false
    seeTime = 0
    attackCooldown = 0
    /** Ticks into drawing the bow (skeleton), 0 when not. */
    draw = 0
    /** Ticks the arm swing has left (zombie attack). */
    swing = 0
    /** Witch: ticks left drinking a potion (it stands still meanwhile), which one, and what it has on. */
    drinking = 0
    drink: 'healing' | 'fire_resistance' | 'swiftness' | null = null
    fireResistant = 0
    swift = 0
    /** Creeper: fuse ticks (0..30) and which way it is going. */
    swell = 0
    prevSwell = 0
    swellDir = -1
    /** For the walking animation: how far the legs have swung, and how hard. */
    limbSwing = 0
    limbAmount = 0
    prevLimbAmount = 0
    /** Monsters far from the player for a while despawn. */
    idle = 0
    /** What it wears (item keys by slot) and holds: zombies and skeletons sometimes spawn in armour. */
    armor: Partial<Record<ArmorSlot, string>> = {}
    held: string | null = null
    /** Potion effects on it (from splash potions), in ticks. */
    effects: Effects = noEffects()
    /** A zombie villager being cured: ticks until it is a villager again (0: not being cured). */
    converting = 0
    /** A villager's trade (null: none yet), and the workstation it claimed or is heading for. */
    profession: string | null = null
    site: [number, number, number] | null = null
    /** Its trades, experience and level (1 Novice to 5 Master), and ticks until a pending level-up. */
    offers: Offer[] = []
    xp = 0
    level = 1
    levelUp = 0
    /** How it thinks of you: curing it earns a lot, and it trades cheaper for it. */
    reputation = 0
    /** Restocking: the day it last counted, how many times today, and when last; and how long it has been without work. */
    restockDay = -1
    restocks = 0
    lastRestock = -1e9
    jobless = 0
    /** A villager's own eight slots: a farmer keeps its seeds and harvest here. */
    inv = new Slots(VILLAGER_SLOTS)
    /** A farmer's task in hand: the crop to harvest, the farmland to sow or its composter, and how long it has tried. */
    farmJob: { x: number, y: number, z: number, task: 'harvest' | 'sow' | 'compost', ticks: number } | null = null
    /** A mob it is after instead of you: one that hurt it (`revenge`), or a villager or golem a zombie hunts. */
    foe: Mob | null = null
    revenge = false
    /** The nearest of what it keeps away from (a zombie, a cat), looked for every few ticks. */
    threat: Mob | null = null
    /** Running from something this tick, and last tick (a new flight drops the old path). */
    fleeing = false
    fled = false
    /** Gone from the island (despawned, cured, turned): no longer anyone's foe. */
    removed = false
    /** A cat's coat (CAT_VARIANTS). */
    variant = 0
    /** A zombie villager that was a villager: it stays, and is saved, as Minecraft keeps it. */
    keep = false
    /** A villager: when it last saw an iron golem nearby, and last gossiped. */
    golemSeen = -1e9
    gossipAt = -1e9
    /** An iron golem: ticks left of being angry with you (you hit it). */
    anger = 0
    /** A sheep: its colour (DYE_COLORS), whether it is shorn, and ticks left of eating grass (head down). */
    color = 0
    sheared = false
    eating = 0
    /**
     * A squid (Squid.aiStep): where it is heading (a tick's worth, before the
     * spurt), the spurt's speed, the tentacles' stroke (0..2 pi) and how fast
     * it runs, the tentacles' spread now and a tick ago, how the body leans,
     * and its air out of water.
     */
    swim = { tx: 0, ty: 0, tz: 0, speed: 0, stroke: 0, strokeSpeed: 0.1, spread: 0, prevSpread: 0, lean: 0, prevLean: 0, air: SQUID_AIR, idle: 0 }

    constructor(readonly kind: MobKind, public x: number, public y: number, public z: number, yaw = randomFloat() * Math.PI * 2, health?: number) {
        this.def = MOBS[kind]
        this.px = x
        this.py = y
        this.pz = z
        this.yaw = this.prevYaw = this.headYaw = this.prevHeadYaw = yaw
        this.health = health ?? this.def.health
    }

    get dead() {
        return this.deathTime >= 0
    }

    get hostile() {
        return this.def.hostile
    }

    /** Takes damage. Minecraft's hurt cooldown: within half a second of a hit only a harder one counts, for the difference. */
    damage(amount: number): boolean {
        if (this.dead || amount <= 0) return false
        let dealt = amount
        if (this.invulnerable > 10) {
            if (amount <= this.lastHurt) return false
            dealt = amount - this.lastHurt
        } else {
            this.invulnerable = 20
            this.hurtTime = 10
        }
        this.lastHurt = amount
        this.health -= dealt
        return true
    }
}

export interface Arrow {
    id: number
    x: number
    y: number
    z: number
    px: number
    py: number
    pz: number
    vx: number
    vy: number
    vz: number
    stuck: boolean
    life: number
    owner: number
}

/** The player as the mobs see them. `active`: in the game (not paused), so mobs may hunt them. */
export interface MobTarget {
    x: number
    y: number
    z: number
    active: boolean
    held: string | null
    /** A witch picks its potion by these. */
    health?: number
    effects?: Effects
    /** Set when the target is another mob rather than you. */
    mob?: Mob
}

/** Whether a mob is still about: not dead, not taken off the island. */
const alive = (m: Mob) => !m.dead && !m.removed
const dist2 = (a: { x: number, y: number, z: number }, b: { x: number, y: number, z: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
/** Another mob as a target, the way the player is one. */
const asTarget = (o: Mob): MobTarget => ({ x: o.x, y: o.y, z: o.z, active: true, held: null, health: o.health, effects: o.effects, mob: o })
/** Eye height of a target (you, or a mob). */
const eyeOf = (t: MobTarget) => t.mob ? t.mob.def.eye : 1.62

/** A thrown splash potion, in flight. */
export interface Potion {
    id: number
    kind: PotionKind
    x: number
    y: number
    z: number
    px: number
    py: number
    pz: number
    vx: number
    vy: number
    vz: number
    /** The mob that threw it, or PLAYER for you. */
    owner: number
    /** Ticks in flight (your own potion can't hit you as it leaves your hand). */
    life: number
}

/** The thrower id of a potion you threw. */
export const PLAYER = -1

export interface MobEnv {
    /** Minecraft's sky darkening: 0 at noon, 11 at midnight (less with rain about). */
    skyDarken: number
    raining: boolean
    thundering: boolean
    spawn: { x: number, y: number, z: number }
    /** Every workstation on the island, by position "x,y,z", with its block id. */
    jobSites: Map<string, number>
    /** Which day it is (villagers restock twice a day). */
    day: number
}

export interface MobHooks {
    /** `byPlayer`: you killed it (or cured it), so it isn't the island's own production. */
    drop: (x: number, y: number, z: number, stack: ItemStack, byPlayer?: boolean) => void
    /** A mob or an arrow hit the player for `amount`, from (fx, fz). Returns whether it hurt. */
    hurtPlayer: (amount: number, fx: number, fz: number) => boolean
    /** A creeper went off at (x, y, z) with this power: break blocks, then hurt what is near (blast()). */
    explode: (x: number, y: number, z: number, power: number) => void
    /** A splash potion caught you: `scale` is 1 at the heart of the splash, falling to 0 four blocks out. */
    splashPlayer: (kind: PotionKind, scale: number) => void
    sound: (name: 'hurt' | 'fuse' | 'bow' | 'arrowHit' | 'potion' | 'drink' | 'cure', x: number, y: number, z: number, pitch?: number) => void
    /** A farmer breaks the ripe crop at (x, y, z): what it drops. */
    harvest: (x: number, y: number, z: number) => ItemStack[]
    /** A farmer puts items in the composter at (x, y, z): how many it didn't take. */
    compost: (x: number, y: number, z: number, stack: ItemStack) => number
}

export const PLAYER_WIDTH = 0.6
export const PLAYER_HEIGHT = 1.8

const CAP = { hostile: 70, passive: 10 }
/** No mob spawns within this of the player or the world spawn (24 blocks), nor (a monster) beyond 128. */
const NEAR_SQ = 24 * 24
const FAR_SQ = 128 * 128
const STEP_UP = 0.6

export class Mobs {
    list: Mob[] = []
    arrows: Arrow[] = []
    potions: Potion[] = []
    /** The villager you are trading with (it stands still), if any. */
    trader: number | null = null
    /** Off: villagers don't farm (a test that wants them still). */
    farming = true
    /** The player, when there is one to hunt or avoid (null while catching up on time away). */
    target: MobTarget | null = null
    tick = 0
    private arrowIds = 1

    constructor(
        private readonly world: World,
        private readonly light: (x: number, y: number, z: number) => [number, number],
        private readonly env: () => MobEnv,
        readonly hooks: MobHooks
    ) {}

    /** One game tick for every mob and arrow, and the spawner. */
    step() {
        this.tick++
        const env = this.env()
        for (const m of this.list) this.stepMob(m, env)
        this.list = this.list.filter((m) => {
            const stays = !(m.dead && m.deathTime >= 20) && m.y > -64
            if (!stays) m.removed = true
            return stays
        })
        this.push()
        this.stepArrows()
        this.stepPotions()
        this.despawn()
        this.spawn(env)
    }

    /** Living monsters, or living animals (villagers aren't animals: they don't count against the cap). */
    count(hostile: boolean) {
        let c = 0
        for (const m of this.list) if (!m.dead && (hostile ? m.hostile : PASSIVE.includes(m.kind))) c++
        return c
    }

    // ── Spawning ───────────────────────────────────────────────────────

    private spawn(env: MobEnv) {
        const t = this.target
        if (!t) return
        // Monsters every tick (not while it's paused: there is no one to hunt), animals every 400.
        if (t.active && this.count(true) < CAP.hostile) this.spawnCategory(true, env)
        if (this.tick % 400 === 0 && this.count(false) < CAP.passive) this.spawnCategory(false, env)
        if (this.tick % 1200 === 0) this.spawnCat()
        // Squid, every tick (a water creature, like a monster, despawns rather than stays).
        let squid = this.list.filter(m => m.kind === 'squid' && !m.dead).length
        if (squid < SQUID_CAP) {
            const pcx = Math.floor(t.x / CHUNK), pcz = Math.floor(t.z / CHUNK)
            for (const chunk of this.world.chunks.values()) {
                if (squid >= SQUID_CAP) break
                if (Math.abs(chunk.cx - pcx) > 8 || Math.abs(chunk.cz - pcz) > 8) continue
                squid += this.spawnSquid(chunk.cx, chunk.cz, env, SQUID_CAP - squid)
            }
        }
    }

    /**
     * One squid spawn try in a chunk (NaturalSpawner, as for the others): a
     * random spot below the column's top, then a group of up to four spread
     * out from it, each in water with water above and below it (Squid's
     * checkSurfaceWaterAnimalSpawnRules: water three deep). At most `room` (the cap).
     */
    spawnSquid(cx: number, cz: number, env: MobEnv, room = 4): number {
        const x0 = cx * CHUNK + randomInt(0, CHUNK - 1), z0 = cz * CHUNK + randomInt(0, CHUNK - 1)
        const top = this.world.top(x0, z0)
        if (top < 1) return 0
        const y = randomInt(1, top)
        if (this.world.get(x0, y, z0) !== B.Water) return 0
        let spawned = 0
        let x = x0, z = z0
        for (let i = 0; i < 4 && spawned < room; i++) {
            if (i > 0) {
                x += randomInt(0, 5) - randomInt(0, 5)
                z += randomInt(0, 5) - randomInt(0, 5)
            }
            if (!this.farEnough(x + 0.5, y, z + 0.5, true, env) || !this.canSpawn('squid', x, y, z, env)) continue
            this.list.push(new Mob('squid', x + 0.5, y, z + 0.5))
            spawned++
        }
        return spawned
    }

    /**
     * Minecraft's CatSpawner, once a minute: a stray cat turns up in a village
     * that has fewer than five cats within 48 blocks. A village there wants
     * four claimed beds; here four villagers within 48 blocks stand in for them.
     */
    spawnCat(): Mob | null {
        const villagers = this.list.filter(o => o.kind === 'villager' && alive(o))
        if (villagers.length < 4) return null
        const v = randomPick(villagers)
        const within = (kind: MobKind) => this.list.filter(o => o.kind === kind && alive(o) && dist2(o, v) < 48 * 48).length
        if (within('villager') < 4 || within('cat') >= 5) return null
        const probe = new Mob('cat', v.x, v.y, v.z)
        for (let i = 0; i < 10; i++) {
            const x = Math.floor(v.x) + randomInt(-8, 8), z = Math.floor(v.z) + randomInt(-8, 8)
            for (let y = Math.floor(v.y) + 4; y >= Math.floor(v.y) - 4; y--) {
                if (!this.standable(x, y, z, probe) || this.world.get(x, y, z) === B.Water) continue
                const cat = new Mob('cat', x + 0.5, y, z + 0.5)
                cat.variant = randomInt(0, CAT_VARIANTS.length - 1)
                this.list.push(cat)
                return cat
            }
        }
        return null
    }

    private spawnCategory(hostile: boolean, env: MobEnv) {
        const t = this.target!
        const pcx = Math.floor(t.x / CHUNK), pcz = Math.floor(t.z / CHUNK)
        for (const chunk of this.world.chunks.values()) {
            // Chunks within eight of the player's.
            if (Math.abs(chunk.cx - pcx) > 8 || Math.abs(chunk.cz - pcz) > 8) continue
            this.spawnInChunk(chunk.cx, chunk.cz, hostile, env)
        }
    }

    /** One spawn try in a chunk, as NaturalSpawner.spawnCategoryForPosition does it. Returns how many spawned. */
    spawnInChunk(cx: number, cz: number, hostile: boolean, env: MobEnv): number {
        const x0 = cx * CHUNK + randomInt(0, CHUNK - 1), z0 = cz * CHUNK + randomInt(0, CHUNK - 1)
        const top = this.world.top(x0, z0)
        if (top < 0) return 0
        const y = randomInt(0, top + 1)
        if (block(this.world.get(x0, y, z0)).solid) return 0
        let spawned = 0
        let kind: MobKind | null = null
        for (let group = 0; group < 3; group++) {
            let x = x0, z = z0
            const size = Math.ceil(randomFloat() * 4)
            for (let i = 0; i < size; i++) {
                x += randomInt(0, 5) - randomInt(0, 5)
                z += randomInt(0, 5) - randomInt(0, 5)
                const cx2 = x + 0.5, cz2 = z + 0.5
                if (!this.farEnough(cx2, y, cz2, hostile, env)) continue
                kind ??= this.pickKind(hostile)
                if (!this.canSpawn(kind, x, y, z, env)) continue
                const mob = new Mob(kind, cx2, y, cz2)
                equip(mob)
                if (kind === 'sheep') mob.color = sheepColor()
                // A zombie villager had a trade once (or none), and still wears it.
                if (kind === 'zombie_villager') {
                    const trades = Object.values(WORKSTATIONS) as string[]
                    mob.profession = randomPick([...trades, null])
                }
                this.list.push(mob)
                spawned++
                if (spawned >= (MOBS[kind].group ?? 4)) return spawned
            }
        }
        return spawned
    }

    private farEnough(x: number, y: number, z: number, hostile: boolean, env: MobEnv) {
        const t = this.target
        if (t) {
            const d = (t.x - x) ** 2 + (t.y - y) ** 2 + (t.z - z) ** 2
            if (d <= NEAR_SQ) return false
            // A monster that far would despawn at once.
            if (hostile && d > FAR_SQ) return false
        }
        const s = env.spawn
        return (s.x - x) ** 2 + (s.y - y) ** 2 + (s.z - z) ** 2 > NEAR_SQ
    }

    private pickKind(hostile: boolean): MobKind {
        const kinds = hostile ? HOSTILE : PASSIVE
        let r = randomFloat() * kinds.reduce((s, k) => s + MOBS[k].weight, 0)
        for (const k of kinds) {
            r -= MOBS[k].weight
            if (r < 0) return k
        }
        return kinds[kinds.length - 1]!
    }

    /** Whether a `kind` can spawn with its feet in cell (x, y, z): Minecraft's placement and spawn rules. */
    canSpawn(kind: MobKind, x: number, y: number, z: number, env: MobEnv): boolean {
        const def = MOBS[kind]
        const w = this.world
        if (kind === 'squid') return w.get(x, y, z) === B.Water && w.get(x, y - 1, z) === B.Water && w.get(x, y + 1, z) === B.Water
        const below = w.get(x, y - 1, z)
        if (!spawnableOn(below, w.meta(x, y - 1, z))) return false
        // Room to stand: no fluid at its feet, nothing solid in the way of its body.
        if (w.get(x, y, z) === B.Water || w.get(x, y, z) === B.Lava) return false
        if (this.collides(x + 0.5, y, z + 0.5, def.width / 2, def.height)) return false
        const [sky, glow] = this.light(x, y, z)
        if (!def.hostile) {
            // Animals: on grass, in light 9 or more (Animal.checkAnimalSpawnRules).
            return below === B.Grass && Math.max(sky, glow) >= 9
        }
        // Monsters (Monster.isDarkEnoughToSpawn).
        if (sky > randomInt(0, 31)) return false
        if (glow > 0) return false
        const darken = env.thundering ? 10 : env.skyDarken
        return Math.max(glow, sky - darken) <= randomInt(0, 7)
    }

    /** Monsters far from the player despawn: at once beyond 128 blocks, now and then beyond 32. Animals stay. */
    private despawn() {
        const t = this.target
        if (!t) return
        this.list = this.list.filter((m) => {
            // One being cured stays, as in Minecraft.
            if ((!m.hostile && m.kind !== 'squid') || m.dead || m.converting > 0 || m.keep) return true
            const d = (m.x - t.x) ** 2 + (m.y - t.y) ** 2 + (m.z - t.z) ** 2
            if (d < 32 * 32) m.idle = 0
            const stays = d <= FAR_SQ && !(m.idle > 600 && d > 32 * 32 && randomInt(0, 799) === 0)
            if (!stays) m.removed = true
            return stays
        })
    }

    // ── One mob, one tick ──────────────────────────────────────────────

    private stepMob(m: Mob, env: MobEnv) {
        m.px = m.x
        m.py = m.y
        m.pz = m.z
        m.prevYaw = m.yaw
        m.prevHeadYaw = m.headYaw
        m.prevSwell = m.swell
        m.prevLimbAmount = m.limbAmount
        if (m.dead) {
            m.deathTime++
            return
        }
        if (m.hurtTime > 0) m.hurtTime--
        if (m.invulnerable > 0) m.invulnerable--
        if (m.attackCooldown > 0) m.attackCooldown--
        if (m.swing > 0) m.swing--
        m.idle++
        this.hazards(m, env)
        if (m.dead) return
        m.moveX = m.moveZ = 0
        m.jump = false
        m.fled = m.fleeing
        m.fleeing = false
        if (m.kind === 'witch') this.witchDrink(m)
        this.mobEffects(m)
        if (m.dead) return
        if (m.converting > 0 && --m.converting === 0) {
            this.cure(m)
            return
        }
        if (m.hostile) this.hostileAi(m, env)
        else if (m.kind === 'villager') this.villagerAi(m, env)
        else if (m.kind === 'iron_golem') this.golemAi(m)
        else if (m.kind === 'cat') this.catAi(m)
        else if (m.kind === 'squid') this.squidAi(m)
        else this.passiveAi(m)
        // Drinking roots a witch to the spot; a swiftness potion makes it quicker, slowness slower.
        if (m.drinking > 0) m.moveSpeed = 0
        else if (m.swift > 0) m.moveSpeed *= 1.2
        if (m.effects.slowness > 0) m.moveSpeed *= 0.85
        this.physics(m)
        // Legs swing with how far it walked this tick.
        const moved = Math.hypot(m.x - m.px, m.z - m.pz)
        m.limbAmount += (Math.min(1, moved * 4) - m.limbAmount) * 0.4
        m.limbSwing += m.limbAmount
    }

    /** Fire, lava, sunlight and the void. */
    private hazards(m: Mob, env: MobEnv) {
        const w = this.world
        const fx = Math.floor(m.x), fy = Math.floor(m.y + 0.1), fz = Math.floor(m.z)
        const feet = w.get(fx, fy, fz)
        const mid = w.get(fx, Math.floor(m.y + m.def.height / 2), fz)
        const sky = w.top(fx, fz) < Math.floor(m.y + m.def.eye)
        const wet = m.inWater || (env.raining && sky)
        if (m.fireResistant > 0) {
            m.fireResistant--
            m.fire = 0
        } else if (feet === B.Lava || mid === B.Lava) {
            this.hurt(m, 4)
            m.fire = Math.max(m.fire, 300)
        } else if (feet === B.Fire) {
            this.hurt(m, 1)
            m.fire = Math.max(m.fire, 160)
        }
        if (wet) m.fire = 0
        // The undead burn in daylight under open sky (Mob.isSunBurnTick), unless a helmet shades them.
        if (m.def.burns && !m.armor.head && env.skyDarken < 4 && !wet && sky) {
            const [s, b] = this.light(fx, Math.floor(m.y + m.def.eye), fz)
            const f = brightness(Math.max(b, s - env.skyDarken))
            if (f > 0.5 && randomFloat() * 30 < (f - 0.4) * 2) m.fire = Math.max(m.fire, 160)
        }
        if (m.fire > 0) {
            m.fire--
            if (m.fire % 20 === 0) this.hurt(m, 1)
        }
    }

    // ── AI ─────────────────────────────────────────────────────────────

    private passiveAi(m: Mob) {
        const t = this.target
        const def = m.def
        // Panic after being hurt: run somewhere nearby, fast.
        if (m.panic > 0) {
            m.panic--
            if (!m.path || m.pathAge > 40) this.wander(m, 5, 4)
            this.follow(m, def.panic ?? 1.25)
            return
        }
        // A sheep eating grass keeps its head down for two seconds, and eats near the end.
        if (m.eating > 0) {
            m.path = null
            if (--m.eating === 4) this.eatGrass(m)
            return
        }
        // Follow you while you hold what it likes.
        if (t && t.active && def.tempt && t.held && def.tempt.includes(t.held)) {
            const d = Math.hypot(t.x - m.x, t.y - m.y, t.z - m.z)
            if (d < 10) {
                this.lookAt(m, t.x, t.y + 1.62, t.z)
                if (d > 2.5) {
                    if (!m.path || m.pathAge > 20) this.pathTo(m, Math.floor(t.x), Math.floor(t.y), Math.floor(t.z))
                    this.follow(m, def.temptSpeed ?? 1)
                } else {
                    m.path = null
                }
                return
            }
        }
        // Now and then (one tick in a thousand) a sheep stops to eat the grass it stands on.
        if (m.kind === 'sheep' && randomInt(0, 999) === 0 && this.grassAt(m)) {
            m.eating = 40
            m.path = null
            return
        }
        this.idleAi(m)
    }

    /** The grass a sheep would eat: short grass where it stands, or the grass block under it. */
    private grassAt(m: Mob): [number, number, number] | null {
        const x = Math.floor(m.x), y = Math.floor(m.y + 0.01), z = Math.floor(m.z)
        if (this.world.get(x, y, z) === B.TallGrass) return [x, y, z]
        if (this.world.get(x, y - 1, z) === B.Grass) return [x, y - 1, z]
        return null
    }

    /**
     * A sheep eats (EatBlockGoal): short grass is gone, a grass block turns
     * to dirt, and a shorn sheep grows its wool back.
     */
    private eatGrass(m: Mob) {
        const at = this.grassAt(m)
        if (!at) return
        const [x, y, z] = at
        this.world.set(x, y, z, this.world.get(x, y, z) === B.TallGrass ? B.Air : B.Dirt)
        m.sheared = false
    }

    /** Shears a sheep: one to three wool of its colour, until it eats and grows it back. Returns whether it was shorn. */
    shear(m: Mob): boolean {
        if (m.kind !== 'sheep' || m.dead || m.sheared) return false
        m.sheared = true
        const key = woolKey(DYE_COLORS[m.color]?.[0] ?? 'white')
        this.hooks.drop(Math.floor(m.x), Math.floor(m.y + 1), Math.floor(m.z), { item: key, count: n(1, 3) }, true)
        return true
    }

    /** Dyes a sheep (DYE_COLORS index). Returns whether its colour changed. */
    dye(m: Mob, color: number): boolean {
        if (m.kind !== 'sheep' || m.dead || m.color === color) return false
        m.color = color
        return true
    }

    /**
     * A squid (Squid.aiStep and its random swim): its tentacles stroke round
     * and round; in water each stroke's last quarter pushes it off along its
     * heading, and it slows between strokes. It picks a new heading now and
     * then, or darts away from what hurt it. Out of water it lies over, flaps,
     * and after fifteen seconds suffocates.
     */
    private squidAi(m: Mob) {
        const s = m.swim
        s.prevSpread = s.spread
        s.prevLean = s.lean
        if (m.panic > 0) m.panic--
        if (m.inWater) {
            s.air = SQUID_AIR
        } else if (--s.air <= -20) {
            s.air = 0
            this.hurt(m, 2)
        }
        s.stroke += s.strokeSpeed
        if (s.stroke > Math.PI * 2) {
            s.stroke -= Math.PI * 2
            if (randomInt(0, 9) === 0) s.strokeSpeed = (1 / (randomFloat() + 1)) * 0.2
        }
        if (!m.inWater) {
            s.spread = Math.abs(Math.sin(s.stroke)) * Math.PI * 0.25
            s.lean += (-Math.PI / 2 - s.lean) * 0.02
            return
        }
        if (s.stroke < Math.PI) {
            const f = s.stroke / Math.PI
            s.spread = Math.sin(f * f * Math.PI) * Math.PI * 0.25
            if (f > 0.75) s.speed = 1
        } else {
            s.spread = 0
            s.speed *= 0.9
        }
        // Minecraft's SquidRandomMovementGoal: a new heading about every two and a half seconds.
        if (m.panic <= 0 && (randomInt(0, 49) === 0 || (s.tx === 0 && s.ty === 0 && s.tz === 0))) {
            const a = randomFloat() * Math.PI * 2
            s.tx = Math.cos(a) * 0.2
            s.ty = -0.1 + randomFloat() * 0.2
            s.tz = Math.sin(a) * 0.2
        }
        m.vx = s.tx * s.speed
        m.vy = s.ty * s.speed
        m.vz = s.tz * s.speed
        const h = Math.hypot(m.vx, m.vz)
        if (h > 0.01) m.yaw = turnToward(m.yaw, Math.atan2(-m.vx, m.vz), 0.2)
        s.lean += (-Math.atan2(h, m.vy) - s.lean) * 0.1
    }

    /**
     * A villager's day (Minecraft's job-site rules, simplified): one without a
     * trade looks every five seconds for the nearest workstation no other
     * villager has claimed within 48 blocks, reserves it and walks there, and
     * takes up its trade on reaching it. One whose workstation is broken loses
     * its trade. Otherwise it potters about, never wandering far from its work.
     */
    private villagerAi(m: Mob, env: MobEnv) {
        if (m.levelUp > 0 && --m.levelUp === 0) this.levelUp(m)
        // Trading with you: it stands still and looks at you.
        if (this.trader === m.id) {
            m.path = null
            const t = this.target
            if (t) this.lookAt(m, t.x, t.y + 1.62, t.z)
            return
        }
        // A zombie within eight blocks: it runs (Minecraft's villager panic). Scared or gossiping
        // villagers call up an iron golem now and then.
        const zombie = this.threatOf(m, 8, o => ZOMBIES.has(o.kind))
        if ((this.tick + m.id) % 100 === 0) this.golemCheck(m, !!zombie || m.panic > 0)
        if (zombie) {
            m.farmJob = null
            this.flee(m, zombie.x, zombie.z, m.def.panic ?? 1.5)
            return
        }
        if (m.panic > 0) return this.passiveAi(m)
        const site = m.site
        if (site) {
            const id = env.jobSites.get(site.join(','))
            if (id === undefined || (m.profession && WORKSTATIONS[id] !== m.profession)) {
                // Its workstation is gone. One that has never traded forgets its trade.
                m.site = null
                m.path = null
                if (m.xp === 0) this.setProfession(m, null)
            }
        }
        if (!m.site && (this.tick + m.id) % 100 === 0) m.site = this.findJobSite(m, env)
        // With a trade but no workstation for it (cured, or its own was broken): one that
        // never traded gives the trade up after two minutes of looking.
        if (!m.site && m.profession && m.xp === 0) {
            if (++m.jobless > 2400) this.setProfession(m, null)
        } else {
            m.jobless = 0
        }
        if (m.site) {
            const [sx, sy, sz] = m.site
            const d = Math.hypot(sx + 0.5 - m.x, sz + 0.5 - m.z)
            const there = d < 1.8 && Math.abs(sy - m.y) < 2
            if (there) this.restock(m, env)
            if (!m.profession) {
                if (there) {
                    this.setProfession(m, WORKSTATIONS[env.jobSites.get(m.site.join(','))!] ?? null)
                    m.path = null
                } else {
                    if (!m.path || m.pathAge > 40) this.pathNear(m, sx, sy, sz)
                    this.follow(m, 1)
                    return
                }
            } else if (d > 16) {
                // Off too far: head back towards work.
                if (!m.path || m.pathAge > 40) this.pathNear(m, sx, sy, sz)
                this.follow(m, 1)
                return
            }
        }
        if (m.profession === 'farmer' && m.site && this.farming && this.farm(m, m.site)) return
        this.idleAi(m)
    }

    /**
     * Minecraft's farmer at work: it harvests ripe wheat around its composter
     * and sows bare farmland with seeds it carries (harvesting gives it more).
     * At the composter it composts spare seeds, keeping enough to sow. With
     * plenty of wheat it throws the extra to another villager nearby, as
     * villagers share food: a hopper under that villager catches it. Returns
     * whether it is busy with this (else it idles as usual).
     */
    private farm(m: Mob, site: [number, number, number]): boolean {
        const w = this.world
        const job = m.farmJob
        if (job) {
            const id = w.get(job.x, job.y, job.z)
            const valid = job.task === 'sow'
                ? id === B.Air && w.get(job.x, job.y - 1, job.z) === B.Farmland && m.inv.count('wheat_seeds') > 0
                : job.task === 'harvest' ? id === B.Wheat && (w.meta(job.x, job.y, job.z) & 7) === 7 : id === B.Composter
            if (!valid || ++job.ticks > FARM_GIVE_UP) {
                m.farmJob = null
                m.path = null
                return false
            }
            const reach = job.task === 'compost' ? 2.2 : 1.6
            if (Math.hypot(job.x + 0.5 - m.x, job.z + 0.5 - m.z) < reach && Math.abs(job.y - m.y) < 1.5) {
                if (job.task === 'compost') {
                    // Spare seeds into the composter, keeping enough to sow.
                    const spare = m.inv.count('wheat_seeds') - KEEP_SEEDS
                    if (spare > 0) m.inv.take('wheat_seeds', spare - this.hooks.compost(job.x, job.y, job.z, { item: 'wheat_seeds', count: spare }))
                    this.lookAt(m, job.x + 0.5, job.y + 0.5, job.z + 0.5)
                    m.farmJob = null
                    m.path = null
                    return true
                }
                if (job.task === 'harvest') for (const s of this.hooks.harvest(job.x, job.y, job.z)) m.inv.add(s.item, s.count)
                // Sown straight back, as a farmer does.
                if (m.inv.count('wheat_seeds') > 0 && w.get(job.x, job.y, job.z) === B.Air && w.get(job.x, job.y - 1, job.z) === B.Farmland) {
                    w.set(job.x, job.y, job.z, B.Wheat, 0)
                    m.inv.take('wheat_seeds', 1)
                }
                this.lookAt(m, job.x + 0.5, job.y + 0.3, job.z + 0.5)
                m.farmJob = null
                m.path = null
                return true
            }
            if (!m.path || m.pathAge > 40) {
                // A composter is solid: stand beside it. A crop or farmland: stand on it.
                if (job.task === 'compost' || !this.pathTo(m, job.x, job.y, job.z)) this.pathNear(m, job.x, job.y, job.z)
            }
            this.follow(m, FARM_SPEED)
            return true
        }
        if ((this.tick + m.id) % 20 !== 0) return false
        const [sx, sy, sz] = site
        // Plenty of spare seeds: off to the composter with them (unless it is full).
        if (m.inv.count('wheat_seeds') - KEEP_SEEDS >= COMPOST_AT && w.get(sx, sy, sz) === B.Composter && w.meta(sx, sy, sz) < 7) {
            m.farmJob = { x: sx, y: sy, z: sz, task: 'compost', ticks: 0 }
            m.path = null
            return true
        }
        // Plenty of wheat: throw the extra to the nearest other villager.
        if (m.inv.count('wheat') >= SHARE_WHEAT) {
            const other = this.list.filter(o => o !== m && o.kind === 'villager' && !o.dead && Math.hypot(o.x - m.x, o.z - m.z) < 8 && Math.abs(o.y - m.y) < 4)
                .sort((a, b) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(b.x - m.x, b.z - m.z))[0]
            if (other) {
                const n = m.inv.count('wheat') - 4
                m.inv.take('wheat', n)
                this.lookAt(m, other.x, other.y + 1, other.z)
                this.hooks.drop(Math.floor(other.x), Math.floor(other.y), Math.floor(other.z), { item: 'wheat', count: n })
            }
        }
        // Work near its composter: the nearest ripe wheat, or bare farmland to sow.
        let best: { x: number, y: number, z: number, sow: boolean, d: number } | null = null
        const seeds = m.inv.count('wheat_seeds') > 0
        for (let dx = -FARM_RANGE; dx <= FARM_RANGE; dx++) {
            for (let dz = -FARM_RANGE; dz <= FARM_RANGE; dz++) {
                for (let dy = -2; dy <= 2; dy++) {
                    const x = sx + dx, y = sy + dy, z = sz + dz
                    const id = w.get(x, y, z)
                    const ripe = id === B.Wheat && (w.meta(x, y, z) & 7) === 7
                    const bare = seeds && id === B.Air && w.get(x, y - 1, z) === B.Farmland
                    if (!ripe && !bare) continue
                    const d = Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) + Math.abs(y - m.y)
                    if (!best || d < best.d) best = { x, y, z, sow: !ripe, d }
                }
            }
        }
        if (!best) return false
        m.farmJob = { x: best.x, y: best.y, z: best.z, task: best.sow ? 'sow' : 'harvest', ticks: 0 }
        m.path = null
        return true
    }

    /** Takes up a trade (two Novice offers to start), or gives it up (null). */
    private setProfession(m: Mob, profession: string | null) {
        m.profession = profession
        if (!profession) {
            m.offers = []
            m.level = 1
            return
        }
        if (!m.offers.length) m.offers = newOffers(profession, m.level, [], randomFloat)
    }

    /** Reached the experience for the next level: two more offers from that level's list. */
    private levelUp(m: Mob) {
        if (!m.profession || m.level >= 5) return
        m.level++
        m.offers.push(...newOffers(m.profession, m.level, m.offers, randomFloat))
        m.health = m.def.health
    }

    /**
     * At its workstation, a villager whose offers have been used restocks them,
     * at most twice a day and not more than every two minutes (Minecraft's).
     */
    private restock(m: Mob, env: MobEnv) {
        if (!m.offers.some(o => o.uses > 0)) return
        if (m.restockDay !== env.day) {
            m.restockDay = env.day
            m.restocks = 0
        }
        if (m.restocks >= 2 || this.tick - m.lastRestock < 2400) return
        for (const o of m.offers) o.uses = 0
        m.restocks++
        m.lastRestock = this.tick
    }

    /**
     * A trade with a villager has been made: it gains the offer's experience,
     * and levels up two seconds after passing the next threshold.
     */
    traded(m: Mob, offer: Offer) {
        offer.uses++
        m.xp += offer.xp
        if (levelFor(m.xp) > m.level && m.levelUp === 0) m.levelUp = 40
    }

    /** The nearest workstation within 48 blocks that no other villager has claimed (for its own trade, if it has one). */
    private findJobSite(m: Mob, env: MobEnv): [number, number, number] | null {
        const taken = new Set(this.list.filter(o => o !== m && o.site).map(o => o.site!.join(',')))
        let best: [number, number, number] | null = null, bestD = 48 * 48
        for (const [key, id] of env.jobSites) {
            if (taken.has(key) || (m.profession && WORKSTATIONS[id] !== m.profession)) continue
            const [x, y, z] = key.split(',').map(Number) as [number, number, number]
            const d = (x + 0.5 - m.x) ** 2 + (y - m.y) ** 2 + (z + 0.5 - m.z) ** 2
            if (d < bestD) {
                best = [x, y, z]
                bestD = d
            }
        }
        return best
    }

    /** A path to a cell beside (x, y, z) where it can stand (a workstation is solid; you stand next to it). */
    private pathNear(m: Mob, x: number, y: number, z: number) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            for (const dy of [0, -1, 1]) {
                if (this.standable(x + dx, y + dy, z + dz, m) && this.pathTo(m, x + dx, y + dy, z + dz)) return
            }
        }
    }

    // ── Golems and cats ────────────────────────────────────────────────

    /**
     * Minecraft's golem summoning (Villager.spawnGolemIfNeeded), every five
     * seconds: a villager that hasn't seen an iron golem within 16 blocks in
     * the last 30 seconds wants one. When scared, three such villagers within
     * ten blocks call one up; when gossiping (another villager close by, at
     * most once a minute), five. Minecraft also wants them to have slept that
     * day; Skyfarm's villagers don't sleep.
     */
    private golemCheck(m: Mob, scared: boolean) {
        if (this.nearest(m, 16, o => o.kind === 'iron_golem')) m.golemSeen = this.tick
        if (scared) {
            this.summonGolem(m, 3)
            return
        }
        if (this.tick - m.gossipAt < 1200) return
        const friend = this.nearest(m, 3, o => o.kind === 'villager' && this.tick - o.gossipAt >= 1200)
        if (!friend) return
        m.gossipAt = friend.gossipAt = this.tick
        this.summonGolem(m, 5)
    }

    private wantsGolem(m: Mob) {
        return this.tick - m.golemSeen > 600
    }

    /** Ten tries at a spot within 8 blocks across and 6 up or down where a golem fits on solid ground. */
    summonGolem(m: Mob, need: number): Mob | null {
        if (!this.wantsGolem(m)) return null
        const near = this.list.filter(o => o.kind === 'villager' && alive(o) && Math.abs(o.x - m.x) <= 10 && Math.abs(o.y - m.y) <= 10 && Math.abs(o.z - m.z) <= 10 && this.wantsGolem(o))
        if (near.length < need) return null
        const def = MOBS.iron_golem
        for (let i = 0; i < 10; i++) {
            const x = Math.floor(m.x) + randomInt(-8, 8), z = Math.floor(m.z) + randomInt(-8, 8)
            for (let y = Math.floor(m.y) + 6; y >= Math.floor(m.y) - 6; y--) {
                const below = this.world.get(x, y - 1, z)
                const r = solidRange(below, this.world.meta(x, y - 1, z))
                if (!r || r[1] < 1 || below === B.Cactus || y < 1) continue
                if (this.collides(x + 0.5, y, z + 0.5, def.width / 2, def.height)) continue
                const golem = new Mob('iron_golem', x + 0.5, y, z + 0.5)
                this.list.push(golem)
                for (const o of near) o.golemSeen = this.tick
                return golem
            }
        }
        return null
    }

    /**
     * An iron golem (IronGolem's goals): it goes for what hurt it, for you
     * while angry (you hit it), else for the nearest monster within 16
     * blocks that isn't a creeper. A blow does 7.5 to 21.5 and throws the
     * target up; otherwise it strolls slowly about.
     */
    private golemAi(m: Mob) {
        const range = m.def.follow ?? 16
        if (m.anger > 0) m.anger--
        if (m.foe && (!alive(m.foe) || dist2(m, m.foe) > range * range)) {
            m.foe = null
            m.revenge = false
        }
        const you = this.target
        let t: MobTarget | null = null
        if (m.foe) {
            t = asTarget(m.foe)
        } else if (m.anger > 0 && you && you.active && dist2(m, you) <= range * range) {
            t = you
        } else if ((this.tick + m.id) % 5 === 0) {
            const prey = this.nearest(m, range, o => o.hostile && o.kind !== 'creeper')
            if (prey) {
                m.foe = prey
                t = asTarget(prey)
            }
        }
        m.targeting = !!t
        if (!t) {
            if (!m.path && randomInt(0, 119) === 0) this.wander(m, 10, 7)
            this.follow(m, 0.6)
            return
        }
        this.lookAt(m, t.x, t.y + eyeOf(t), t.z)
        this.chase(m, t)
        const reach = (m.def.width * 2) ** 2 + (t.mob?.def.width ?? PLAYER_WIDTH)
        if (dist2(m, t) <= reach && m.attackCooldown <= 0) {
            const damage = 7.5 + randomInt(0, 14)
            const hit = t.mob ? this.hurt(t.mob, damage, { x: m.x, z: m.z }, false, 0.4, true, m) : this.hooks.hurtPlayer(damage, m.x, m.z)
            if (hit) {
                m.swing = 10
                if (t.mob) t.mob.vy += 0.4
            }
            m.attackCooldown = 20
        }
    }

    /** A stray cat keeps away from you (16 blocks; it runs once you are within seven), and otherwise potters about. */
    private catAi(m: Mob) {
        if (m.panic > 0) return this.passiveAi(m)
        const you = this.target
        if (you && you.active) {
            const d = dist2(m, you)
            if (d < 16 * 16) {
                this.flee(m, you.x, you.z, d < 49 ? 1.33 : 0.8)
                return
            }
        }
        this.idleAi(m)
    }

    /** The nearest other living mob within `range` blocks that passes `test`. */
    private nearest(m: Mob, range: number, test: (o: Mob) => boolean): Mob | null {
        let best: Mob | null = null, bestD = range * range
        for (const o of this.list) {
            if (o === m || !alive(o) || !test(o)) continue
            const d = dist2(m, o)
            if (d < bestD) {
                best = o
                bestD = d
            }
        }
        return best
    }

    /** What a mob keeps away from (the nearest within `range`), looked for every fourth tick. */
    private threatOf(m: Mob, range: number, test: (o: Mob) => boolean): Mob | null {
        if ((this.tick + m.id) % 4 === 0) m.threat = this.nearest(m, range, test)
        const o = m.threat
        return o && alive(o) && dist2(m, o) <= range * range ? o : null
    }

    /**
     * Runs from (fx, fz), Minecraft's AvoidEntityGoal: a reachable spot up to
     * 16 blocks off (7 up or down), the way away from the danger
     * (DefaultRandomPos.getPosAway), and further from it than it is now.
     */
    private flee(m: Mob, fx: number, fz: number, speed: number) {
        if (!m.fled) m.path = null
        m.fleeing = true
        if (!m.path || m.pathAge > 20) {
            const now = (m.x - fx) ** 2 + (m.z - fz) ** 2
            const ax = m.x - fx, az = m.z - fz
            search: for (let i = 0; i < 10; i++) {
                let ox = randomInt(-16, 16), oz = randomInt(-16, 16)
                if (ox * ax + oz * az < 0) {
                    ox = -ox
                    oz = -oz
                }
                const x = Math.floor(m.x) + ox, z = Math.floor(m.z) + oz
                if ((x + 0.5 - fx) ** 2 + (z + 0.5 - fz) ** 2 <= now) continue
                const y0 = Math.floor(m.y + 0.01)
                for (let y = y0 + 7; y >= y0 - 7; y--) {
                    if (!this.standable(x, y, z, m) || this.world.get(x, y, z) === B.Water) continue
                    if (this.pathTo(m, x, y, z)) break search
                    break
                }
            }
        }
        this.follow(m, speed)
    }

    /** Strolling about and looking around, when there is nothing better to do. */
    private idleAi(m: Mob) {
        const t = this.target
        if (t && t.active && m.lookTicks <= 0 && randomFloat() < 0.02 && Math.hypot(t.x - m.x, t.y - m.y, t.z - m.z) < 8) m.lookTicks = 40 + randomInt(0, 40)
        if (m.lookTicks > 0) {
            m.lookTicks--
            if (t) this.lookAt(m, t.x, t.y + 1.62, t.z)
        }
        if (!m.path && randomInt(0, 119) === 0) this.wander(m, 10, 7)
        this.follow(m, 1)
    }

    private hostileAi(m: Mob, env: MobEnv) {
        const def = m.def
        const range = def.follow ?? 16
        const you = this.target
        // A foe that died, left, or got too far away is forgotten.
        if (m.foe && (!alive(m.foe) || dist2(m, m.foe) > range * range)) {
            m.foe = null
            m.revenge = false
            m.targeting = false
        }
        // Zombies hunt villagers and iron golems they can see, but you come first (Minecraft's
        // target priorities: whatever hurt it, then you, then villagers and golems).
        if (ZOMBIES.has(m.kind) && !m.revenge && (this.tick + m.id) % 10 === 0) {
            const seeYou = !!you && you.active && dist2(m, you) <= range * range && this.canSee(m.x, m.y + def.eye, m.z, you.x, you.y + 1.62, you.z)
            if (seeYou && m.foe) {
                m.foe = null
                m.targeting = false
            } else if (!seeYou && !m.foe && !m.targeting) {
                const prey = this.nearest(m, range, o => o.kind === 'villager' || o.kind === 'iron_golem')
                if (prey && this.canSee(m.x, m.y + def.eye, m.z, prey.x, prey.y + prey.def.eye, prey.z)) {
                    m.foe = prey
                    m.targeting = true
                    m.seeTarget = true
                }
            }
        }
        // A creeper keeps six blocks from a cat (unless it is already hissing).
        if (m.kind === 'creeper' && m.swellDir <= 0) {
            const cat = this.threatOf(m, 6, o => o.kind === 'cat')
            if (cat) {
                this.flee(m, cat.x, cat.z, dist2(m, cat) < 49 ? 1.2 : 1)
                this.creeperFuse(m)
                return
            }
        }
        const t = m.foe ? asTarget(m.foe) : you
        const valid = !!t && t.active
        const dx = valid ? t!.x - m.x : 0, dz = valid ? t!.z - m.z : 0
        const d2 = valid ? dx * dx + (t!.y - m.y) ** 2 + dz * dz : Infinity
        // Look for you every half second; a hit makes it come for you anyway.
        if ((this.tick + m.id) % 10 === 0 && valid) m.seeTarget = this.canSee(m.x, m.y + def.eye, m.z, t!.x, t!.y + eyeOf(t!), t!.z)
        if (m.targeting && (!valid || d2 > range * range)) m.targeting = false
        if (!m.targeting && valid && d2 <= range * range && (m.seeTarget || m.angry)) m.targeting = true
        // Spiders only hunt in the dark (unless you hit one), and give up now and then in the light.
        if (m.kind === 'spider' && m.targeting && !m.angry) {
            const [s, b] = this.light(Math.floor(m.x), Math.floor(m.y + def.eye), Math.floor(m.z))
            if (brightness(Math.max(b, s - env.skyDarken)) >= 0.5 && randomInt(0, 99) === 0) m.targeting = false
        }
        if (!m.targeting) {
            m.draw = 0
            m.swellDir = -1
            this.creeperFuse(m)
            this.idleAi(m)
            return
        }
        const p = t!
        this.lookAt(m, p.x, p.y + eyeOf(p), p.z)
        const dist = Math.sqrt(d2)
        if (m.kind === 'witch') {
            // Minecraft's RangedAttackGoal(1.0, 60, 10): close to ten blocks, stand once it
            // has seen you a moment, and throw a potion every three seconds.
            m.seeTime = m.seeTarget ? m.seeTime + 1 : 0
            if (dist > 10 || m.seeTime < 5) this.chase(m, p)
            else m.path = null
            if (m.seeTarget && dist <= 10 && m.attackCooldown <= 0 && m.drinking <= 0) {
                this.throwPotion(m, p)
                m.attackCooldown = 60
            }
            this.faceTarget(m, p)
            return
        }
        if (m.kind === 'skeleton') {
            // Keep a bow's distance: walk up until in range and seen for a second, then stand and shoot.
            m.seeTime = m.seeTarget ? m.seeTime + 1 : 0
            if (dist > 15 || m.seeTime < 20) this.chase(m, p)
            else m.path = null
            if (m.seeTarget && dist <= 15) {
                if (m.attackCooldown <= 0 && ++m.draw >= 20) {
                    this.shoot(m, p)
                    m.draw = 0
                    m.attackCooldown = 40
                }
            } else {
                m.draw = 0
            }
            this.faceTarget(m, p)
            return
        }
        if (m.kind === 'creeper') {
            // Minecraft's SwellGoal: within 3 blocks it starts to hiss and stops; it keeps
            // swelling unless you get more than 7 away or out of sight.
            if (d2 < 9 && m.seeTarget) m.swellDir = 1
            else if (m.swellDir > 0 && (d2 > 49 || !m.seeTarget)) m.swellDir = -1
            if (m.swellDir > 0) {
                m.path = null
                this.faceTarget(m, p)
            } else {
                this.chase(m, p)
            }
            this.creeperFuse(m)
            return
        }
        // Zombies and spiders: close in and hit.
        this.chase(m, p)
        const reach = (def.width * 2) ** 2 + (p.mob?.def.width ?? PLAYER_WIDTH)
        if (d2 <= reach && m.attackCooldown <= 0 && m.seeTarget) {
            // A weapon in hand adds its own damage (an iron sword's +5, a shovel's +3.5); weakness takes 4 off.
            const weapon = m.held ? attackStats(m.held).damage - 1 : 0
            const damage = Math.max(0, (def.attack ?? 2) + weapon - (m.effects.weakness > 0 ? 4 : 0))
            const hit = damage > 0 && (p.mob ? this.hurt(p.mob, damage, { x: m.x, z: m.z }, false, 0.4, true, m) : this.hooks.hurtPlayer(damage, m.x, m.z))
            if (hit) m.swing = 6
            m.attackCooldown = 20
        }
        // A spider leaps at you from a few blocks off.
        if (m.kind === 'spider' && m.onGround && d2 > 4 && d2 < 16 && randomInt(0, 4) === 0) {
            const h = Math.hypot(dx, dz) || 1
            m.vx = (dx / h) * 0.4 + m.vx * 0.2
            m.vz = (dz / h) * 0.4 + m.vz * 0.2
            m.vy = 0.4
        }
    }

    private creeperFuse(m: Mob) {
        if (m.kind !== 'creeper') return
        if (m.swellDir > 0 && m.swell === 0) this.hooks.sound('fuse', m.x, m.y, m.z)
        m.swell = Math.max(0, m.swell + m.swellDir)
        if (m.swell >= 30) {
            m.deathTime = 20
            this.hooks.explode(m.x, m.y, m.z, 3)
        }
    }

    private chase(m: Mob, p: MobTarget) {
        const goal: Node = [Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z)]
        const g = m.path?.goal
        if (!m.path || m.pathAge > 20 || !g || Math.abs(g[0] - goal[0]) + Math.abs(g[1] - goal[1]) + Math.abs(g[2] - goal[2]) > 1) this.pathTo(m, ...goal)
        this.follow(m, 1)
    }

    private faceTarget(m: Mob, p: MobTarget) {
        m.yaw = turnToward(m.yaw, Math.atan2(-(p.x - m.x), p.z - m.z), Math.PI / 6)
    }

    private lookAt(m: Mob, x: number, y: number, z: number) {
        const dx = x - m.x, dz = z - m.z, dy = y - (m.y + m.def.eye)
        m.headYaw = turnToward(m.headYaw, Math.atan2(-dx, dz), Math.PI / 6)
        m.pitch = -Math.atan2(dy, Math.hypot(dx, dz))
    }

    // ── Paths ──────────────────────────────────────────────────────────

    /** A random reachable spot within `h` blocks across and `v` up or down, and a path there. */
    private wander(m: Mob, h: number, v: number) {
        for (let i = 0; i < 10; i++) {
            const x = Math.floor(m.x) + randomInt(-h, h), z = Math.floor(m.z) + randomInt(-h, h)
            const y0 = Math.floor(m.y + 0.01)
            for (let y = y0 + v; y >= y0 - v; y--) {
                if (!this.standable(x, y, z, m)) continue
                // Land animals stay out of the water if they can.
                if (this.world.get(x, y, z) === B.Water) break
                if (this.pathTo(m, x, y, z)) return
                break
            }
        }
    }

    /** Whether a mob's feet can be in cell (x, y, z): room for its body, and ground (or water) to be on. */
    standable(x: number, y: number, z: number, m: Mob) {
        const cells = Math.ceil(m.def.height)
        for (let i = 0; i < cells; i++) if (!this.passable(x, y + i, z)) return false
        const feet = this.world.get(x, y, z)
        if (feet === B.Water) return true
        const below = this.world.get(x, y - 1, z)
        if (below === B.Cactus) return false
        return !!solidRange(below, this.world.meta(x, y - 1, z))
    }

    private passable(x: number, y: number, z: number) {
        if (y < 0) return false
        const id = this.world.get(x, y, z)
        return !block(id).solid && id !== B.Lava && id !== B.Fire
    }

    /**
     * A* from where the mob stands to (gx, gy, gz), Minecraft's way: step to a
     * neighbour on the same level, up one with a jump, or down a drop of up to
     * three. Gives up after 400 cells and goes as close as it got. Returns whether
     * a path was found that gets anywhere.
     */
    pathTo(m: Mob, gx: number, gy: number, gz: number): boolean {
        const start: Node = [Math.floor(m.x), Math.floor(m.y + 0.01), Math.floor(m.z)]
        const key = (p: Node) => `${p[0]},${p[1]},${p[2]}`
        const h = (p: Node) => Math.abs(p[0] - gx) + Math.abs(p[1] - gy) + Math.abs(p[2] - gz)
        const open: { p: Node, g: number, f: number }[] = [{ p: start, g: 0, f: h(start) }]
        const came = new Map<string, Node | null>([[key(start), null]])
        const cost = new Map<string, number>([[key(start), 0]])
        let best = start, bestH = h(start), seen = 0
        while (open.length && seen < 400) {
            let bi = 0
            for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i
            const { p, g } = open.splice(bi, 1)[0]!
            seen++
            const ph = h(p)
            if (ph < bestH) {
                best = p
                bestH = ph
            }
            if (ph === 0) break
            for (const q of this.neighbours(p, m)) {
                const k = key(q)
                const ng = g + 1 + Math.abs(q[1] - p[1]) * 0.5
                if (ng >= (cost.get(k) ?? Infinity)) continue
                cost.set(k, ng)
                came.set(k, p)
                open.push({ p: q, g: ng, f: ng + h(q) })
            }
        }
        if (best === start) {
            m.path = null
            return false
        }
        const nodes: Node[] = []
        for (let p: Node | null = best; p && p !== start; p = came.get(key(p)) ?? null) nodes.unshift(p)
        m.path = { nodes, i: 0, goal: [gx, gy, gz] }
        m.pathAge = 0
        m.stuck = 0
        return true
    }

    private neighbours([x, y, z]: Node, m: Mob): Node[] {
        const out: Node[] = []
        const cells = Math.ceil(m.def.height)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, nz = z + dz
            if (this.standable(nx, y, nz, m)) {
                out.push([nx, y, nz])
            } else if (this.standable(nx, y + 1, nz, m) && this.passable(x, y + cells, z)) {
                // A jump up one block (needs headroom where it stands).
                out.push([nx, y + 1, nz])
            } else if (this.passable(nx, y, nz) && this.passable(nx, y + cells - 1, nz)) {
                // A drop of up to three blocks (Minecraft's safe fall); no further.
                for (let d = 1; d <= 3; d++) {
                    if (!this.passable(nx, y - d, nz)) break
                    if (this.standable(nx, y - d, nz, m)) {
                        out.push([nx, y - d, nz])
                        break
                    }
                }
            }
        }
        return out
    }

    /** Walks the current path at `speed` (a multiple of its own speed). */
    private follow(m: Mob, speed: number) {
        const path = m.path
        if (!path) return
        m.pathAge++
        let node = path.nodes[path.i]
        while (node) {
            const dx = node[0] + 0.5 - m.x, dz = node[2] + 0.5 - m.z
            if (Math.hypot(dx, dz) > 0.35 || Math.abs(node[1] - m.y) > 1.1) break
            node = path.nodes[++path.i]
        }
        if (!node) {
            m.path = null
            return
        }
        const dx = node[0] + 0.5 - m.x, dz = node[2] + 0.5 - m.z
        const d = Math.hypot(dx, dz) || 1
        m.moveX = dx / d
        m.moveZ = dz / d
        m.moveSpeed = speed
        m.yaw = turnToward(m.yaw, Math.atan2(-dx, dz), Math.PI / 2)
        if (m.lookTicks <= 0 && !m.targeting) m.headYaw = turnToward(m.headYaw, m.yaw, Math.PI / 4)
        // Jump onto a higher step, or when walking into something.
        if (node[1] > Math.floor(m.y + 0.01) && d < 1.6) m.jump = true
        if (m.hitWall) m.jump = true
        // Not getting anywhere: give up on this path.
        if (Math.hypot(m.x - m.px, m.z - m.pz) < 0.01) {
            if (++m.stuck > 40) m.path = null
        } else {
            m.stuck = 0
        }
    }

    // ── Physics ────────────────────────────────────────────────────────

    /** Whether a box (feet centre x, y, z; half width hw; height h) overlaps anything solid. */
    collides(x: number, y: number, z: number, hw: number, h: number) {
        for (let bx = Math.floor(x - hw); bx <= Math.floor(x + hw - 1e-6); bx++) {
            for (let by = Math.floor(y); by <= Math.floor(y + h - 1e-6); by++) {
                for (let bz = Math.floor(z - hw); bz <= Math.floor(z + hw - 1e-6); bz++) {
                    const r = solidRange(this.world.get(bx, by, bz), this.world.meta(bx, by, bz))
                    if (r && by + r[0] < y + h - 1e-6 && by + r[1] > y + 1e-6) return true
                }
            }
        }
        return false
    }

    private physics(m: Mob) {
        const w = this.world
        const hw = m.def.width / 2, h = m.def.height
        const at = (dy: number) => w.get(Math.floor(m.x), Math.floor(m.y + dy), Math.floor(m.z))
        m.inWater = at(0.1) === B.Water || at(h * 0.5) === B.Water
        const swims = m.kind === 'squid' && m.inWater
        if (swims) {
            // A squid in water goes where its strokes take it (squidAi set the velocity).
        } else if (m.inWater) {
            // Minecraft's FloatGoal: mobs swim up to keep their heads above water.
            m.vy = m.vy * 0.8 - 0.02
            if (randomFloat() < 0.8) m.vy += 0.04
        } else {
            m.vy = (m.vy - 0.08) * 0.98
            // Chickens flap and fall slowly.
            if (m.kind === 'chicken' && !m.onGround && m.vy < 0) m.vy *= 0.6
        }
        // Walking: Minecraft's speed works out to about 44 x speed squared blocks a second.
        const s = m.moveSpeed * m.def.speed
        const v = 2.2 * s * s * (m.inWater ? 0.5 : 1)
        const k = m.onGround ? 0.45 : m.inWater ? 0.2 : 0.09
        if (!swims) {
            m.vx += (m.moveX * v - m.vx) * k
            m.vz += (m.moveZ * v - m.vz) * k
        }
        if (m.jump && m.onGround) m.vy = 0.42
        // Spiders walk up walls.
        if (m.kind === 'spider' && m.hitWall) m.vy = 0.2

        const wasGround = m.onGround
        m.onGround = false
        m.hitWall = false
        const startY = m.y
        const move = (axis: 'x' | 'y' | 'z', delta: number) => {
            const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.25))
            for (let i = 0; i < steps; i++) {
                const d = delta / steps
                const before = m[axis]
                m[axis] += d
                if (!this.collides(m.x, m.y, m.z, hw, h)) continue
                // Walk up a slab or a low step.
                if (axis !== 'y' && wasGround) {
                    let lifted = false
                    for (let lift = 1 / 16; lift <= STEP_UP + 1e-6; lift += 1 / 16) {
                        if (!this.collides(m.x, m.y + lift, m.z, hw, h)) {
                            m.y += lift
                            lifted = true
                            break
                        }
                    }
                    if (lifted) continue
                }
                m[axis] = before
                if (axis === 'y') {
                    if (d < 0) m.onGround = true
                    m.vy = 0
                } else {
                    m.hitWall = true
                    if (axis === 'x') m.vx = 0
                    else m.vz = 0
                }
                return
            }
        }
        move('y', m.vy)
        move('x', m.vx)
        move('z', m.vz)
        // Falls of more than three blocks hurt (not chickens: they flap).
        if (m.inWater) m.fall = 0
        else if (!m.onGround && m.y < startY) m.fall += startY - m.y
        if (m.onGround) {
            if (m.fall > 3 && m.kind !== 'chicken' && m.kind !== 'cat' && m.kind !== 'iron_golem') this.hurt(m, Math.ceil(m.fall - 3))
            m.fall = 0
        }
    }

    /** Mobs shoulder each other (and step out of the player's way) instead of standing inside one another. */
    private push() {
        const live = this.list.filter(m => !m.dead)
        const t = this.target
        for (let i = 0; i < live.length; i++) {
            const a = live[i]!
            for (let j = i + 1; j < live.length; j++) {
                const b = live[j]!
                const r = (a.def.width + b.def.width) / 2
                const dx = b.x - a.x, dz = b.z - a.z
                if (Math.abs(dx) >= r || Math.abs(dz) >= r || b.y > a.y + a.def.height || a.y > b.y + b.def.height) continue
                const d = Math.hypot(dx, dz) || 0.01
                const f = 0.05 / d
                a.vx -= dx * f
                a.vz -= dz * f
                b.vx += dx * f
                b.vz += dz * f
            }
            if (t) {
                const r = (a.def.width + PLAYER_WIDTH) / 2
                const dx = a.x - t.x, dz = a.z - t.z
                if (Math.abs(dx) < r && Math.abs(dz) < r && a.y < t.y + PLAYER_HEIGHT && t.y < a.y + a.def.height) {
                    const d = Math.hypot(dx, dz) || 0.01
                    a.vx += (dx / d) * 0.05
                    a.vz += (dz / d) * 0.05
                }
            }
        }
    }

    // ── Hurting ────────────────────────────────────────────────────────

    /**
     * Hurts a mob. With `from` it is knocked back away from there (Minecraft's
     * 0.4), and `byPlayer` makes it come for you (or run, if it's an animal).
     * `by`: the mob that did it, which a monster or a golem then goes for
     * (Minecraft's HurtByTargetGoal).
     */
    hurt(m: Mob, amount: number, from?: { x: number, z: number }, byPlayer = false, knock = 0.4, armored = !!from, by: Mob | null = null): boolean {
        // Blows, arrows and blasts are softened by armour; fire and falls are not.
        if (armored) {
            const { armor, toughness } = armorValue(Object.values(m.armor))
            amount = afterArmor(amount, armor, toughness)
        }
        if (!m.damage(amount)) return false
        // An iron golem doesn't budge (knockback resistance 1).
        if (from && m.kind !== 'iron_golem') {
            const dx = m.x - from.x, dz = m.z - from.z
            const d = Math.hypot(dx, dz) || 1
            m.vx = m.vx / 2 + (dx / d) * knock
            m.vz = m.vz / 2 + (dz / d) * knock
            if (m.onGround) m.vy = Math.min(0.4, m.vy / 2 + 0.4)
        }
        const fights = m.hostile || m.kind === 'iron_golem'
        if (byPlayer) {
            if (fights) {
                m.angry = true
                m.targeting = true
                m.foe = null
                m.revenge = false
                // A golem stays angry with you for 20 to 39 seconds.
                if (m.kind === 'iron_golem') m.anger = randomInt(400, 780)
            } else {
                m.panic = 100
                m.path = null
            }
        } else {
            if (by && by !== m && alive(by) && fights) {
                m.foe = by
                m.revenge = true
                m.targeting = true
                m.seeTarget = true
            }
            if (!fights && from) m.panic = 100
        }
        // A squid darts away from the blow (SquidFleeGoal), for as long as it panics.
        if (m.kind === 'squid' && from) {
            const dx = m.x - from.x, dz = m.z - from.z
            const d = Math.hypot(dx, dz) || 1
            m.swim.tx = (dx / d) * 0.3
            m.swim.ty = 0.05
            m.swim.tz = (dz / d) * 0.3
            m.swim.speed = 1
        }
        this.hooks.sound('hurt', m.x, m.y, m.z, 1.6 - Math.min(1, m.def.width * m.def.height) * 0.6)
        // A villager killed by a zombie rises as a zombie villager, one time in two (Normal difficulty).
        if (m.health <= 0 && m.kind === 'villager' && by && ZOMBIES.has(by.kind) && randomChance(0.5)) {
            this.zombify(m)
            return true
        }
        if (m.health <= 0) {
            m.deathTime = 0
            m.path = null
            const x = Math.floor(m.x), y = Math.floor(m.y + 0.2), z = Math.floor(m.z)
            for (const s of m.def.drops(m.fire > 0, byPlayer, m)) this.hooks.drop(x, y, z, s, byPlayer)
            // What it wore or held: each piece one time in twelve (8.5%), when you killed it.
            if (byPlayer) for (const key of [...Object.values(m.armor), m.held]) if (key && randomFloat() < 0.085) this.hooks.drop(x, y, z, { item: key, count: 1 }, true)
        }
        return true
    }

    /** The first living mob along a ray within `reach`, and how far along it is. */
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number): { mob: Mob, t: number } | null {
        let best: { mob: Mob, t: number } | null = null
        for (const m of this.list) {
            if (m.dead) continue
            const hw = m.def.width / 2
            const t = rayBox(ox, oy, oz, dx, dy, dz, m.x - hw, m.y, m.z - hw, m.x + hw, m.y + m.def.height, m.z + hw)
            if (t !== null && t <= reach && (!best || t < best.t)) best = { mob: m, t }
        }
        return best
    }

    // ── Arrows ─────────────────────────────────────────────────────────

    /** A skeleton looses an arrow at you, aimed a little high for the drop (AbstractSkeleton.performRangedAttack). */
    private shoot(m: Mob, p: MobTarget) {
        const sx = m.x, sy = m.y + m.def.eye - 0.1, sz = m.z
        const dx = p.x - sx, dz = p.z - sz
        const dy = p.y + (p.mob?.def.height ?? PLAYER_HEIGHT) / 3 - sy
        const h = Math.hypot(dx, dz)
        let ax = dx, ay = dy + h * 0.2, az = dz
        const len = Math.hypot(ax, ay, az) || 1
        // Normal difficulty's inaccuracy: 14 - 2 x 4.
        const spread = 0.0075 * 6
        ax = ax / len + gaussian() * spread
        ay = ay / len + gaussian() * spread
        az = az / len + gaussian() * spread
        const speed = 1.6
        this.arrows.push({ id: this.arrowIds++, x: sx, y: sy, z: sz, px: sx, py: sy, pz: sz, vx: ax * speed, vy: ay * speed, vz: az * speed, stuck: false, life: 0, owner: m.id })
        this.hooks.sound('bow', sx, sy, sz)
    }

    /** An arrow fired from (x, y, z) along (dx, dy, dz) at `speed`, spread by `inaccuracy` (a dispenser's 6). */
    launchArrow(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, inaccuracy: number) {
        const len = Math.hypot(dx, dy, dz) || 1
        const s = 0.0075 * inaccuracy
        const ax = dx / len + gaussian() * s, ay = dy / len + gaussian() * s, az = dz / len + gaussian() * s
        this.arrows.push({ id: this.arrowIds++, x, y, z, px: x, py: y, pz: z, vx: ax * speed, vy: ay * speed, vz: az * speed, stuck: false, life: 0, owner: -2 })
    }

    private stepArrows() {
        const t = this.target
        this.arrows = this.arrows.filter((a) => {
            a.px = a.x
            a.py = a.y
            a.pz = a.z
            a.life++
            if (a.stuck) return a.life < 600
            const len = Math.hypot(a.vx, a.vy, a.vz)
            // What it hits on the way: you, a mob, or a block.
            if (t && t.active) {
                const hit = rayBox(a.x, a.y, a.z, a.vx / len, a.vy / len, a.vz / len, t.x - 0.3, t.y, t.z - 0.3, t.x + 0.3, t.y + PLAYER_HEIGHT, t.z + 0.3)
                if (hit !== null && hit <= len) {
                    this.hooks.hurtPlayer(Math.ceil(len * 2), a.x - a.vx, a.z - a.vz)
                    this.hooks.sound('arrowHit', a.x, a.y, a.z)
                    return false
                }
            }
            const mobHit = this.raycast(a.x, a.y, a.z, a.vx / len, a.vy / len, a.vz / len, len)
            if (mobHit && mobHit.mob.id !== a.owner) {
                this.hurt(mobHit.mob, Math.ceil(len * 2), { x: a.x - a.vx, z: a.z - a.vz }, false, 0.4, true, this.byId(a.owner))
                this.hooks.sound('arrowHit', a.x, a.y, a.z)
                return false
            }
            const steps = Math.ceil(len / 0.1)
            for (let i = 1; i <= steps; i++) {
                const x = a.x + (a.vx * i) / steps, y = a.y + (a.vy * i) / steps, z = a.z + (a.vz * i) / steps
                const r = solidRange(this.world.get(Math.floor(x), Math.floor(y), Math.floor(z)), this.world.meta(Math.floor(x), Math.floor(y), Math.floor(z)))
                if (r && y - Math.floor(y) >= r[0] && y - Math.floor(y) <= r[1]) {
                    a.x = a.x + (a.vx * (i - 1)) / steps
                    a.y = a.y + (a.vy * (i - 1)) / steps
                    a.z = a.z + (a.vz * (i - 1)) / steps
                    a.stuck = true
                    a.life = 0
                    this.hooks.sound('arrowHit', x, y, z)
                    return true
                }
            }
            a.x += a.vx
            a.y += a.vy
            a.z += a.vz
            const inWater = this.world.get(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z)) === B.Water
            const drag = inWater ? 0.6 : 0.99
            a.vx *= drag
            a.vy = a.vy * drag - 0.05
            a.vz *= drag
            return a.y > -64 && a.life < 1200
        })
    }

    // ── Witches ────────────────────────────────────────────────────────

    /**
     * A witch drinks what it needs (Witch.aiStep): fire resistance when it is
     * burning, healing when hurt, swiftness to catch up with you from more than
     * eleven blocks off. A drink takes 32 ticks, standing still.
     */
    private witchDrink(m: Mob) {
        if (m.swift > 0) m.swift--
        if (m.drinking > 0) {
            if (--m.drinking > 0) return
            if (m.drink === 'healing') m.health = Math.min(m.def.health, m.health + 4)
            else if (m.drink === 'fire_resistance') m.fireResistant = 3600
            else if (m.drink === 'swiftness') m.swift = 3600
            m.drink = null
            return
        }
        const t = this.target
        let drink: Mob['drink'] = null
        if (m.fire > 0 && m.fireResistant <= 0 && randomFloat() < 0.15) drink = 'fire_resistance'
        else if (m.health < m.def.health && randomFloat() < 0.05) drink = 'healing'
        else if (t && m.targeting && m.swift <= 0 && randomFloat() < 0.5 && (t.x - m.x) ** 2 + (t.z - m.z) ** 2 > 121) drink = 'swiftness'
        if (!drink) return
        m.drink = drink
        m.drinking = 32
        this.hooks.sound('drink', m.x, m.y, m.z)
    }

    /**
     * A witch throws a splash potion at you (Witch.performRangedAttack):
     * slowness if you are eight or more blocks off and not slowed, poison if
     * you have 8 health or more and aren't poisoned, weakness now and then
     * up close, harming otherwise. Thrown at 0.75, aimed a little high.
     */
    private throwPotion(m: Mob, p: MobTarget) {
        const effects = p.effects ?? noEffects()
        const sy = m.y + m.def.eye - 0.1
        const dx = p.x - m.x, dz = p.z - m.z
        const dy = p.y + 1.62 - 1.1 - m.y
        const h = Math.hypot(dx, dz)
        let kind: PotionKind = 'harming'
        if (h >= 8 && effects.slowness <= 0) kind = 'slowness'
        else if ((p.health ?? 20) >= 8 && effects.poison <= 0) kind = 'poison'
        else if (h <= 3 && effects.weakness <= 0 && randomFloat() < 0.25) kind = 'weakness'
        let ax = dx, ay = dy + h * 0.2, az = dz
        const len = Math.hypot(ax, ay, az) || 1
        const spread = 0.0075 * 8
        ax = ax / len + gaussian() * spread
        ay = ay / len + gaussian() * spread
        az = az / len + gaussian() * spread
        this.launch(kind, m.x, sy, m.z, ax, ay, az, 0.75, m.id)
        m.swing = 6
    }

    /** Sends a splash potion flying from (x, y, z) along (dx, dy, dz) at `speed` blocks a tick. */
    launch(kind: PotionKind, x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, owner: number) {
        const len = Math.hypot(dx, dy, dz) || 1
        this.potions.push({ id: this.arrowIds++, kind, x, y, z, px: x, py: y, pz: z, vx: (dx / len) * speed, vy: (dy / len) * speed, vz: (dz / len) * speed, owner, life: 0 })
    }

    /** Poison, slowness and weakness wear off; poison takes a point every 25 ticks, never the last. */
    private mobEffects(m: Mob) {
        const e = m.effects
        if (e.poison > 0) {
            if (e.poison % 25 === 0 && m.health > 1) this.hurt(m, 1, undefined, false, 0, false)
            e.poison--
        }
        if (e.slowness > 0) e.slowness--
        if (e.weakness > 0) e.weakness--
    }

    /**
     * Gives a golden apple to a mob. A zombie villager under weakness starts
     * to cure (three to five minutes of shaking, then a villager); without
     * weakness it only takes one time in ten. Returns whether the apple was
     * used (a zombie villager eats it either way), and whether the cure started.
     */
    feedGoldenApple(m: Mob): { used: boolean, curing: boolean } {
        if (m.kind !== 'zombie_villager' || m.dead || m.converting > 0) return { used: false, curing: false }
        const curing = m.effects.weakness > 0 || randomFloat() < CURE_WITHOUT_WEAKNESS
        if (curing) {
            m.converting = randomInt(3600, 6000)
            m.effects.weakness = 0
            this.hooks.sound('drink', m.x, m.y, m.z)
        }
        return { used: true, curing }
    }

    /** A zombie villager's cure takes: a villager stands in its place, dropping what the zombie wore. */
    private cure(m: Mob) {
        const v = new Mob('villager', m.x, m.y, m.z, m.yaw)
        // It keeps the trade it had as a zombie (and its offers, if it was a villager before),
        // and thinks well of you for curing it.
        v.reputation = Math.max(m.reputation, CURED_REPUTATION)
        v.offers = m.offers
        v.xp = m.xp
        v.level = m.level
        this.setProfession(v, m.profession)
        const at = [Math.floor(m.x), Math.floor(m.y + 0.2), Math.floor(m.z)] as const
        for (const key of [...Object.values(m.armor), m.held]) if (key) this.hooks.drop(...at, { item: key, count: 1 }, true)
        m.removed = true
        this.list = this.list.filter(x => x !== m)
        this.list.push(v)
        this.hooks.sound('cure', m.x, m.y, m.z)
    }

    /**
     * A villager killed by a zombie turns (Villager.convertTo): a zombie
     * villager in its place keeps its trade, offers, level and opinion of
     * you, so curing it brings it all back; it never despawns.
     */
    private zombify(m: Mob) {
        const z = new Mob('zombie_villager', m.x, m.y, m.z, m.yaw)
        z.profession = m.profession
        z.offers = m.offers
        z.xp = m.xp
        z.level = m.level
        z.reputation = m.reputation
        z.keep = true
        m.removed = true
        this.list = this.list.filter(x => x !== m)
        this.list.push(z)
    }

    private stepPotions() {
        const t = this.target
        this.potions = this.potions.filter((p) => {
            p.px = p.x
            p.py = p.y
            p.pz = p.z
            p.life++
            const len = Math.hypot(p.vx, p.vy, p.vz) || 1e-6
            const ux = p.vx / len, uy = p.vy / len, uz = p.vz / len
            let at: [number, number, number] | null = null
            let direct: Mob | 'player' | null = null
            if (t && t.active && !(p.owner === PLAYER && p.life < 5)) {
                const hit = rayBox(p.x, p.y, p.z, ux, uy, uz, t.x - 0.3, t.y, t.z - 0.3, t.x + 0.3, t.y + PLAYER_HEIGHT, t.z + 0.3)
                if (hit !== null && hit <= len) {
                    at = [p.x + ux * hit, p.y + uy * hit, p.z + uz * hit]
                    direct = 'player'
                }
            }
            const mobHit = at ? null : this.raycast(p.x, p.y, p.z, ux, uy, uz, len)
            if (mobHit && mobHit.mob.id !== p.owner) {
                at = [p.x + ux * mobHit.t, p.y + uy * mobHit.t, p.z + uz * mobHit.t]
                direct = mobHit.mob
            }
            if (!at) {
                const steps = Math.ceil(len / 0.1)
                for (let i = 1; i <= steps; i++) {
                    const x = p.x + (p.vx * i) / steps, y = p.y + (p.vy * i) / steps, z = p.z + (p.vz * i) / steps
                    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z)
                    const r = solidRange(this.world.get(fx, fy, fz), this.world.meta(fx, fy, fz))
                    if (r && y - fy >= r[0] && y - fy <= r[1]) {
                        at = [p.x + (p.vx * (i - 1)) / steps, p.y + (p.vy * (i - 1)) / steps, p.z + (p.vz * (i - 1)) / steps]
                        break
                    }
                }
            }
            if (at) {
                this.splash(p, at, direct)
                return false
            }
            p.x += p.vx
            p.y += p.vy
            p.z += p.vz
            p.vx *= 0.99
            p.vy = p.vy * 0.99 - 0.05
            p.vz *= 0.99
            return p.y > -64
        })
    }

    /**
     * A splash potion breaks: you and every mob within four blocks get it, the
     * less the further off (a direct hit gets all of it), Minecraft's way.
     */
    splash(p: Potion, [x, y, z]: [number, number, number], direct: Mob | 'player' | null = null) {
        this.hooks.sound('potion', x, y, z)
        const t = this.target
        if (t) {
            const d = Math.hypot(t.x - x, t.y - y, t.z - z)
            if (direct === 'player' || d < 4) this.hooks.splashPlayer(p.kind, direct === 'player' ? 1 : 1 - d / 4)
        }
        const thrower = this.byId(p.owner)
        for (const m of this.list) {
            if (m.dead) continue
            const d = Math.hypot(m.x - x, m.y - y, m.z - z)
            if (direct === m || d < 4) this.affect(m, p.kind, direct === m ? 1 : 1 - d / 4, thrower)
        }
    }

    /** A living mob by id (an arrow's or a potion's owner), or null (you, a dispenser, or one that is gone). */
    private byId(id: number): Mob | null {
        if (id <= 0) return null
        return this.list.find(o => o.id === id && alive(o)) ?? null
    }

    /**
     * A potion's effect on a mob. The undead have it backwards: harming heals
     * them (4, where it would hurt anything else 6), and poison does nothing
     * to them, nor to spiders.
     */
    affect(m: Mob, kind: PotionKind, scale: number, by: Mob | null = null) {
        if (kind === 'harming') {
            if (UNDEAD.has(m.kind)) m.health = Math.min(m.def.health, m.health + 4 * scale)
            else this.hurt(m, 6 * scale, undefined, false, 0, false, by)
            return
        }
        if (kind === 'poison' && (UNDEAD.has(m.kind) || m.kind === 'spider')) return
        const ticks = Math.floor(POTION_TICKS[kind] * scale + 0.5)
        if (ticks > 20) m.effects[kind] = Math.max(m.effects[kind], ticks)
    }

    // ── Explosions ─────────────────────────────────────────────────────

    /**
     * Hurts and throws everything near an explosion, Minecraft's way: the
     * closer and the less sheltered, the harder (up to 43 for a creeper's
     * power 3, at the heart of it). Call before the blast breaks any blocks.
     */
    blast(x: number, y: number, z: number, power: number) {
        const reach = power * 2
        const hit = (ex: number, ey: number, ez: number, hw: number, h: number) => {
            const d = Math.hypot(ex - x, ey - y, ez - z) / reach
            if (d > 1) return null
            const exposure = this.exposure(x, y, z, ex - hw, ey, ez - hw, ex + hw, ey + h, ez + hw)
            const impact = (1 - d) * exposure
            const dist = Math.hypot(ex - x, ey + h / 2 - y, ez - z) || 1
            return { damage: Math.floor(((impact * impact + impact) / 2) * 7 * reach + 1), impact, nx: (ex - x) / dist, ny: (ey + h / 2 - y) / dist, nz: (ez - z) / dist }
        }
        for (const m of this.list) {
            if (m.dead) continue
            const r = hit(m.x, m.y, m.z, m.def.width / 2, m.def.height)
            if (!r) continue
            this.hurt(m, r.damage, undefined, false, 0, true)
            m.vx += r.nx * r.impact
            m.vy += r.ny * r.impact
            m.vz += r.nz * r.impact
        }
        const t = this.target
        if (!t) return null
        return hit(t.x, t.y, t.z, PLAYER_WIDTH / 2, PLAYER_HEIGHT)
    }

    /** How much of a box an explosion at (x, y, z) can see: the share of points on a grid through it with nothing solid in between. */
    private exposure(x: number, y: number, z: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
        let seen = 0, total = 0
        for (let i = 0; i <= 2; i++) {
            for (let j = 0; j <= 2; j++) {
                for (let k = 0; k <= 2; k++) {
                    total++
                    if (this.canSee(x, y, z, x0 + ((x1 - x0) * i) / 2, y0 + ((y1 - y0) * j) / 2, z0 + ((z1 - z0) * k) / 2)) seen++
                }
            }
        }
        return seen / total
    }

    /** Whether nothing solid stands between two points (glass and leaves block the view, as in Minecraft). */
    canSee(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
        const d = Math.hypot(bx - ax, by - ay, bz - az)
        const steps = Math.ceil(d / 0.2)
        let last = ''
        for (let i = 1; i < steps; i++) {
            const x = Math.floor(ax + ((bx - ax) * i) / steps), y = Math.floor(ay + ((by - ay) * i) / steps), z = Math.floor(az + ((bz - az) * i) / steps)
            const key = `${x},${y},${z}`
            if (key === last) continue
            last = key
            if (block(this.world.get(x, y, z)).solid) return false
        }
        return true
    }

    // ── Saving ─────────────────────────────────────────────────────────

    /**
     * Animals and villagers are kept, and a zombie villager halfway through
     * its cure (with how long it has left). Other monsters are not: they
     * would despawn anyway.
     */
    toSave(): SavedMob[] {
        return this.list.filter(m => !m.dead && (!m.hostile || m.converting > 0 || m.keep)).map(m => ({
            k: m.kind, x: round(m.x), y: round(m.y), z: round(m.z), yaw: round(m.yaw), hp: round(m.health),
            ...(m.converting > 0 ? { conv: m.converting } : {}),
            ...(m.profession ? { prof: m.profession } : {}),
            ...(m.site ? { site: m.site } : {}),
            ...(m.offers.length ? { offers: m.offers, xp: m.xp, level: m.level } : {}),
            ...(m.reputation ? { rep: m.reputation } : {}),
            ...(m.inv.slots.some(Boolean) ? { inv: m.inv.slots.map(s => (s ? { ...s } : null)) } : {}),
            ...(m.kind === 'cat' ? { v: m.variant } : {}),
            // A sheep: its colour (DYE_COLORS), plus SHEARED once shorn.
            ...(m.kind === 'sheep' && (m.color || m.sheared) ? { v: m.color | (m.sheared ? SHEARED : 0) } : {}),
            ...(m.keep ? { keep: true } : {})
        }))
    }

    load(list: SavedMob[] | undefined) {
        this.list = (list ?? []).filter(s => SAVED_KINDS.includes(s.k as MobKind) && (s.k !== 'zombie_villager' || (s.conv ?? 0) > 0 || s.keep)).map((s) => {
            const m = new Mob(s.k as MobKind, s.x, s.y, s.z, s.yaw, Math.min(s.hp, MOBS[s.k as MobKind].health))
            m.converting = s.conv ?? 0
            m.profession = s.prof ?? null
            m.site = s.site ? [...s.site] : null
            m.offers = (s.offers ?? []).map(o => ({ ...o, a: { ...o.a }, out: { ...o.out }, ...(o.b ? { b: { ...o.b } } : {}) }))
            m.xp = s.xp ?? 0
            m.level = s.level ?? 1
            m.reputation = s.rep ?? 0
            if (s.inv) m.inv = new Slots(VILLAGER_SLOTS, s.inv)
            if (s.k === 'cat') m.variant = Math.min(s.v ?? 0, CAT_VARIANTS.length - 1)
            if (s.k === 'sheep') {
                m.color = Math.min((s.v ?? 0) & ~SHEARED, DYE_COLORS.length - 1)
                m.sheared = !!((s.v ?? 0) & SHEARED)
            }
            m.keep = !!s.keep
            return m
        })
    }
}

export interface SavedMob {
    k: string
    x: number
    y: number
    z: number
    yaw: number
    hp: number
    /** Ticks left of a zombie villager's cure. */
    conv?: number
    /** A villager's (or zombie villager's) trade and the workstation it works at. */
    prof?: string
    site?: [number, number, number]
    /** Its offers, experience and level, and its good opinion of you. */
    offers?: Offer[]
    xp?: number
    level?: number
    rep?: number
    /** What a villager carries (a farmer's seeds and wheat). */
    inv?: (ItemStack | null)[]
    /** A cat's coat (CAT_VARIANTS). */
    v?: number
    /** A zombie villager that was a villager: kept. */
    keep?: boolean
}

const round = (v: number) => Math.round(v * 100) / 100

/**
 * How likely a monster is to spawn in armour: Minecraft's 15% times the
 * local difficulty's multiplier, which grows from 0 on a new world to 1 on
 * an old one. A middling value stands in for it here.
 */
const ARMOR_CHANCE = 0.15 * 0.5

/**
 * Dresses a zombie or skeleton the way Minecraft does (Mob.populateDefaultEquipmentSlots):
 * now and then it gets armour, of one material rolled from leather up to
 * diamond, from the boots upward, each further piece three times in four;
 * and a zombie, one time in a hundred, an iron sword or shovel.
 */
export function equip(m: Mob, roll = randomFloat) {
    if (m.kind !== 'zombie' && m.kind !== 'zombie_villager' && m.kind !== 'skeleton') return
    if (roll() < ARMOR_CHANCE) {
        let tier = roll() < 0.5 ? 0 : 1
        for (let i = 0; i < 3; i++) if (roll() < 0.095) tier++
        const material = (Object.entries(ARMOR_MATERIALS).find(([, mat]) => mat.tier === tier)?.[0] ?? 'diamond') as ArmorMaterial
        let first = true
        for (const slot of [...ARMOR_SLOTS].reverse()) {
            if (!first && roll() < 0.25) break
            first = false
            m.armor[slot] = armorKey(material, slot)
        }
    }
    if ((m.kind === 'zombie' || m.kind === 'zombie_villager') && roll() < 0.01) m.held = roll() < 1 / 3 ? 'iron_sword' : 'iron_shovel'
}

/** Turns `from` toward `to` (radians) by at most `max`. */
function turnToward(from: number, to: number, max: number) {
    let d = (to - from) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return from + Math.max(-max, Math.min(max, d))
}

function gaussian() {
    // Box-Muller, from the shared generator.
    const u = Math.max(1e-9, randomFloat()), v = randomFloat()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Where a ray (unit direction) first enters a box, or null if it misses (slab method). */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number | null {
    let tmin = 0, tmax = Infinity
    for (const [o, d, lo, hi] of [[ox, dx, x0, x1], [oy, dy, y0, y1], [oz, dz, z0, z1]] as const) {
        if (Math.abs(d) < 1e-12) {
            if (o < lo || o > hi) return null
            continue
        }
        let a = (lo - o) / d, b = (hi - o) / d
        if (a > b) [a, b] = [b, a]
        tmin = Math.max(tmin, a)
        tmax = Math.min(tmax, b)
        if (tmin > tmax) return null
    }
    return tmin
}
