import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { B } from '../../app/utils/skyfarm/blocks'
import { craft } from '../../app/utils/skyfarm/crafting'
import { Island, MAX_HEALTH, REGEN_TICKS } from '../../app/utils/skyfarm/island'
import { Mob, MOBS, type MobKind } from '../../app/utils/skyfarm/mobs'

const NOON = 6000
const MIDNIGHT = 18000

/** An island with four chunks in a row and a 8x8 platform of `top` at y = 10, far (x 40..47) from the spawn point. */
function field(top = B.Grass, time = NOON) {
    const island = new Island()
    for (let cx = 0; cx < 4; cx++) island.world.addChunk(cx, 0)
    island.chunksBought = 3
    for (let x = 40; x < 48; x++) for (let z = 0; z < 8; z++) island.world.set(x, 10, z, top)
    island.time = time
    island.weather = { kind: 'clear', ticksLeft: 1e6 }
    return island
}

/** Walls round the platform's edge and a roof over it: inside (41..46, 11..12, 1..6) is sealed off. */
function seal(island: Island) {
    for (let x = 40; x < 48; x++) for (let z = 0; z < 8; z++) island.world.set(x, 13, z, B.Stone)
    for (let i = 0; i < 8; i++) {
        for (let y = 11; y < 13; y++) {
            island.world.set(40 + i, y, 0, B.Stone)
            island.world.set(40 + i, y, 7, B.Stone)
            island.world.set(40, y, i, B.Stone)
            island.world.set(47, y, i, B.Stone)
        }
    }
}

/** Where to stand to see the platform from more than 24 blocks off. */
const FAR = { x: 10, y: 30, z: 4 }

const env = (island: Island) => ({ skyDarken: island.skyDarken, raining: false, thundering: false, spawn: island.spawn })
const tries = (n: number, f: () => boolean) => Array.from({ length: n }, f).filter(Boolean).length

describe('the sky', () => {
    it('darkens from 0 at noon to 11 at midnight', () => {
        const island = field()
        expect(island.skyDarken).toBe(0)
        island.time = MIDNIGHT
        expect(island.skyDarken).toBe(11)
    })
})

describe('animals spawn', () => {
    it('on grass in daylight, never on dirt or in the dark', () => {
        const island = field()
        const m = island.mobs
        expect(tries(50, () => m.canSpawn('cow', 43, 11, 3, env(island)))).toBe(50)
        const dirt = field(B.Dirt)
        expect(tries(50, () => dirt.mobs.canSpawn('cow', 43, 11, 3, env(dirt)))).toBe(0)
        // Walled in and roofed over: no light, no animals.
        seal(island)
        expect(tries(50, () => m.canSpawn('cow', 43, 11, 3, env(island)))).toBe(0)
    })

    it('only every 400 ticks, never within 24 blocks of you or the spawn point', () => {
        const island = field()
        island.mobs.target = { ...FAR, active: true, held: null }
        // Not before the 400th tick.
        for (let i = 0; i < 399; i++) island.mobs.step()
        expect(island.mobs.list.length).toBe(0)
        // A try lands on the platform about one time in fifty (a column of it, at its height).
        for (let i = 0; i < 2000; i++) island.mobs.spawnInChunk(2, 0, false, env(island))
        const cows = island.mobs.list.filter(m => !m.hostile)
        expect(cows.length).toBeGreaterThan(0)
        for (const m of cows) {
            expect(Math.hypot(m.x - FAR.x, m.y - FAR.y, m.z - FAR.z)).toBeGreaterThan(24)
            expect(island.world.get(Math.floor(m.x), 10, Math.floor(m.z))).toBe(B.Grass)
        }
        // Nothing spawned with you standing on the platform.
        const near = field()
        near.mobs.target = { x: 44, y: 11, z: 4, active: true, held: null }
        for (let i = 0; i < 4000; i++) near.mobs.step()
        expect(near.mobs.list.length).toBe(0)
    })
})

