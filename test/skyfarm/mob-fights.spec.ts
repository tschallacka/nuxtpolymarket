import { describe, expect, it } from 'vitest'
import { isValidSave, throughFile } from './save-helpers'
import { B } from '../../app/utils/skyfarm/blocks'
import { Island } from '../../app/utils/skyfarm/island'
import { CAT_VARIANTS, Mob, MOBS, type MobKind } from '../../app/utils/skyfarm/mobs'

const NOON = 6000
const MIDNIGHT = 18000

/** Four chunks in a row with a 16x16 floor of stone at y = 10 (x 40..55), you far off and not playing (no monsters spawn). */
function arena(time = NOON) {
    const island = new Island()
    for (let cx = 0; cx < 4; cx++) island.world.addChunk(cx, 0)
    island.chunksBought = 3
    for (let x = 40; x < 56; x++) for (let z = 0; z < 16; z++) island.world.set(x, 10, z, B.Stone)
    island.time = time
    island.weather = { kind: 'clear', ticksLeft: 1e6 }
    island.mobs.target = { x: 10, y: 30, z: 4, active: false, held: null }
    island.mobs.farming = false
    return island
}

/** A roof over the floor at y = 14 (the undead don't burn under it). */
function roof(island: Island) {
    for (let x = 40; x < 56; x++) for (let z = 0; z < 16; z++) island.world.set(x, 14, z, B.Stone)
}

function put(island: Island, kind: MobKind, x: number, z: number) {
    const m = new Mob(kind, x + 0.5, 11, z + 0.5)
    island.mobs.list.push(m)
    return m
}

/** Runs the island on, keeping each of `held` where it started (and unable to hit). */
const run = (island: Island, ticks: number, ...held: Mob[]) => {
    const at = held.map(m => [m.x, m.y, m.z] as const)
    for (let i = 0; i < ticks; i++) {
        island.step()
        held.forEach((m, j) => {
            [m.x, m.y, m.z] = at[j]!
            m.vx = m.vz = 0
            m.attackCooldown = 20
        })
    }
}
const flat = (a: Mob, b: Mob) => Math.hypot(a.x - b.x, a.z - b.z)

