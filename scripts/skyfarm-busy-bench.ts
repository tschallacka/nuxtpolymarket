// How the simulation holds up on the busy test island (100 cubes of machines):
// time per game tick, split by part, and what the machines made.
//
//   bun run bench:skyfarm [ticks]      (default 2400: two game minutes)
import { B } from '../app/utils/skyfarm/blocks'
import { busyIsland } from '../app/utils/skyfarm/test-island'

const t0 = performance.now()
const island = busyIsland()
console.log('build ms', Math.round(performance.now() - t0), 'cubes', island.world.cubes.size, 'columns', island.world.chunks.size, 'mobs', island.mobs.list.length)
island.mobs.target = { x: 5.5, y: 24, z: 5.5, active: false, held: null }
const coins0 = island.coins
const ticks = Number(process.argv[2] ?? 2400)
const parts: Record<string, number> = {}
const timed = (name: string, fn: () => void) => {
    const s = performance.now()
    fn()
    parts[name] = (parts[name] ?? 0) + performance.now() - s
}
const anyIsland = island as unknown as Record<string, () => void>
const s0 = performance.now()
let slow = 0
for (let i = 0; i < ticks; i++) {
    const s = performance.now()
    island.time++
    timed('weather', () => anyIsland.stepWeather!.call(island))
    timed('sim', () => island.sim.step())
    timed('randomTicks', () => anyIsland.randomTicks!.call(island))
    timed('furnaces', () => anyIsland.stepFurnaces!.call(island))
    timed('composters', () => anyIsland.stepComposters!.call(island))
    timed('redstone', () => island.redstone.step())
    timed('health', () => anyIsland.stepHealth!.call(island))
    timed('mobs', () => island.mobs.step())
    timed('ledger', () => island.ledger.tick(() => island.containerTotals()))
    if (performance.now() - s > 50) slow++
}
const total = performance.now() - s0
console.log(`ticks ${ticks}: ${(total / ticks).toFixed(3)} ms/tick avg, ${slow} ticks over 50ms`)
for (const [k, v] of Object.entries(parts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${(v / ticks).toFixed(3)} ms/tick`)
console.log('coins earned', Math.round(island.coins - coins0), 'on its way to storage', JSON.stringify(Object.fromEntries(island.store)))
const totals = island.containerTotals()
console.log('in containers', JSON.stringify(Object.fromEntries(totals)))
console.log('leaked to inventory', JSON.stringify(island.inventory.slots.filter(Boolean)))
const villagers = island.mobs.list.filter(m => m.kind === 'villager')
console.log('villagers', villagers.length, 'farmers', villagers.filter(m => m.profession === 'farmer').length, 'farmer inv', JSON.stringify(villagers.filter(m => m.profession === 'farmer').slice(0, 2).map(m => m.inv.slots.filter(Boolean))))
let ripe = 0, wheat = 0
for (const c of island.world.chunks.values()) for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i] === B.Wheat) { wheat++; if ((c.meta[i]! & 7) === 7) ripe++ }
console.log('wheat plants', wheat, 'ripe', ripe, 'mobs now', island.mobs.list.length)