describe('monsters spawn', () => {
    it('never in daylight or by torchlight, about a quarter of the time on an open field at night, always in a dark room', () => {
        const day = field(B.Stone)
        expect(tries(200, () => day.mobs.canSpawn('zombie', 43, 11, 3, env(day)))).toBe(0)
        const night = field(B.Stone, MIDNIGHT)
        const open = tries(400, () => night.mobs.canSpawn('zombie', 43, 11, 3, env(night)))
        expect(open).toBeGreaterThan(40)
        expect(open).toBeLessThan(180)
        night.world.set(44, 11, 3, B.Torch)
        expect(tries(200, () => night.mobs.canSpawn('zombie', 43, 11, 3, env(night)))).toBe(0)
        // A sealed stone room: pitch dark, day or night.
        const room = field(B.Stone)
        seal(room)
        expect(tries(100, () => room.mobs.canSpawn('zombie', 43, 11, 3, env(room)))).toBe(100)
        // Not on glass or a lower slab.
        room.world.set(43, 10, 3, B.Glass)
        expect(tries(50, () => room.mobs.canSpawn('zombie', 43, 11, 3, env(room)))).toBe(0)
    })

    it('only near the player, and while the game is not paused', () => {
        const island = field(B.Stone, MIDNIGHT)
        island.mobs.target = { ...FAR, active: false, held: null }
        for (let i = 0; i < 400; i++) island.mobs.step()
        expect(island.mobs.count(true)).toBe(0)
        island.mobs.target.active = true
        for (let i = 0; i < 400; i++) island.mobs.step()
        expect(island.mobs.count(true)).toBeGreaterThan(0)
    })
})

function withMob(kind: MobKind, top = B.Grass, time = NOON) {
    const island = field(top, time)
    const mob = new Mob(kind, 43.5, 11, 3.5)
    island.mobs.list.push(mob)
    return { island, mob }
}

describe('mobs move', () => {
    it('wander without walking off the edge of a platform in the void', () => {
        const { island, mob } = withMob('cow')
        island.mobs.target = { x: 0, y: 40, z: 0, active: false, held: null }
        let moved = 0
        for (let i = 0; i < 4000; i++) {
            const x = mob.x
            island.mobs.step()
            moved += Math.abs(mob.x - x)
        }
        expect(moved).toBeGreaterThan(2)
        expect(mob.y).toBeCloseTo(11, 1)
    })

    it('follow you around while you hold wheat', () => {
        const { island, mob } = withMob('cow')
        island.mobs.target = { x: 46.5, y: 11, z: 6.5, active: true, held: 'wheat' }
        for (let i = 0; i < 200; i++) island.mobs.step()
        expect(Math.hypot(mob.x - 46.5, mob.z - 6.5)).toBeLessThan(3)
    })

    it('find a way up a step', () => {
        const { island, mob } = withMob('zombie', B.Stone, MIDNIGHT)
        for (let z = 0; z < 8; z++) island.world.set(46, 11, z, B.Stone)
        for (let z = 0; z < 8; z++) island.world.set(47, 11, z, B.Stone)
        expect(island.mobs.pathTo(mob, 47, 12, 3)).toBe(true)
        expect(mob.path!.nodes.at(-1)).toEqual([47, 12, 3])
    })
})

