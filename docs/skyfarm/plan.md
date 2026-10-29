# Skyfarm: plan

A first-person, Minecraft-style skyblock that plays as a semi-idle automation game. You start on
a scrap of island in the void, build a cobblestone generator, and work up to redstone-driven
farms that keep producing while you're away. Decisions from Michael, 2026-10-20 (Q31–Q35):

- **3D voxel, first person** (Q31).
- **In-game money** from the shop for now; site coins/gems hook in later, once tuned (Q32).
- **Saved server-side, offline catch-up with no time cap.** The island grows by buying chunks;
  every next chunk costs 1.2× the one before (Q33).
- **Core redstone set** (Q34): dust, torch, lever, button, repeater, observer, piston, sticky
  piston, hopper, chest, dropper, dispenser, plus a block breaker.

## The loop

1. **Start**: the classic skyblock scrap: an L of dirt with a tree, a chest with a lava bucket,
   ice (water) and a sapling.
2. **Cobblestone generator**: water and lava flow; where flowing lava meets water, cobblestone
   forms. Mine it, sell it, build with it.
3. **Shop**: sell anything for coins; buy seeds, saplings, sugar cane, cactus, melon and pumpkin
   seeds, sand, redstone parts, hoppers, chests, the **sell chest**, tool tiers, generator
   upgrades (ore chances: coal, iron, gold, diamond) and **island chunks** (×1.2 each).
4. **Automate**: a block breaker on the generator, observers and pistons on melons and pumpkins,
   cane and cactus farms, a tree farm, hoppers carrying it all into a sell chest.
5. **Idle**: close the tab; come back to the coins your farms earned while you were gone.

## Offline progress (no cap)

Simulating hours of redstone on return is too slow, so:

- The server stores the island and when it was saved (server time, not the client's clock).
- On return the game fast-forwards about ten minutes of real ticks so every farm settles into
  its rhythm, measures what each container (and sell chest) gained, and extrapolates those rates
  over the whole time away.
- Capacity still applies: a full chest stops what feeds it, as in Minecraft; a sell chest never
  fills, it sells. Sell chests are what make an island truly idle.

## Simulation

- **Ticks**: 20 game ticks a second (redstone ticks every 2). Random ticks grow crops, saplings,
  cane and cactus.
- **Fluids**: water spreads 7 blocks, lava 3, with sources, flowing levels and falling columns.
- **Redstone**: power levels 0–15 on dust, strong/weak power through blocks, torches invert,
  repeaters delay and diode, observers pulse on change, pistons push up to 12 blocks, sticky
  pistons pull, hoppers move items between containers, droppers/dispensers emit, block breakers
  mine what is in front of them.

## Persistence

- One row per player: the island's chunks (block ids, compressed), containers, machine state,
  inventory, coins, owned chunks, `saved_at`, and an integer `version` for optimistic saves
  (integer compare-and-swap; never on a timestamp).
- Autosave every 30 s and when the tab is hidden.

## Phases

1. **Playable core**: voxel island, first person, place/break, hotbar and inventory, the
   skyblock start, water and lava, the cobblestone generator, shop (sell/buy), chunk buying,
   save/load and offline catch-up.
2. **Growing things**: crafting and the furnace, trees and saplings, crops, cane, cactus,
   melons, pumpkins; chests, hoppers and the sell chest.
3. **Redstone**: the core set and the block breaker; the classic farms work.
4. **Polish**: textures, sounds, models, tutorial quests.