describe('zombies and villagers', () => {
    it('a zombie goes for a villager it can see when you are not about', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const zombie = put(island, 'zombie', 42, 2)
        const villager = put(island, 'villager', 50, 10)
        run(island, 40)
        expect(zombie.foe).toBe(villager)
        expect(zombie.targeting).toBe(true)
    })

    it('you come before a villager', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const zombie = put(island, 'zombie', 42, 2)
        put(island, 'villager', 50, 10)
        island.mobs.target = { x: 44.5, y: 11, z: 4.5, active: true, held: null }
        run(island, 20)
        expect(zombie.foe).toBeNull()
        expect(zombie.targeting).toBe(true)
    })

    it('a villager runs from a zombie within eight blocks', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const villager = put(island, 'villager', 47, 7)
        const zombie = put(island, 'zombie', 45, 7)
        // Hold the zombie still: only the villager moves.
        const start = flat(villager, zombie)
        run(island, 60, zombie)
        expect(flat(villager, zombie)).toBeGreaterThan(start + 2)
    })

    it('a villager killed by a zombie comes back as a zombie villager half the time, keeping its trade', () => {
        const island = arena()
        const zombie = put(island, 'zombie', 42, 2)
        let turned = 0
        for (let i = 0; i < 400; i++) {
            const v = put(island, 'villager', 44, 4)
            v.profession = 'farmer'
            v.offers = [{ a: { item: 'wheat', count: 20 }, out: { item: 'emerald', count: 1 }, uses: 3, max: 16, xp: 2 }]
            v.level = 2
            island.mobs.hurt(v, 100, { x: zombie.x, z: zombie.z }, false, 0.4, true, zombie)
            const z = island.mobs.list.find(m => m.kind === 'zombie_villager' && !m.removed)
            if (z) {
                turned++
                expect(v.removed).toBe(true)
                expect(z.profession).toBe('farmer')
                expect(z.offers[0]!.out.item).toBe('emerald')
                expect(z.level).toBe(2)
                expect(z.keep).toBe(true)
                z.removed = true
                island.mobs.list = island.mobs.list.filter(m => m !== z)
            }
            island.mobs.list = island.mobs.list.filter(m => m !== v)
        }
        expect(turned).toBeGreaterThan(150)
        expect(turned).toBeLessThan(250)
    })

    it('a turned villager is kept in the save, and curing it gives its old offers back', () => {
        const island = arena()
        const zombie = put(island, 'zombie', 42, 2)
        let z: Mob | undefined
        while (!z) {
            const v = put(island, 'villager', 44, 4)
            v.profession = 'farmer'
            v.offers = [{ a: { item: 'wheat', count: 20 }, out: { item: 'emerald', count: 1 }, uses: 3, max: 16, xp: 2 }]
            island.mobs.hurt(v, 100, { x: zombie.x, z: zombie.z }, false, 0.4, true, zombie)
            z = island.mobs.list.find(m => m.kind === 'zombie_villager')
            island.mobs.list = island.mobs.list.filter(m => m !== v)
        }
        island.mobs.list = island.mobs.list.filter(m => m !== zombie)
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        const back = Island.fromSave(throughFile(save)!)
        const kept = back.mobs.list.find(m => m.kind === 'zombie_villager')!
        expect(kept.keep).toBe(true)
        expect(kept.offers[0]!.a.item).toBe('wheat')
        // Cure it: the villager has its offers again.
        kept.converting = 1
        back.mobs.target = { x: 10, y: 30, z: 4, active: false, held: null }
        back.step()
        const cured = back.mobs.list.find(m => m.kind === 'villager')!
        expect(cured.offers[0]!.out.item).toBe('emerald')
        expect(cured.profession).toBe('farmer')
    })
})

describe('mobs hit by another mob', () => {
    it('go for the mob that hit them', () => {
        const island = arena(MIDNIGHT)
        const skeleton = put(island, 'skeleton', 42, 2)
        const zombie = put(island, 'zombie', 45, 5)
        island.mobs.hurt(zombie, 2, { x: skeleton.x, z: skeleton.z }, false, 0.4, true, skeleton)
        expect(zombie.foe).toBe(skeleton)
        expect(zombie.revenge).toBe(true)
        expect(zombie.targeting).toBe(true)
    })

    it('a monster after the mob that hit it doesn\'t switch to you', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const a = put(island, 'zombie', 42, 2)
        const b = put(island, 'zombie', 50, 10)
        island.mobs.hurt(b, 1, { x: a.x, z: a.z }, false, 0.4, true, a)
        island.mobs.target = { x: 51.5, y: 11, z: 11.5, active: true, held: null }
        run(island, 20)
        expect(b.foe).toBe(a)
    })

    it('an arrow counts as its skeleton\'s blow', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const skeleton = put(island, 'skeleton', 42, 7)
        const creeper = put(island, 'creeper', 50, 7)
        island.mobs.launchArrow(44, 12, 7.5, 1, 0, 0, 2, 0)
        island.mobs.arrows[0]!.owner = skeleton.id
        run(island, 10)
        expect(creeper.foe).toBe(skeleton)
    })

    it('an animal hit by a mob runs instead', () => {
        const island = arena()
        const zombie = put(island, 'zombie', 42, 2)
        const cow = put(island, 'cow', 44, 4)
        island.mobs.hurt(cow, 2, { x: zombie.x, z: zombie.z }, false, 0.4, true, zombie)
        expect(cow.panic).toBeGreaterThan(0)
        expect(cow.foe).toBeNull()
    })
})