describe('fighting', () => {
    it('knocks a mob back, and it drops its loot when it dies', () => {
        const { island, mob } = withMob('cow')
        island.mobs.target = { x: 42, y: 11, z: 3.5, active: true, held: null }
        expect(island.mobs.hurt(mob, 4, { x: 42, z: 3.5 }, true)).toBe(true)
        expect(mob.vx).toBeGreaterThan(0)
        expect(mob.panic).toBeGreaterThan(0)
        // Straight after, a weaker hit doesn't count.
        expect(island.mobs.hurt(mob, 3, undefined, true)).toBe(false)
        for (let i = 0; i < 20; i++) island.mobs.step()
        island.mobs.hurt(mob, 10, undefined, true)
        expect(mob.dead).toBe(true)
        expect(island.inventory.count('beef')).toBeGreaterThan(0)
        for (let i = 0; i < 21; i++) island.mobs.step()
        expect(island.mobs.list).not.toContain(mob)
    })

    it('a zombie comes for you and hits for 3', () => {
        const { island, mob } = withMob('zombie', B.Stone, MIDNIGHT)
        island.mobs.target = { x: 46.5, y: 11, z: 3.5, active: true, held: null }
        for (let i = 0; i < 100 && island.health === MAX_HEALTH; i++) island.step()
        expect(island.health).toBe(MAX_HEALTH - 3)
        expect(mob.targeting).toBe(true)
    })

    it('leaves you be while the game is paused', () => {
        const { island } = withMob('zombie', B.Stone, MIDNIGHT)
        island.mobs.target = { x: 45, y: 11, z: 3.5, active: false, held: null }
        for (let i = 0; i < 100; i++) island.step()
        expect(island.health).toBe(MAX_HEALTH)
    })

    it('a creeper next to you hisses, then blows a hole and hurts you badly', () => {
        const { island, mob } = withMob('creeper', B.Stone, MIDNIGHT)
        island.mobs.target = { x: 45, y: 11, z: 3.5, active: true, held: null }
        for (let i = 0; i < 60 && !mob.dead; i++) island.step()
        expect(mob.dead).toBe(true)
        expect(island.health).toBeLessThan(MAX_HEALTH - 6)
        const holes = [42, 43, 44, 45].filter(x => island.world.get(x, 10, 3) === B.Air)
        expect(holes.length).toBeGreaterThan(0)
    })

    it('an explosion spills a chest it breaks', () => {
        const island = field(B.Stone)
        island.inventory.add('chest', 1)
        island.placeFromSlot(0, 43, 11, 3)
        island.container(43, 11, 3)!.add('diamond', 5)
        island.explode(43.5, 11, 4.5, 3)
        expect(island.world.get(43, 11, 3)).toBe(B.Air)
        expect(island.inventory.count('diamond')).toBe(5)
    })
})

describe('witches', () => {
    it('drop redstone, glowstone dust and the rest of their loot', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 400; i++) for (const s of MOBS.witch.drops(false, true)) seen.add(s.item)
        expect([...seen].sort()).toEqual(['glass_bottle', 'glowstone_dust', 'gunpowder', 'redstone', 'spider_eye', 'stick', 'sugar'])
    })

    it('spawn alone', () => {
        expect(MOBS.witch.group).toBe(1)
    })

    it('throw slowness from afar, poison up close while you are healthy, harming once you are poisoned', () => {
        const kinds = (x: number, effects = { poison: 0, slowness: 0, weakness: 0 }, health = 20) => {
            const { island, mob } = withMob('witch', B.Stone, MIDNIGHT)
            island.mobs.target = { x, y: 11, z: 3.5, active: true, held: null, health, effects }
            mob.seeTarget = true
            mob.targeting = true
            for (let i = 0; i < 80 && !island.mobs.potions.length; i++) island.mobs.step()
            return island.mobs.potions[0]?.kind
        }
        // 8.5 blocks off: slowness first.
        expect(kinds(52)).toBe('slowness')
        expect(kinds(47.4)).toBe('poison')
        expect(kinds(47.4, { poison: 100, slowness: 0, weakness: 0 })).toMatch(/harming|weakness/)
    })

    it('poison takes health away but never the last point; harming hurts at once', () => {
        const island = field()
        island.hurtPlayer(17)
        island.splashPlayer('poison', 1)
        for (let i = 0; i < 1000; i++) island.step()
        expect(island.health).toBeGreaterThanOrEqual(1)
        expect(island.dead).toBe(false)
        const fresh = field()
        fresh.splashPlayer('harming', 1)
        expect(fresh.health).toBe(14)
    })

    it('drink to heal when hurt', () => {
        const { island, mob } = withMob('witch', B.Stone, MIDNIGHT)
        island.mobs.target = { ...FAR, active: false, held: null }
        mob.health = 10
        for (let i = 0; i < 400 && mob.health === 10; i++) island.mobs.step()
        expect(mob.health).toBe(14)
    })
})

