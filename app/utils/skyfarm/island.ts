import { randomFloat, randomInt } from '#shared/utils/random'
import type { SavedContainer, SkyfarmIsland, SkyfarmState } from '#shared/utils/skyfarm/binary'
import { decodeBytes, SKYFARM_SAVE_VERSION, type ItemStack, type SkyfarmSave } from '#shared/utils/skyfarm/save'
import { colorIndex, dyeColor } from './dyes'
import { B, blastResistance, block, DOUBLE_PLANTS, FACING, facingToward, FLOWERS, FURNACE_LIT, FURNACES, isFluid, isSlab, opacityOf, PLANTS, plantGround, plantSupported, replaceable, SLAB_BOTTOM, SLAB_DOUBLE, SLAB_TOP, TALL_FLOWERS, TORCH_WALL, UPPER, WORKSTATIONS } from './blocks'
import { STONECUTTING } from './crafting'
import { chunkPrice, ORE_LEVELS, sellValue } from './economy'
import { FURNACE_OUTPUT, FURNACE_SLOTS, furnaceKind, idleFurnace, stepFurnace, type FurnaceKind, type FurnaceState } from './furnace'
import { afterArmor, ARMOR_SLOTS, armorValue, breakTime, item, Slots } from './items'
import { Ledger, type LedgerBucket } from './ledger'
import { LightCache } from './light'
import { DIRS, DISPENSER_SLOTS, DOWN, FACING6, furnaceSlotFor, HOPPER_SLOTS, opposite, Redstone, UP } from './redstone'
import { priceOf } from './trades'
import { Mobs, noEffects, PLAYER, POTION_TICKS, type Effects, type Mob, type MobHooks, type PotionKind } from './mobs'
import { fluidFlow, leafDrops, LEAVES_PLACED, plantDrop, Sim, TICKS_PER_SECOND } from './sim'
import { CHUNK, CUBE_SIDES, HEIGHT, LAYERS, STARTER_TOP, VOLUME, World, chunkKey, starterIsland } from './world'

/*
 * One player's island and everything on it: the world and its clock, the
 * containers, the inventory and the coins. No rendering here, so it runs the
 * same in the game, in a test and in a fast-forward.
 */

export const INVENTORY_SLOTS = 36
export const HOTBAR = 9
export const CHEST_SLOTS = 27

/** A day, as in Minecraft: twenty minutes. */
export const DAY_TICKS = 24000
/** How long clear spells and rain last (ticks): 10 to 40 minutes, 5 to 10 minutes. */
const CLEAR_TICKS: [number, number] = [12000, 48000]
const RAIN_TICKS: [number, number] = [6000, 12000]
const span = ([lo, hi]: [number, number]) => lo + Math.floor(randomFloat() * (hi - lo))

/** How much of an absence really runs, tick by tick; the rest comes from the production ledger. */
export const CATCH_UP_SIMULATED_S = 60

/** Twenty half-hearts... ten hearts: Minecraft's 20 health. */
export const MAX_HEALTH = 20
/** With no hunger you are always fed: one health back every four seconds (Minecraft's full-food rate). */
export const REGEN_TICKS = 80
/** Minecraft's random ticks: blocks picked per 16-tall section of a chunk, each tick. */
const RANDOM_TICKS = 3
/** How far a dropped item may fall, tumble and float before it stops where it is. */
const CARRY_STEPS = 48
/** North, east, south, west. */
const HORIZONTAL: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]]

/** What a composter takes, and the chance each has of raising it a level (Minecraft's). */
export const COMPOST: Record<string, number> = {
    wheat_seeds: 0.3, melon_seeds: 0.3, pumpkin_seeds: 0.3, oak_sapling: 0.3, oak_leaves: 0.3,
    sugar_cane: 0.5, cactus: 0.5, melon_slice: 0.5,
    wheat: 0.65, apple: 0.65, melon: 0.65, pumpkin: 0.65,
    bread: 0.85,
    // Flowers, small and tall, are 65%.
    ...Object.fromEntries([...FLOWERS, ...TALL_FLOWERS].map(id => [block(id).key, 0.65]))
}

export interface AwayReport {
    seconds: number
    coins: number
    items: Record<string, number>
}