describe('cats', () => {
    it('creepers keep away from them', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const cat = put(island, 'cat', 47, 7)
        const creeper = put(island, 'creeper', 48, 8)
        run(island, 80, cat)
        expect(flat(creeper, cat)).toBeGreaterThan(4)
    })

    it('turn up near four villagers, never more than five, and never by fewer villagers', () => {
        const island = arena()
        for (let i = 0; i < 3; i++) put(island, 'villager', 44 + i, 4)
        expect(island.mobs.spawnCat()).toBeNull()
        put(island, 'villager', 48, 4)
        for (let i = 0; i < 20; i++) island.mobs.spawnCat()
        const cats = island.mobs.list.filter(m => m.kind === 'cat')
        expect(cats.length).toBe(5)
        for (const c of cats) expect(c.variant).toBeLessThan(CAT_VARIANTS.length)
    })

    it('keep their coat through a save', () => {
        const island = arena()
        const cat = put(island, 'cat', 44, 4)
        cat.variant = 7
        const back = Island.fromSave(throughFile(island.toSave())!)
        expect(back.mobs.list.find(m => m.kind === 'cat')!.variant).toBe(7)
    })
})

describe('iron golems', () => {
    it('three scared villagers call one up, and not again while it is about', () => {
        const island = arena()
        const vs = [put(island, 'villager', 44, 4), put(island, 'villager', 45, 4)]
        expect(island.mobs.summonGolem(vs[0]!, 3)).toBeNull()
        vs.push(put(island, 'villager', 46, 4))
        const golem = island.mobs.summonGolem(vs[0]!, 3)
        expect(golem?.kind).toBe('iron_golem')
        expect(golem!.health).toBe(100)
        expect(island.mobs.summonGolem(vs[1]!, 3)).toBeNull()
    })

    it('villagers penned in near a zombie call one up by themselves', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        // A glass pen (x 46..48, z 8): they see the zombie but can't run from it, as in an iron farm.
        for (let x = 45; x <= 49; x++) for (let z = 7; z <= 9; z++) for (let y = 11; y <= 12; y++) if (x === 45 || x === 49 || z !== 8) island.world.set(x, y, z, B.Glass)
        for (let i = 0; i < 3; i++) put(island, 'villager', 46 + i, 8)
        const zombie = put(island, 'zombie', 44, 8)
        run(island, 120, zombie)
        expect(island.mobs.list.filter(m => m.kind === 'iron_golem').length).toBe(1)
    })

    it('fight monsters and kill them, but leave creepers be', () => {
        const island = arena(MIDNIGHT)
        roof(island)
        const golem = put(island, 'iron_golem', 42, 2)
        const zombie = put(island, 'zombie', 50, 10)
        const creeper = put(island, 'creeper', 44, 12)
        run(island, 400)
        expect(zombie.dead || zombie.removed).toBe(true)
        expect(creeper.dead).toBe(false)
        expect(golem.foe).not.toBe(creeper)
    })

    it('are not knocked back, and get angry with you when you hit one', () => {
        const island = arena()
        const golem = put(island, 'iron_golem', 44, 4)
        island.mobs.hurt(golem, 5, { x: 43, z: 4.5 }, true)
        expect(golem.vx).toBe(0)
        expect(golem.anger).toBeGreaterThanOrEqual(400)
    })

    it('drop three to five iron ingots and up to two poppies', () => {
        for (let i = 0; i < 200; i++) {
            const drops = MOBS.iron_golem.drops(false, false)
            const iron = drops.find(s => s.item === 'iron_ingot')?.count ?? 0
            const poppy = drops.find(s => s.item === 'poppy')?.count ?? 0
            expect(iron).toBeGreaterThanOrEqual(3)
            expect(iron).toBeLessThanOrEqual(5)
            expect(poppy).toBeLessThanOrEqual(2)
        }
    })

    it('save with their 100 health', () => {
        const island = arena()
        put(island, 'iron_golem', 44, 4)
        const save = island.toSave()
        expect(isValidSave(save)).toBe(true)
        expect(Island.fromSave(throughFile(save)!).mobs.list.find(m => m.kind === 'iron_golem')!.health).toBe(100)
    })
})