describe('zombie villagers', () => {
    it('are one zombie in twenty', () => {
        expect(MOBS.zombie.weight).toBe(95)
        expect(MOBS.zombie_villager.weight).toBe(5)
    })

    it('are cured by weakness and a golden apple, shaking a while, then stand up villagers', () => {
        const { island, mob } = withMob('zombie_villager', B.Stone, MIDNIGHT)
        mob.armor.head = 'iron_helmet'
        island.mobs.target = { ...FAR, active: false, held: null }
        island.inventory.add('golden_apple', 2)
        island.mobs.affect(mob, 'weakness', 1)
        expect(mob.effects.weakness).toBe(1800)
        expect(island.feedGoldenApple(0, mob)).toEqual({ used: true, curing: true })
        expect(island.inventory.count('golden_apple')).toBe(1)
        expect(mob.converting).toBeGreaterThanOrEqual(3600)
        expect(mob.converting).toBeLessThanOrEqual(6000)
        // Already curing: no second apple taken.
        expect(island.feedGoldenApple(0, mob).used).toBe(false)
        // Being cured, it doesn't despawn, and comes back with you from a save.
        const back = Island.fromSave(throughFile(island.toSave())!)
        expect(back.mobs.list.find(m => m.kind === 'zombie_villager')?.converting).toBe(mob.converting)
        for (let i = 0; i < 6000 && mob.converting > 0; i++) island.mobs.step()
        expect(island.mobs.list.map(m => m.kind)).toEqual(['villager'])
        expect(island.inventory.count('iron_helmet')).toBe(1)
        // The villager is kept in a save.
        expect(Island.fromSave(throughFile(island.toSave())!).mobs.list.map(m => m.kind)).toEqual(['villager'])
    })

    it('take a golden apple without weakness only one time in ten (and eat it anyway)', () => {
        let cured = 0
        for (let i = 0; i < 2000; i++) {
            const { island, mob } = withMob('zombie_villager', B.Stone, MIDNIGHT)
            const r = island.mobs.feedGoldenApple(mob)
            expect(r.used).toBe(true)
            if (r.curing) cured++
        }
        expect(cured / 2000).toBeGreaterThan(0.07)
        expect(cured / 2000).toBeLessThan(0.13)
    })

    it('are weakened by a potion you throw at them', () => {
        const { island, mob } = withMob('zombie_villager', B.Stone, MIDNIGHT)
        island.mobs.target = { x: 40.5, y: 11, z: 3.5, active: true, held: null }
        island.inventory.add('splash_potion_weakness', 1)
        // From three blocks off, a little upward, as you would lob it.
        island.throwPotion(0, 40.5, 12.5, 3.5, 1, 0.15, 0)
        for (let i = 0; i < 40 && island.mobs.potions.length; i++) island.mobs.step()
        expect(mob.effects.weakness).toBeGreaterThan(0)
        expect(island.inventory.count('splash_potion_weakness')).toBe(0)
    })
})

describe('potions on mobs', () => {
    it('harming heals the undead and hurts the rest; poison leaves the undead and spiders alone', () => {
        const { island, mob: zombie } = withMob('zombie', B.Stone, MIDNIGHT)
        zombie.health = 10
        island.mobs.affect(zombie, 'harming', 1)
        expect(zombie.health).toBe(14)
        island.mobs.affect(zombie, 'poison', 1)
        expect(zombie.effects.poison).toBe(0)
        const spider = new Mob('spider', 44.5, 11, 4.5)
        island.mobs.affect(spider, 'poison', 1)
        expect(spider.effects.poison).toBe(0)
        const cow = new Mob('cow', 45.5, 11, 4.5)
        island.mobs.list.push(cow)
        island.mobs.affect(cow, 'harming', 1)
        expect(cow.health).toBe(4)
        island.mobs.affect(cow, 'poison', 1)
        island.mobs.target = { ...FAR, active: false, held: null }
        for (let i = 0; i < 900; i++) island.mobs.step()
        // Poison wears it down to the last point and no further.
        expect(cow.health).toBe(1)
        expect(cow.dead).toBe(false)
    })
})