const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`

export class Island {
    world = new World()
    sim: Sim
    inventory = new Slots(INVENTORY_SLOTS)
    /** What you wear: head, chest, legs, feet. */
    armor = new Slots(4)
    containers = new Map<string, Slots>()
    /** Each furnace's fire and smelting progress (its slots are in `containers`). */
    furnaces = new Map<string, FurnaceState>()
    coins = 0
    earned = 0
    /** Ticks since the island began; the time of day is this modulo DAY_TICKS (morning at 0, as in Minecraft). */
    time = 0
    weather: { kind: 'clear' | 'rain' | 'thunder', ticksLeft: number } = { kind: 'clear', ticksLeft: CLEAR_TICKS[0] }
    chunksBought = 0
    spawn = { x: 5.5, y: STARTER_TOP, z: 5.5 }
    player = { x: 5.5, y: STARTER_TOP, z: 5.5, yaw: 0, pitch: 0 }
    /** Light for the simulation: what mobs, grass and the undead go by. */
    readonly light: LightCache
    mobs: Mobs
    readonly redstone: Redstone
    /** What the island makes by itself, minute by minute: what time away is worked out from. */
    readonly ledger = new Ledger()
    health = MAX_HEALTH
    dead = false
    /** What a witch's potions left on you, in ticks: poison hurts, slowness slows, weakness softens your blows. */
    effects: Effects = noEffects()
    /** Minecraft's hurt cooldown: for half a second after a hit only a harder one counts. */
    private hurtCooldown = 0
    private lastHurt = 0
    private regen = 0

    /** You were hurt (`fx`, `fz`: where from, for the knockback), and the game may show it. */
    onPlayerHurt: ((amount: number, fx: number | null, fz: number | null) => void) | null = null
    /** Something blew up: the game shows it, and throws you by `knock` if you were close. */
    onExplode: ((x: number, y: number, z: number, knock: [number, number, number] | null) => void) | null = null
    onMobSound: MobHooks['sound'] | null = null

    constructor() {
        this.sim = new Sim(this.world)
        this.sim.onDrop = (x, y, z, stack) => this.drop(x, y, z, stack)
        this.redstone = new Redstone(this)
        // Keep the lists of workstations and hoppers as blocks come and go (after the simulation
        // has its look), and let redstone see every change.
        const simChange = this.world.onChange
        this.world.onChange = (x, y, z, before) => {
            simChange?.(x, y, z, before)
            this.trackJobSite(x, y, z)
            this.redstone.changed(x, y, z)
        }
        this.light = new LightCache(this.world)
        this.mobs = new Mobs(this.world, (x, y, z) => this.light.at(x, y, z), () => ({
            skyDarken: this.skyDarken,
            raining: this.weather.kind !== 'clear',
            thundering: this.weather.kind === 'thunder',
            spawn: this.spawn,
            jobSites: this.jobSites,
            day: this.day
        }), {
            // What you killed isn't production; what died without you (a mob farm) is.
            drop: (x, y, z, stack, byPlayer) => this.drop(x, y, z, stack, !byPlayer),
            hurtPlayer: (amount, fx, fz) => this.hurtPlayer(amount, fx, fz),
            explode: (x, y, z, power) => this.explode(x, y, z, power),
            splashPlayer: (kind, scale) => this.splashPlayer(kind, scale),
            sound: (name, x, y, z, pitch) => this.onMobSound?.(name, x, y, z, pitch),
            // A farmer breaks a ripe crop like a hand would; the drops go to its own slots.
            harvest: (x, y, z) => this.breakBlock(x, y, z, null, false),
            compost: (x, y, z, stack) => this.insert(x, y, z, stack, UP)
        })
    }

    /**
     * Something dropped by itself (leaves, mobs, a blast, a block breaker).
     * `produced`: the island made it (it goes in the ledger). A hopper under
     * where it falls (through open air, up to four blocks) catches it, as a
     * hopper picks up items lying on it; otherwise it goes into the world if
     * the game is up, else straight into the inventory.
     */
    drop(x: number, y: number, z: number, stack: ItemStack, produced = true) {
        if (produced) this.ledger.produce(stack.item, stack.count)
        const end = this.carry(x, y, z)
        let left = stack.count
        if (end.hopper) left = this.insert(end.x, end.y - 1, end.z, { item: stack.item, count: left }, UP)
        if (left <= 0) return
        if (this.onDrop) this.onDrop(end.x, end.y, end.z, { item: stack.item, count: left })
        else this.inventory.add(stack.item, left)
    }

    /**
     * Where a dropped item comes to rest, Minecraft's way, worked out at once
     * rather than flown frame by frame (so it costs nothing to the frame, and
     * works the same whether anyone is watching): it falls; landing beside
     * water it tumbles in (a broken item pops out a little); in water it rides
     * the stream; and a hopper below it, unlocked, takes it. `hopper` says
     * whether the cell below the end is one to put it in.
     */
    private carry(x: number, y: number, z: number): { x: number, y: number, z: number, hopper: boolean } {
        const w = this.world
        const hopperBelow = (cx: number, cy: number, cz: number) => w.get(cx, cy - 1, cz) === B.Hopper && !(w.meta(cx, cy - 1, cz) & 8)
        for (let step = 0; step < CARRY_STEPS; step++) {
            // Fall through what isn't solid, into a hopper if one is below.
            while (y > 0 && w.ownsAt(x, y - 1, z) && !block(w.get(x, y - 1, z)).solid && !isFluid(w.get(x, y, z))) y--
            if (hopperBelow(x, y, z)) return { x, y, z, hopper: true }
            const here = w.get(x, y, z)
            if (isFluid(here)) {
                if (here !== B.Water) break
                // Down a waterfall first, then along the stream.
                if (y > 0 && w.get(x, y - 1, z) === B.Water) {
                    y--
                    continue
                }
                const [fx, fz] = fluidFlow(w, x, y, z)
                if (!fx && !fz) break
                if (Math.abs(fx) >= Math.abs(fz)) x += Math.sign(fx)
                else z += Math.sign(fz)
                continue
            }
            // On the ground: tumble into water right beside it, if any (north, east, south, west).
            const side = step === 0 ? HORIZONTAL.find(([dx, dz]) => w.get(x + dx, y, z + dz) === B.Water || (w.get(x + dx, y - 1, z + dz) === B.Water && !block(w.get(x + dx, y, z + dz)).solid)) : undefined
            if (!side) break
            x += side[0]
            z += side[1]
        }
        return { x, y, z, hopper: false }
    }

    // ── Containers, for hoppers, droppers and the store ────────────────

    /** Hoppers on the island (each moves items on its own clock). */
    readonly hopperSites = new Set<string>()

    /** The slots of whatever holds items at (x, y, z), made if the block should have them (hopper 5, dropper 9...). */
    containerAt(x: number, y: number, z: number): Slots | null {
        const id = this.world.get(x, y, z)
        const key = posKey(x, y, z)
        let size = 0
        if (id === B.Hopper) size = HOPPER_SLOTS
        else if (id === B.Dropper || id === B.Dispenser) size = DISPENSER_SLOTS
        else if (id === B.Chest || id === B.SellChest || id === B.Barrel) size = CHEST_SLOTS
        else if (FURNACES.has(id)) size = FURNACE_SLOTS
        if (!size) return null
        let box = this.containers.get(key)
        if (!box) this.containers.set(key, box = new Slots(size))
        return box
    }

    /**
     * Puts `stack` into what is at (x, y, z), coming in from side `from` (a
     * direction from DIRS; UP is from above). Minecraft's rules: a furnace
     * takes what it can smelt from above and fuel from the sides; a composter
     * composts; the store depot sends it all to the store. Returns how many
     * didn't fit.
     */
    insert(x: number, y: number, z: number, stack: ItemStack, from: number): number {
        const id = this.world.get(x, y, z)
        if (id === B.Depot) {
            this.deposit(stack.item, stack.count)
            this.ledger.store(stack.item, stack.count)
            return 0
        }
        if (id === B.Composter) {
            let left = stack.count
            while (left > 0 && COMPOST[stack.item] !== undefined && this.world.meta(x, y, z) < 7) {
                const level = this.world.meta(x, y, z)
                left--
                if (level === 0 || randomFloat() < COMPOST[stack.item]!) {
                    this.world.setMeta(x, y, z, level + 1)
                    if (level + 1 === 7) this.ripening.set(posKey(x, y, z), 20)
                }
            }
            return left
        }
        const box = this.containerAt(x, y, z)
        if (!box) return stack.count
        if (FURNACES.has(id)) {
            const slot = furnaceSlotFor(furnaceKind(id), stack.item, from)
            if (slot === null) return stack.count
            const one = new Slots(1, [box.slots[slot] ?? null])
            const left = one.add(stack.item, stack.count)
            box.slots[slot] = one.slots[0] ?? null
            return left
        }
        return box.add(stack.item, stack.count)
    }

    /**
     * Takes one item out of what is at (x, y, z) into `into` (a hopper pulling
     * from above): the first that fits, a furnace's output, a full composter's
     * bone meal. Returns whether anything moved.
     */
    extract(x: number, y: number, z: number, _from: number, into: Slots): boolean {
        const id = this.world.get(x, y, z)
        if (id === B.Composter) {
            if (this.world.meta(x, y, z) !== 8 || into.add('bone_meal', 1) > 0) return false
            this.world.setMeta(x, y, z, 0)
            this.ledger.produce('bone_meal', 1)
            return true
        }
        const box = this.containerAt(x, y, z)
        if (!box) return false
        const slots = FURNACES.has(id) ? [FURNACE_OUTPUT] : box.slots.map((_, i) => i)
        for (const i of slots) {
            const s = box.slots[i]
            if (!s) continue
            const probe = new Slots(into.slots.length, into.slots)
            if (probe.add(s.item, 1) > 0) continue
            into.add(s.item, 1)
            box.useOne(i)
            return true
        }
        return false
    }

    /**
     * How many times you have changed the island by hand: a block placed or
     * broken, a bucket used, land bought, the generator upgraded. Machines
     * moving blocks don't count. The server measures what the island can
     * produce again only when this has moved (verify.ts): with nothing built,
     * the island makes what it made.
     */
    builds = 0

    built() {
        this.builds++
    }

    // ── Storage ────────────────────────────────────────────────────────

    /**
     * What store depots have taken in on their way to your storage, by item.
     * Storage itself is on the server (it is what the market sells from): each
     * save sends these, the server checks them against what the island could
     * have produced (verify.ts) and takes what passes; `accepted` then takes
     * those off here. What it turns away waits here for the next save.
     */
    readonly store = new Map<string, number>()

    deposit(key: string, count: number) {
        if (count > 0) this.store.set(key, (this.store.get(key) ?? 0) + count)
    }

    /** Storage took these: they are no longer on their way. */
    accepted(taken: Record<string, number>) {
        for (const [key, n] of Object.entries(taken)) {
            const left = (this.store.get(key) ?? 0) - n
            if (left > 0) this.store.set(key, left)
            else this.store.delete(key)
        }
    }

    /**
     * Sell chests are gone (nothing sells by itself any more: you sell from
     * storage, on the market): one in an older island becomes a store depot,
     * and what was in it goes on its way to storage.
     */
    private retireSellChests() {
        for (const chunk of this.world.chunks.values()) {
            for (let i = 0; i < chunk.blocks.length; i++) {
                if (chunk.blocks[i] !== B.SellChest) continue
                const x = chunk.cx * CHUNK + (i % CHUNK), z = chunk.cz * CHUNK + (Math.floor(i / CHUNK) % CHUNK), y = Math.floor(i / (CHUNK * CHUNK))
                const k = posKey(x, y, z)
                for (const s of this.containers.get(k)?.slots ?? []) if (s) this.deposit(s.item, s.count)
                this.containers.delete(k)
                this.world.set(x, y, z, B.Depot)
            }
        }
    }

    /** Takes up to `count` of `key` still on its way back into the inventory; returns how many came. */
    withdraw(key: string, count: number): number {
        const have = this.store.get(key) ?? 0
        const want = Math.min(have, count)
        const left = this.inventory.add(key, want)
        const taken = want - left
        if (have - taken > 0) this.store.set(key, have - taken)
        else this.store.delete(key)
        return taken
    }

    /** A fresh island: the classic L, a tree, and the starting chest. */
    static fresh() {
        const island = new Island()
        const { spawn, chest } = starterIsland(island.world)
        island.spawn = { ...spawn }
        island.player = { ...spawn, yaw: 0, pitch: 0 }
        // The classic SkyBlock starting chest: lava and ice for a cobblestone generator,
        // the seeds of every farm (a melon slice makes melon seeds, a bone makes bone
        // meal for short grass and wheat seeds), sugar cane and a cactus.
        const box = new Slots(CHEST_SLOTS)
        box.add('lava_bucket', 1)
        box.add('ice', 2)
        box.add('melon_slice', 1)
        box.add('pumpkin_seeds', 1)
        box.add('bone', 1)
        box.add('sugar_cane', 1)
        box.add('cactus', 1)
        island.containers.set(posKey(chest.x, chest.y, chest.z), box)
        return island
    }

    get oreLevel() {
        return this.sim.oreLevel
    }

    // ── Blocks ─────────────────────────────────────────────────────────

    breakTime(x: number, y: number, z: number, held: string | null) {
        return breakTime(this.world.get(x, y, z), held)
    }

    /**
     * Breaks a block and returns what it drops. Ice leaves water. With
     * `collect`, the drop goes straight into the inventory; the game passes
     * false and throws it into the world as an item to pick up instead.
     */
    breakBlock(x: number, y: number, z: number, held: string | null, collect = true): ItemStack[] {
        const id = this.world.get(x, y, z)
        let meta = this.world.meta(x, y, z)
        if (id === B.Air || isFluid(id) || !Number.isFinite(block(id).hardness)) return []
        // A two-block plant comes down whole and drops once, as its lower half does
        // (broken from below, the upper half falls with it on the next check, dropping nothing).
        if (DOUBLE_PLANTS.has(id) && meta & UPPER) {
            if (this.world.get(x, y - 1, z) === id) this.world.set(x, y - 1, z, B.Air)
            meta = 0
        }
        const { drops } = breakTime(id, held)
        // A chest spills what it holds into the inventory.
        const box = this.containers.get(posKey(x, y, z))
        if (box) {
            for (const s of box.slots) if (s) this.inventory.add(s.item, s.count)
            this.containers.delete(posKey(x, y, z))
        }
        this.furnaces.delete(posKey(x, y, z))
        // A piston and its head go together.
        if (id === B.PistonHead || id === B.Piston || id === B.StickyPiston) this.redstone.pistonPartBroken(x, y, z, id, meta)
        this.world.set(x, y, z, id === B.Ice ? B.Water : B.Air)
        let out: ItemStack[] = []
        if (id === B.OakLeaves) {
            // Leaves drop what decaying leaves do: now and then a sapling, sticks, an apple.
            out = leafDrops(randomFloat)
        } else if (id === B.Wheat && (meta & 7) === 7) {
            // Ripe wheat: the grain and up to three seeds.
            out = [{ item: 'wheat', count: 1 }]
            const seeds = Math.floor(randomFloat() * 4)
            if (seeds) out.push({ item: 'wheat_seeds', count: seeds })
        } else if (id === B.Melon) {
            out = [{ item: 'melon_slice', count: 3 + Math.floor(randomFloat() * 5) }]
        } else if (PLANTS.has(id)) {
            const d = plantDrop(id, meta, randomFloat)
            if (d) out = [d]
        } else if (drops && block(id).drop) {
            // A double slab is two slabs.
            out = [{ item: block(id).drop!, count: isSlab(id) && (meta & 3) === SLAB_DOUBLE ? 2 : 1 }]
        }
        if (collect) for (const s of out) this.inventory.add(s.item, s.count)
        return out
    }

    /**
     * Where things a block drops by itself (decaying leaves) go: the game sets
     * this to throw them into the world. Without it (catching up on time away,
     * tests) they go straight into the inventory, so nothing is lost.
     */
    onDrop: ((x: number, y: number, z: number, stack: ItemStack) => void) | null = null

    /**
     * Places the block in `slot` against the face that was clicked, the way
     * Minecraft does: in the cell in front of that face. A slab goes in the
     * half that was clicked (the top half of a side face makes a top slab),
     * and a slab clicked onto a matching half slab completes it into a double.
     * `blocked` says whether the player is in the way of a block placed there.
     * A torch stands on a floor or hangs on the wall that was clicked (never
     * from a ceiling); a furnace or jack o'lantern turns its front to the
     * player, who is looking along `yaw`.
     */
    placeAgainst(slot: number, hit: { x: number, y: number, z: number, nx: number, ny: number, nz: number, id: number, py: number }, blocked: (x: number, y: number, z: number, id: number, meta: number) => boolean = () => false, yaw = 0, pitch = 0): boolean {
        const stack = this.inventory.slots[slot]
        const places = stack ? item(stack.item).places : undefined
        if (places === undefined) return false
        const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz
        const wallOf = () => TORCH_WALL.findIndex(([dx, dz]) => dx === hit.nx && dz === hit.nz) + 1
        if (places === B.Torch || places === B.RedstoneTorch) {
            if (hit.ny === -1) return false
            return this.placeFromSlot(slot, x, y, z, hit.ny === 1 ? 0 : wallOf())
        }
        // Levers and buttons go on any face of a solid block: floor, wall or ceiling.
        if (places === B.Lever || places === B.Button) {
            if (!block(hit.id).solid) return false
            return this.placeFromSlot(slot, x, y, z, hit.ny === 1 ? 0 : hit.ny === -1 ? 5 : wallOf())
        }
        // A repeater sends its signal the way you look.
        if (places === B.Repeater) return this.placeFromSlot(slot, x, y, z, (facingToward(yaw) + 2) % 4)
        // A hopper points into the block you clicked (down, if you clicked its top).
        if (places === B.Hopper) {
            const into = hit.ny === 1 ? DOWN : hit.ny === -1 ? DOWN : DIRS.findIndex(([dx, , dz], i) => i < 4 && dx === -hit.nx && dz === -hit.nz)
            if (blocked(x, y, z, places, into)) return false
            return this.placeFromSlot(slot, x, y, z, into)
        }
        // Pistons, droppers, dispensers and the block breaker face you, any of six ways;
        // an observer's face looks away from you, at what you were looking at.
        if (FACING6.has(places)) {
            if (blocked(x, y, z, places, 0)) return false
            const facing = facingToward6(yaw, pitch)
            return this.placeFromSlot(slot, x, y, z, places === B.Observer ? opposite(facing) : facing)
        }
        if (FACING.has(places)) {
            if (blocked(x, y, z, places, 0)) return false
            return this.placeFromSlot(slot, x, y, z, facingToward(yaw))
        }
        if (isSlab(places)) {
            const completes = (cx: number, cy: number, cz: number, half: number) => {
                if (this.world.get(cx, cy, cz) !== places || (this.world.meta(cx, cy, cz) & 3) !== half) return false
                if (blocked(cx, cy, cz, places, SLAB_DOUBLE)) return false
                this.world.setMeta(cx, cy, cz, SLAB_DOUBLE)
                this.inventory.useOne(slot)
                return true
            }
            // Onto the open side of the half slab that was clicked...
            if (hit.ny === 1 && completes(hit.x, hit.y, hit.z, SLAB_BOTTOM)) return true
            if (hit.ny === -1 && completes(hit.x, hit.y, hit.z, SLAB_TOP)) return true
            // ...or into the cell in front, where the matching half already is.
            const half = hit.ny === -1 || (hit.ny === 0 && hit.py - hit.y >= 0.5) ? SLAB_TOP : SLAB_BOTTOM
            if (completes(x, y, z, half === SLAB_TOP ? SLAB_BOTTOM : SLAB_TOP)) return true
            if (blocked(x, y, z, places, half)) return false
            return this.placeFromSlot(slot, x, y, z, half)
        }
        if (block(places).solid && blocked(x, y, z, places, 0)) return false
        return this.placeFromSlot(slot, x, y, z)
    }

    /** Whether a block can go at (x, y, z): owned land, inside the height, and the cell free (or fluid/plant). */
    canPlace(x: number, y: number, z: number) {
        const id = this.world.get(x, y, z)
        return this.world.ownsAt(x, y, z) && y >= 0 && y < HEIGHT && (replaceable(id) || isFluid(id))
    }

    /** Places the block in hotbar slot `slot` at (x, y, z). Returns true if it did. */
    placeFromSlot(slot: number, x: number, y: number, z: number, meta = 0): boolean {
        const stack = this.inventory.slots[slot]
        if (!stack) return false
        // A sell chest left in an inventory places as what replaced it: a store depot.
        const places = stack.item === 'sell_chest' ? B.Depot : item(stack.item).places
        if (places === undefined || !this.canPlace(x, y, z)) return false
        // A tall flower needs ground under it and room for its upper half.
        if (DOUBLE_PLANTS.has(places)) {
            if (!plantGround(this.world.get(x, y - 1, z)) || !this.canPlace(x, y + 1, z)) return false
            this.world.set(x, y + 1, z, places, UPPER)
            this.world.set(x, y, z, places, 0)
            this.inventory.useOne(slot)
            return true
        }
        if (!this.supported(places, x, y, z, meta)) return false
        // Leaves you place yourself never decay.
        this.world.set(x, y, z, places, places === B.OakLeaves ? meta | LEAVES_PLACED : meta)
        this.inventory.useOne(slot)
        if (places === B.Chest || places === B.Barrel) this.containers.set(posKey(x, y, z), new Slots(CHEST_SLOTS))
        if (places === B.Hopper || places === B.Dropper || places === B.Dispenser) this.containerAt(x, y, z)
        if (FURNACES.has(places)) {
            this.containers.set(posKey(x, y, z), new Slots(FURNACE_SLOTS))
            this.furnaces.set(posKey(x, y, z), idleFurnace())
        }
        return true
    }

    // ── Workstations ───────────────────────────────────────────────────

    /** Where every workstation on the island is (villagers look here for work), kept up to date as blocks change. */
    readonly jobSites = new Map<string, number>()

    private trackJobSite(x: number, y: number, z: number) {
        const id = this.world.get(x, y, z)
        if (WORKSTATIONS[id]) this.jobSites.set(posKey(x, y, z), id)
        else this.jobSites.delete(posKey(x, y, z))
        if (id === B.Hopper) this.hopperSites.add(posKey(x, y, z))
        else this.hopperSites.delete(posKey(x, y, z))
    }

    /** Finds every workstation (after loading, when blocks were written without anyone watching). */
    private scanJobSites() {
        this.jobSites.clear()
        this.hopperSites.clear()
        for (const c of this.world.chunks.values()) {
            for (let i = 0; i < c.blocks.length; i++) {
                const id = c.blocks[i]!
                if (!WORKSTATIONS[id] && id !== B.Hopper) continue
                const lx = i % CHUNK, lz = Math.floor(i / CHUNK) % CHUNK, y = Math.floor(i / (CHUNK * CHUNK))
                const key = posKey(c.cx * CHUNK + lx, y, c.cz * CHUNK + lz)
                if (id === B.Hopper) this.hopperSites.add(key)
                else this.jobSites.set(key, id)
            }
        }
    }

    /** Composters about to turn full into bone meal: ticks to go (Minecraft waits a second). */
    private ripening = new Map<string, number>()

    /**
     * Drops the compostable in `slot` into the composter at (x, y, z): Minecraft's
     * chance for that item to raise it a level (the first always does). At level
     * 7 it turns to bone meal a second later. Returns whether the item went in.
     */
    compost(slot: number, x: number, y: number, z: number): { used: boolean, rose: boolean } {
        const stack = this.inventory.slots[slot]
        const chance = stack ? COMPOST[stack.item] : undefined
        const level = this.world.meta(x, y, z)
        if (this.world.get(x, y, z) !== B.Composter || chance === undefined || level >= 7) return { used: false, rose: false }
        this.inventory.useOne(slot)
        const rose = level === 0 || randomFloat() < chance
        if (rose) {
            this.world.setMeta(x, y, z, level + 1)
            if (level + 1 === 7) this.ripening.set(posKey(x, y, z), 20)
        }
        return { used: true, rose }
    }

    /** Takes the bone meal out of a full composter (dropping it at the top). Returns whether there was any. */
    emptyComposter(x: number, y: number, z: number): boolean {
        if (this.world.get(x, y, z) !== B.Composter || this.world.meta(x, y, z) !== 8) return false
        this.world.setMeta(x, y, z, 0)
        this.drop(x, y + 1, z, { item: 'bone_meal', count: 1 })
        return true
    }

    private stepComposters() {
        for (const [key, ticks] of this.ripening) {
            if (ticks > 1) {
                this.ripening.set(key, ticks - 1)
                continue
            }
            this.ripening.delete(key)
            const [x, y, z] = key.split(',').map(Number) as [number, number, number]
            if (this.world.get(x, y, z) === B.Composter && this.world.meta(x, y, z) === 7) this.world.setMeta(x, y, z, 8)
        }
    }

    /**
     * The stonecutter: one `input` cut into `output` (one of its cuts, see
     * STONECUTTING). Takes the input from `from` at index `i` and returns the stack made.
     */
    cutStone(from: Slots, i: number, output: string): ItemStack | null {
        const input = from.slots[i]
        const cut = input ? STONECUTTING[input.item]?.find(c => c.item === output) : undefined
        if (!cut) return null
        from.useOne(i)
        return { ...cut }
    }

    /** Plants need the right ground under them (and sugar cane water beside it); dust needs a solid floor. */
    private supported(id: number, x: number, y: number, z: number, meta: number) {
        if (id === B.RedstoneDust) return block(this.world.get(x, y - 1, z)).solid
        return plantSupported(id, (a, b, c) => this.world.get(a, b, c), x, y, z, meta)
    }

    /**
     * The furnace at (x, y, z), its slots and its fire. A furnace placed
     * before furnaces worked gets them the first time it is opened.
     */
    furnace(x: number, y: number, z: number): { box: Slots, state: FurnaceState, kind: FurnaceKind } | null {
        const id = this.world.get(x, y, z)
        if (!FURNACES.has(id)) return null
        const key = posKey(x, y, z)
        let box = this.containers.get(key)
        if (!box) this.containers.set(key, box = new Slots(FURNACE_SLOTS))
        let state = this.furnaces.get(key)
        if (!state) this.furnaces.set(key, state = idleFurnace())
        return { box, state, kind: furnaceKind(id) }
    }

    /** Every furnace burns and smelts a tick; one that lights up or goes out changes its look and light. */
    private stepFurnaces() {
        for (const [key, state] of this.furnaces) {
            const box = this.containers.get(key)
            if (!box) continue
            const [x, y, z] = key.split(',').map(Number) as [number, number, number]
            const before = box.slots[FURNACE_OUTPUT]?.count ?? 0
            const lit = stepFurnace(box, state, furnaceKind(this.world.get(x, y, z)))
            // What a furnace turns out is production.
            const out = box.slots[FURNACE_OUTPUT]
            if (out && out.count > before) this.ledger.produce(out.item, out.count - before)
            const meta = this.world.meta(x, y, z)
            if (lit !== !!(meta & FURNACE_LIT)) this.world.setMeta(x, y, z, lit ? meta | FURNACE_LIT : meta & ~FURNACE_LIT)
        }
    }

    /**
     * Uses the hoe or bone meal in `slot` on the clicked block. A hoe tills
     * grass or dirt (with air above) into farmland; bone meal makes saplings,
     * crops and stems grow, and grass sprout short grass. Returns whether
     * anything happened.
     */
    useItem(slot: number, hit: { x: number, y: number, z: number, id: number }): boolean {
        const stack = this.inventory.slots[slot]
        if (!stack) return false
        if (item(stack.item).tool?.kind === 'hoe') {
            if ((hit.id !== B.Grass && hit.id !== B.Dirt) || this.world.get(hit.x, hit.y + 1, hit.z) !== B.Air) return false
            return this.world.set(hit.x, hit.y, hit.z, B.Farmland)
        }
        if (stack.item === 'bone_meal') {
            if (!this.sim.boneMeal(hit.x, hit.y, hit.z)) return false
            this.inventory.useOne(slot)
            return true
        }
        return false
    }

    /**
     * Uses the bucket in `slot` on the clicked spot: an empty bucket scoops a
     * source; a full one pours a source into the cell in front of the face.
     */
    useBucket(slot: number, hit: { x: number, y: number, z: number, nx: number, ny: number, nz: number, id: number }): boolean {
        const stack = this.inventory.slots[slot]
        if (!stack) return false
        // A cauldron fills from a water bucket (to the brim) and empties into an empty one.
        if (hit.id === B.Cauldron) {
            const level = this.world.meta(hit.x, hit.y, hit.z)
            if (stack.item === 'water_bucket' && level < 3) {
                this.world.setMeta(hit.x, hit.y, hit.z, 3)
                this.inventory.slots[slot] = { item: 'bucket', count: 1 }
                return true
            }
            if (stack.item === 'bucket' && level === 3) {
                this.world.setMeta(hit.x, hit.y, hit.z, 0)
                this.inventory.useOne(slot)
                this.inventory.add('water_bucket', 1)
                return true
            }
            return false
        }
        if (stack.item === 'bucket') {
            if (!isFluid(hit.id) || (this.world.meta(hit.x, hit.y, hit.z) & 15) !== 0) return false
            this.world.set(hit.x, hit.y, hit.z, B.Air)
            this.inventory.useOne(slot)
            this.inventory.add(hit.id === B.Water ? 'water_bucket' : 'lava_bucket', 1)
            return true
        }
        if (stack.item === 'water_bucket' || stack.item === 'lava_bucket') {
            const [x, y, z] = isFluid(hit.id) ? [hit.x, hit.y, hit.z] : [hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz]
            if (!this.canPlace(x, y, z)) return false
            this.world.set(x, y, z, stack.item === 'water_bucket' ? B.Water : B.Lava, 0)
            this.inventory.slots[slot] = { item: 'bucket', count: 1 }
            return true
        }
        return false
    }

    container(x: number, y: number, z: number) {
        return this.containers.get(posKey(x, y, z)) ?? null
    }

    // ── The shop ───────────────────────────────────────────────────────

    /*
     * Spending is in site coins, on the server (server/api/skyfarm/shop, land,
     * generator): it charges your balance and says what you got; the island
     * only takes it in. Nothing here costs or pays coins of its own any more.
     */

    /** Whether `count` of `key` fit in the inventory (asked before buying them). */
    hasRoom(key: string, count: number) {
        return new Slots(INVENTORY_SLOTS, this.inventory.slots).add(key, count) === 0
    }

    /** Bought items arrive in the inventory. */
    received(key: string, count: number) {
        this.inventory.add(key, count)
    }

    get nextChunkPrice() {
        return chunkPrice(this.chunksBought)
    }

    /** Whether the cube at (cx, cy, cz) may be bought: not yet owned, in the world, and sharing a face with one you own. */
    canBuyCube(cx: number, cy: number, cz: number) {
        if (cy < 0 || cy >= LAYERS || this.world.ownsCube(cx, cy, cz)) return false
        return CUBE_SIDES.some(([dx, dy, dz]) => this.world.ownsCube(cx + dx, cy + dy, cz + dz))
    }

    /**
     * The 16x16x16 cube at (cx, cy, cz), next to one you own, paid for on the
     * server: `bought` is how many cubes you have now bought there (each costs
     * 1.2x the last).
     */
    addBoughtCube(cx: number, cy: number, cz: number, bought: number): boolean {
        if (!this.canBuyCube(cx, cy, cz)) return false
        this.chunksBought = bought
        this.world.addCube(cx, cy, cz)
        this.built()
        return true
    }

    /** The generator's ore level, paid for on the server. */
    setOreLevel(level: number) {
        if (level === this.sim.oreLevel || !ORE_LEVELS[level]) return
        this.sim.oreLevel = level
        this.built()
    }

    // ── The clock ──────────────────────────────────────────────────────

    /**
     * One game tick (1/20 s): the world simulation, grass spreading, the
     * furnaces, your health, the mobs (while you are here to meet them), and
     * once a second the sell chests empty.
     */
    step() {
        this.time++
        this.stepWeather()
        this.sim.step()
        this.randomTicks()
        this.stepFurnaces()
        this.stepComposters()
        this.redstone.step()
        this.stepHealth()
        if (this.mobs.target) this.mobs.step()
        this.ledger.tick(() => this.containerTotals())
    }

    /**
     * Minecraft's sky darkening, 0 (noon) to 11 (midnight), deeper with rain
     * and thunder: sky light minus this is how dark it is for monsters, grass
     * and the undead.
     */
    get skyDarken() {
        const d = (((this.dayTime - 0.25) % 1) + 1) % 1
        const angle = (d * 2 + (0.5 - Math.cos(d * Math.PI) / 2)) / 3
        const h = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(angle * Math.PI * 2)))
        const rain = this.weather.kind !== 'clear' ? 1 - 5 / 16 : 1
        const thunder = this.weather.kind === 'thunder' ? 1 - 5 / 16 : 1
        return Math.floor((1 - h * rain * thunder) * 11)
    }

    // ── Your health ────────────────────────────────────────────────────

    /** Hurts you for `amount`. Returns whether it counted (a hit just after another only counts if harder). */
    hurtPlayer(amount: number, fx: number | null = null, fz: number | null = null, armored = fx !== null): boolean {
        if (this.dead || amount <= 0) return false
        // What hits you from somewhere (a blow, an arrow, a blast) is softened by armour;
        // falls, fire, drowning, poison and the void are not.
        if (armored) {
            const { armor, toughness } = armorValue(this.armor.slots.map(s => s?.item))
            amount = afterArmor(amount, armor, toughness)
        }
        let dealt = amount
        if (this.hurtCooldown > 10) {
            if (amount <= this.lastHurt) return false
            dealt = amount - this.lastHurt
        } else {
            this.hurtCooldown = 20
        }
        this.lastHurt = amount
        this.health = Math.max(0, this.health - dealt)
        this.regen = 0
        if (this.health <= 0) this.dead = true
        this.onPlayerHurt?.(dealt, fx, fz)
        return true
    }

    /**
     * A splash potion caught you, `scale` of it (1 at the heart of the
     * splash). Harming hurts at once, up to 6; the others last up to their
     * full time, Minecraft's way.
     */
    splashPlayer(kind: PotionKind, scale: number) {
        if (this.dead || scale <= 0) return
        if (kind === 'harming') {
            this.hurtPlayer(Math.max(1, Math.round(6 * scale)))
            return
        }
        const ticks = Math.floor(POTION_TICKS[kind] * scale + 0.5)
        if (ticks > 20) this.effects[kind] = Math.max(this.effects[kind], ticks)
    }

    private stepHealth() {
        if (this.hurtCooldown > 0) this.hurtCooldown--
        // Poison: a point every 25 ticks, but never the last one.
        if (this.effects.poison > 0) {
            if (this.effects.poison % 25 === 0 && this.health > 1 && !this.dead) this.hurtPlayer(1)
            this.effects.poison--
        }
        if (this.effects.slowness > 0) this.effects.slowness--
        if (this.effects.weakness > 0) this.effects.weakness--
        // Regeneration II (a golden apple): a point every 25 ticks.
        if (this.effects.regeneration > 0) {
            if (this.effects.regeneration % 25 === 0 && !this.dead) this.health = Math.min(MAX_HEALTH, this.health + 1)
            this.effects.regeneration--
        }
        if (this.dead || this.health >= MAX_HEALTH) return
        if (++this.regen >= REGEN_TICKS) {
            this.regen = 0
            this.health = Math.min(MAX_HEALTH, this.health + 1)
        }
    }

    /** Eats the golden apple in `slot`: Minecraft's Regeneration II for five seconds (four health). */
    eatGoldenApple(slot: number): boolean {
        if (this.inventory.slots[slot]?.item !== 'golden_apple' || this.dead) return false
        this.inventory.useOne(slot)
        this.effects.regeneration = Math.max(this.effects.regeneration, 100)
        return true
    }

    /** Gives the golden apple in `slot` to `mob` (a zombie villager eats it, cure or not). */
    feedGoldenApple(slot: number, mob: Mob) {
        if (this.inventory.slots[slot]?.item !== 'golden_apple') return { used: false, curing: false }
        const result = this.mobs.feedGoldenApple(mob)
        if (result.used) this.inventory.useOne(slot)
        return result
    }

    /** Uses the shears in `slot` on a sheep: its wool drops (the shears last; Skyfarm's tools don't wear out). */
    shearSheep(slot: number, mob: Mob): boolean {
        if (this.inventory.slots[slot]?.item !== 'shears') return false
        return this.mobs.shear(mob)
    }

    /** Uses the dye in `slot` on a sheep: it takes the dye's colour, and the dye is used up. */
    dyeSheep(slot: number, mob: Mob): boolean {
        const color = dyeColor(this.inventory.slots[slot]?.item ?? '')
        if (!color || !this.mobs.dye(mob, colorIndex(color))) return false
        this.inventory.useOne(slot)
        return true
    }

    /**
     * Trades with a villager: offer `index`, up to `times` over. Each time you
     * need what it asks (with any discount it gives you) and room for what you
     * get; it stops when the offer runs out. Returns how many trades went through.
     */
    trade(mob: Mob, index: number, times = 1): number {
        const offer = mob.offers[index]
        if (!offer || mob.dead) return 0
        let done = 0
        while (done < times && offer.uses < offer.max) {
            const price = priceOf(offer, mob.reputation)
            const costs = [price, ...(offer.b ? [offer.b] : [])]
            const needed = new Map<string, number>()
            for (const c of costs) needed.set(c.item, (needed.get(c.item) ?? 0) + c.count)
            if ([...needed].some(([key, n]) => this.inventory.count(key) < n)) break
            // Room for what you get, once you have paid.
            const check = new Slots(INVENTORY_SLOTS, this.inventory.slots)
            for (const [key, n] of needed) check.take(key, n)
            if (check.add(offer.out.item, offer.out.count) > 0) break
            for (const [key, n] of needed) this.inventory.take(key, n)
            this.inventory.add(offer.out.item, offer.out.count)
            this.mobs.traded(mob, offer)
            done++
        }
        return done
    }

    /**
     * Throws the splash potion in `slot` from (x, y, z) along (dx, dy, dz):
     * Minecraft's throw, half a block a tick.
     */
    throwPotion(slot: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean {
        const key = this.inventory.slots[slot]?.item
        const kind = key?.startsWith('splash_potion_') ? key.slice('splash_potion_'.length) as PotionKind : null
        if (!kind) return false
        this.inventory.useOne(slot)
        this.mobs.launch(kind, x, y, z, dx, dy, dz, 0.5, PLAYER)
        return true
    }

    /** Armour points you have on (0 to 20): the armour bar. */
    get armorPoints() {
        return armorValue(this.armor.slots.map(s => s?.item)).armor
    }

    /**
     * Puts on the armour in inventory slot `slot`, swapping out whatever was
     * worn there. Returns whether it was armour.
     */
    equip(slot: number): boolean {
        const stack = this.inventory.slots[slot]
        const a = stack ? item(stack.item).armor : undefined
        if (!stack || !a) return false
        const i = ARMOR_SLOTS.indexOf(a.slot)
        this.inventory.slots[slot] = this.armor.slots[i] ?? null
        this.armor.slots[i] = stack
        return true
    }

    /** Back at the spawn point with full health (what you carried stays with you). */
    respawn() {
        this.dead = false
        this.health = MAX_HEALTH
        this.effects = noEffects()
        this.hurtCooldown = 0
        this.lastHurt = 0
        this.player = { ...this.player, ...this.spawn }
    }

    // ── Grass ──────────────────────────────────────────────────────────

    /** A few random blocks per chunk section each tick get a turn, as in Minecraft: grass spreads and dies back. */
    private randomTicks() {
        for (const c of this.world.chunks.values()) {
            for (let section = 0; section < 4; section++) {
                for (let i = 0; i < RANDOM_TICKS; i++) {
                    const x = c.cx * CHUNK + randomInt(0, CHUNK - 1), y = section * 16 + randomInt(0, 15), z = c.cz * CHUNK + randomInt(0, CHUNK - 1)
                    if (this.world.get(x, y, z) === B.Grass) this.grassTick(x, y, z)
                }
            }
        }
    }

    /**
     * Grass under something opaque (or water) turns back to dirt; grass in
     * light 9 or more spreads to dirt around it, up to three below and one
     * above, wherever that dirt is open to the air (SpreadingSnowyDirtBlock).
     */
    private grassTick(x: number, y: number, z: number) {
        const w = this.world
        const covered = (cx: number, cy: number, cz: number) => {
            const above = w.get(cx, cy + 1, cz)
            return above === B.Water || opacityOf(above, w.meta(cx, cy + 1, cz)) >= 15
        }
        if (covered(x, y, z)) {
            w.set(x, y, z, B.Dirt)
            return
        }
        const [sky, glow] = this.light.at(x, y + 1, z, 64)
        if (Math.max(glow, sky - this.skyDarken) < 9) return
        for (let i = 0; i < 4; i++) {
            const tx = x + randomInt(-1, 1), ty = y + randomInt(-3, 1), tz = z + randomInt(-1, 1)
            if (w.get(tx, ty, tz) === B.Dirt && !covered(tx, ty, tz)) w.set(tx, ty, tz, B.Grass)
        }
    }

    // ── Explosions ─────────────────────────────────────────────────────

    /**
     * An explosion (a creeper's is power 3), Minecraft's way: it hurts and
     * throws what is near, then rays fan out from it and break every block they
     * get through, the tougher the block the sooner a ray gives out. A third of
     * what breaks drops (a creeper's blast loses the rest); chests spill everything.
     */
    explode(x: number, y: number, z: number, power: number) {
        const hit = this.mobs.blast(x, y, z, power)
        let knock: [number, number, number] | null = null
        if (hit && hit.damage > 0) {
            this.hurtPlayer(hit.damage, x, z)
            knock = [hit.nx * hit.impact, hit.ny * hit.impact, hit.nz * hit.impact]
        }
        const broken = new Set<string>()
        for (let i = 0; i < 16; i++) {
            for (let j = 0; j < 16; j++) {
                for (let k = 0; k < 16; k++) {
                    if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue
                    let dx = (i / 15) * 2 - 1, dy = (j / 15) * 2 - 1, dz = (k / 15) * 2 - 1
                    const len = Math.hypot(dx, dy, dz)
                    dx /= len
                    dy /= len
                    dz /= len
                    let strength = power * (0.7 + randomFloat() * 0.6)
                    let px = x, py = y, pz = z
                    while (strength > 0) {
                        const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz)
                        const id = this.world.get(bx, by, bz)
                        if (id !== B.Air) strength -= (blastResistance(id) + 0.3) * 0.3
                        if (strength > 0 && id !== B.Air && !isFluid(id)) broken.add(posKey(bx, by, bz))
                        px += dx * 0.3
                        py += dy * 0.3
                        pz += dz * 0.3
                        strength -= 0.225
                    }
                }
            }
        }
        for (const key of broken) {
            const [bx, by, bz] = key.split(',').map(Number) as [number, number, number]
            const id = this.world.get(bx, by, bz)
            const meta = this.world.meta(bx, by, bz)
            const box = this.containers.get(key)
            if (box) for (const s of box.slots) if (s) this.drop(bx, by, bz, s)
            this.containers.delete(key)
            this.furnaces.delete(key)
            this.world.set(bx, by, bz, B.Air)
            if (randomFloat() >= 1 / power) continue
            let drops: ItemStack[] = []
            if (id === B.OakLeaves) drops = leafDrops(randomFloat)
            else if (PLANTS.has(id)) drops = [plantDrop(id, meta, randomFloat)].filter((d): d is ItemStack => !!d)
            else if (block(id).drop) drops = [{ item: block(id).drop!, count: isSlab(id) && (meta & 3) === SLAB_DOUBLE ? 2 : 1 }]
            for (const d of drops) this.drop(bx, by, bz, d)
        }
        this.onExplode?.(x, y, z, knock)
    }

    /** The time of day, 0..1: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight (Minecraft's day). */
    get dayTime() {
        return (this.time % DAY_TICKS) / DAY_TICKS
    }

    /** Which day it is (the moon's phase follows it). */
    get day() {
        return Math.floor(this.time / DAY_TICKS)
    }

    /**
     * The weather runs down its spell and picks the next: clear for 10 to 40
     * minutes, then rain for 5 to 10, three times in ten a thunderstorm.
     */
    private stepWeather() {
        if (--this.weather.ticksLeft > 0) return
        if (this.weather.kind === 'clear') {
            this.weather = { kind: randomFloat() < 0.3 ? 'thunder' : 'rain', ticksLeft: span(RAIN_TICKS) }
        } else {
            this.weather = { kind: 'clear', ticksLeft: span(CLEAR_TICKS) }
        }
        this.sim.raining = this.weather.kind !== 'clear'
    }

    // ── Time away ──────────────────────────────────────────────────────

    /**
     * Catches up on `ms` spent away (or with the tab asleep). Up to a minute
     * really runs, tick by tick, so what was in motion (furnaces, hoppers,
     * pistons) settles; the rest moves the island on to where its known
     * production takes it (the ledger): what its machines make keeps being
     * sold, stored and piled up at the rate it was, but never more of an item
     * than the island made. Chests can't grow past full; coins and the store
     * have no cap (Q33). No mobs come about and nothing burns (Q42).
     */
    catchUp(ms: number): AwayReport {
        const seconds = Math.max(0, ms / 1000)
        const simulated = Math.min(seconds, CATCH_UP_SIMULATED_S)
        const coinsBefore = this.coins
        const itemsBefore = this.containerTotals()
        const storeBefore = new Map(this.store)
        const ticks = Math.floor(simulated * TICKS_PER_SECOND)
        const fire = this.sim.fireEnabled
        const target = this.mobs.target
        this.sim.fireEnabled = false
        this.mobs.target = null
        for (let i = 0; i < ticks; i++) this.step()
        this.sim.fireEnabled = fire
        this.mobs.target = target
        // The clock keeps going for the rest of the time away (only the first stretch was simulated),
        // and after a long absence it's a new spell of weather.
        if (seconds > simulated) {
            this.time += Math.floor((seconds - simulated) * TICKS_PER_SECOND)
            if (seconds - simulated > 60 * 60) {
                this.weather = randomFloat() < 0.75 ? { kind: 'clear', ticksLeft: span(CLEAR_TICKS) } : { kind: 'rain', ticksLeft: span(RAIN_TICKS) }
                this.sim.raining = this.weather.kind !== 'clear'
            }
        }
        const report: AwayReport = { seconds, coins: this.coins - coinsBefore, items: {} }
        const note = (key: string, n: number) => {
            if (n > 0) report.items[key] = (report.items[key] ?? 0) + n
        }
        for (const [key, n] of this.containerTotals()) note(key, n - (itemsBefore.get(key) ?? 0))
        for (const [key, n] of this.store) note(key, n - (storeBefore.get(key) ?? 0))
        const rest = Math.floor((seconds - simulated) * TICKS_PER_SECOND)
        const more = rest > 0 ? this.ledger.project(rest) : null
        if (more) {
            for (const [key, n] of Object.entries(more.sold)) {
                const coins = sellValue(key, n)
                this.coins += coins
                this.earned += coins
                report.coins += coins
            }
            for (const [key, n] of Object.entries(more.stored)) {
                this.deposit(key, n)
                note(key, n)
            }
            for (const [key, n] of Object.entries(more.gained)) note(key, this.fillContainers(key, n))
        }
        return report
    }

    /**
     * What the chests hold, by item. Furnaces are left out: what they smelt
     * uses up what they were given, so it isn't something to extrapolate.
     */
    private containerTotals() {
        const totals = new Map<string, number>()
        for (const [k, box] of this.containers) {
            if (this.furnaces.has(k)) continue
            for (const s of box.slots) if (s) totals.set(s.item, (totals.get(s.item) ?? 0) + s.count)
        }
        return totals
    }

    /** Spreads extrapolated items over the chests that already hold that item, until they are full. */
    private fillContainers(key: string, count: number) {
        let left = count
        for (const [k, box] of this.containers) {
            if (left <= 0) break
            if (this.furnaces.has(k) || box.count(key) === 0) continue
            left = box.add(key, left)
        }
        return count - left
    }

    // ── Saving ─────────────────────────────────────────────────────────

    /** The island for its save files: a copy of each column's blocks with the containers standing in it, and the rest. */
    toSave(): SkyfarmIsland {
        const boxes = new Map<string, SavedContainer[]>()
        for (const [k, box] of this.containers) {
            const [x, y, z] = k.split(',').map(Number) as [number, number, number]
            const f = this.furnaces.get(k)
            const saved: SavedContainer = { x, y, z, slots: box.slots.map(s => (s ? { ...s } : null)), ...(f ? { furnace: [f.burn, f.burnMax, f.cook] } : {}) }
            const col = chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK))
            boxes.set(col, [...boxes.get(col) ?? [], saved])
        }
        const columns = [...this.world.chunks.values()].map((c) => {
            let cubes = 0
            for (let cy = 0; cy < LAYERS; cy++) if (this.world.ownsCube(c.cx, cy, c.cz)) cubes |= 1 << cy
            return { cx: c.cx, cz: c.cz, cubes, blocks: c.blocks.slice(), meta: c.meta.slice(), containers: boxes.get(chunkKey(c.cx, c.cz)) ?? [] }
        }).filter(c => c.cubes)
        return { state: this.saveState(), columns }
    }

    private saveState(): SkyfarmState {
        return {
            version: SKYFARM_SAVE_VERSION,
            inventory: this.inventory.slots,
            coins: this.coins,
            chunksBought: this.chunksBought,
            oreLevel: this.sim.oreLevel,
            player: { ...this.player },
            spawn: { ...this.spawn },
            earned: this.earned,
            time: this.time,
            weather: { ...this.weather },
            health: this.health,
            mobs: this.mobs.toSave(),
            armor: this.armor.slots,
            store: Object.fromEntries(this.store),
            ledger: this.ledger.toSave(),
            builds: this.builds,
            redstone: this.redstone.toSave()
        }
    }

    /** Loads a save file's island, or an older JSON save (blocks as text chunks). */
    static fromSave(data: SkyfarmIsland | SkyfarmSave): Island {
        const island = new Island()
        let save: SkyfarmState
        const boxes: SavedContainer[] = []
        if ('state' in data) {
            save = data.state
            for (const c of data.columns) {
                for (let cy = 0; cy < LAYERS; cy++) if (c.cubes & (1 << cy)) island.world.addCube(c.cx, cy, c.cz)
                const column = island.world.chunks.get(chunkKey(c.cx, c.cz))
                if (!column) continue
                column.blocks.set(c.blocks)
                column.meta.set(c.meta)
                boxes.push(...c.containers)
            }
        } else {
            save = data
            // Islands from before cubes owned whole columns: they keep all four cubes of each.
            if (data.cubes) for (const [cx, cy, cz] of data.cubes) island.world.addCube(cx, cy, cz)
            for (const c of data.chunks ?? []) {
                const chunk = data.cubes ? island.world.addCube(c.cx, -1, c.cz) : island.world.addChunk(c.cx, c.cz)
                chunk.blocks.set(decodeBytes(c.blocks, VOLUME))
                chunk.meta.set(decodeBytes(c.meta, VOLUME))
            }
        }
        for (const key of island.world.chunks.keys()) island.world.dirty.add(key)
        // Older saves kept the containers in the state; save files keep them in their column.
        for (const [k, slots] of Object.entries(save.containers ?? {})) {
            const [x, y, z] = k.split(',').map(Number) as [number, number, number]
            boxes.push({ x, y, z, slots, ...(save.furnaces?.[k] ? { furnace: save.furnaces[k] } : {}) })
        }
        for (const { x, y, z, slots, furnace } of boxes) {
            const k = posKey(x, y, z)
            const id = island.world.get(x, y, z)
            const isFurnace = FURNACES.has(id)
            const size = isFurnace ? FURNACE_SLOTS : id === B.Hopper ? HOPPER_SLOTS : id === B.Dropper || id === B.Dispenser ? DISPENSER_SLOTS : CHEST_SLOTS
            island.containers.set(k, new Slots(size, slots))
            if (isFurnace) {
                const [burn = 0, burnMax = 0, cook = 0] = furnace ?? []
                island.furnaces.set(k, { burn, burnMax, cook })
            }
        }
        island.inventory = new Slots(INVENTORY_SLOTS, save.inventory)
        if (save.armor) island.armor = new Slots(4, save.armor)
        island.coins = save.coins
        island.earned = save.earned
        island.time = save.time ?? 0
        if (save.weather) island.weather = { ...save.weather }
        island.sim.raining = island.weather.kind !== 'clear'
        // Cubes bought are cubes owned past the starter one: the server prices land the same way
        // (an older island, given whole chunks, counts every cube it owns as bought).
        island.chunksBought = Math.max(save.chunksBought, island.world.cubes.size - 1)
        island.sim.oreLevel = save.oreLevel
        island.spawn = { ...save.spawn }
        island.player = { ...save.player }
        // Saved dead (left on the death screen): back at the spawn point.
        if (save.health !== undefined && save.health > 0) island.health = Math.min(MAX_HEALTH, save.health)
        else if (save.health !== undefined) island.respawn()
        island.mobs.load(save.mobs)
        for (const [key, n] of Object.entries(save.store ?? {})) island.store.set(key, n)
        island.retireSellChests()
        island.ledger.load(save.ledger as LedgerBucket[] | undefined)
        island.builds = save.builds ?? 0
        island.redstone.load(save.redstone)
        // Saved before redstone ticks were: whatever was due is lost, so give the observers a nudge.
        if (save.redstone === undefined) island.redstone.restartAfterLoad()
        island.scanJobSites()
        // Flowing fluids pick up where they were.
        island.sim.wakeAll()
        return island
    }
}

/**
 * The six-way facing (an index into DIRS) that turns a block's face toward a
 * player looking along `yaw` and `pitch`: up or down when looking steeply
 * down or up, as Minecraft places pistons and observers.
 */
export function facingToward6(yaw: number, pitch: number) {
    if (pitch < -0.785) return UP
    if (pitch > 0.785) return DOWN
    return facingToward(yaw)
}

/** The chunk a world position is in. */
export function chunkOf(x: number, z: number) {
    return { cx: Math.floor(x / CHUNK), cz: Math.floor(z / CHUNK) }
}