describe('golden apples', () => {
    it('are eight gold around an apple, and heal four over five seconds', () => {
        const G = { item: 'gold_ingot', count: 1 }
        expect(craft([G, G, G, G, { item: 'apple', count: 1 }, G, G, G, G], 3)).toEqual({ item: 'golden_apple', count: 1 })
        const island = field()
        island.hurtPlayer(10)
        island.inventory.add('golden_apple', 1)
        expect(island.eatGoldenApple(0)).toBe(true)
        for (let i = 0; i < 100; i++) island.step()
        // Four from the apple, one from your own healing.
        expect(island.health).toBe(15)
    })
})

describe('the undead', () => {
    it('burn in the midday sun, and not at night', () => {
        const { island, mob } = withMob('zombie', B.Stone, NOON)
        island.mobs.target = { x: 0, y: 40, z: 0, active: false, held: null }
        for (let i = 0; i < 200; i++) island.mobs.step()
        expect(mob.health).toBeLessThan(20)
        const night = withMob('zombie', B.Stone, MIDNIGHT)
        night.island.mobs.target = { x: 0, y: 40, z: 0, active: false, held: null }
        for (let i = 0; i < 200; i++) night.island.mobs.step()
        expect(night.mob.health).toBe(20)
        // A helmet keeps the sun off.
        const helmeted = withMob('zombie', B.Stone, NOON)
        helmeted.mob.armor.head = 'leather_helmet'
        helmeted.island.mobs.target = { x: 0, y: 40, z: 0, active: false, held: null }
        for (let i = 0; i < 200; i++) helmeted.island.mobs.step()
        expect(helmeted.mob.health).toBe(20)
    })
})

describe('your health', () => {
    it('comes back a point every four seconds, with no hunger', () => {
        const island = field()
        island.hurtPlayer(5)
        expect(island.health).toBe(15)
        for (let i = 0; i < REGEN_TICKS * 3; i++) island.step()
        expect(island.health).toBe(18)
    })

    it('runs out, and respawning brings it back', () => {
        const island = field()
        island.hurtPlayer(25)
        expect(island.dead).toBe(true)
        for (let i = 0; i < 200; i++) island.step()
        expect(island.health).toBe(0)
        island.respawn()
        expect(island.health).toBe(MAX_HEALTH)
        expect(island.player.y).toBe(island.spawn.y)
    })
})

describe('grass', () => {
    it('spreads to dirt next to it in daylight, and dies under a block', () => {
        const island = field(B.Dirt)
        island.world.set(43, 10, 3, B.Grass)
        // Held at noon: grass doesn't spread at night, which would leave the result to chance.
        for (let i = 0; i < 20_000; i++) {
            island.time = NOON
            island.step()
        }
        let grass = 0
        for (let x = 40; x < 48; x++) for (let z = 0; z < 8; z++) if (island.world.get(x, 10, z) === B.Grass) grass++
        expect(grass).toBeGreaterThan(3)
        island.world.set(43, 11, 3, B.Stone)
        island.world.set(43, 10, 3, B.Grass)
        for (let i = 0; i < 20_000 && island.world.get(43, 10, 3) === B.Grass; i++) island.step()
        expect(island.world.get(43, 10, 3)).toBe(B.Dirt)
    })
})

describe('saving', () => {
    it('keeps the animals and your health, not the monsters', () => {
        const island = field()
        island.mobs.list.push(new Mob('sheep', 44.5, 11, 4.5, 1, 6), new Mob('zombie', 42.5, 11, 2.5))
        island.hurtPlayer(7)
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!)
        expect(back.health).toBe(13)
        expect(back.mobs.list.map(m => [m.kind, m.health])).toEqual([['sheep', 6]])
    })
})
