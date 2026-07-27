# Pathwarden ambient story catalogue

Ambient stories are slow background theatre, not particle effects. A story owns
one revealed road segment (“block”), enters from a castle gate or a hidden
continuation beyond the mist, performs a readable sequence, then leaves by a
walkable route. No actor teleports at a visible boundary.

Each family has ten authored variants (01–10), for **250 distinct stories**.
Variants change cast size, props, timing, direction, reactions, costume palette,
and punchline while preserving the family’s expected behaviour.

| IDs | Family | Expected script |
|---|---|---|
| 001–010 | Market day | Porters arrive, erect poles/canopy/counter, traders arrive by road, goods and coins change hands, stock is packed, stall is dismantled, everyone leaves. |
| 011–020 | Hunter and deer | Deer enters from hidden terrain, hunter stalks and chases; on success the catch is roped and dragged to the gate, on failure the deer continues beyond the mist before either naturally returns or remains gone. |
| 021–030 | Lovers’ picnic | Couple walks from gate, lays blanket, unpacks food, chats or naps, reacts to a curious animal, packs every prop, walks home. |
| 031–040 | Travelling musician | Musician arrives by road, opens case, performs, passers-by stop and tip, performer bows, closes case and departs. |
| 041–050 | Children at play | Children arrive with hoop, kite, ball or toy knight, play with turn-taking and small mishaps, retrieve every toy and run home. |
| 051–060 | Shepherd’s crossing | Shepherd leads a varying flock along connected roads, stragglers are rounded up, flock disappears naturally into gate or mist. |
| 061–070 | Guard patrol | Two or three guards leave the gate, inspect towers and road mouths, exchange positions, report back and enter the gate. |
| 071–080 | Peddler | Cart enters from mist, pauses at junctions, advertises wares, makes or misses a sale, continues to gate or another mist mouth. |
| 081–090 | Construction crew | Workers leave the gate with tools, navigate to a tower, inspect, hammer and carry supplies, clean up, return by navigable terrain. |
| 091–100 | Cat business | Cat emerges from gate, stalks grass, pounces, grooms, investigates a prop, then chooses a natural exit. |
| 101–110 | Bird life | Bird crosses beyond both visible edges, circles, lands, pecks or steals food, takes off and continues beyond the far mist. |
| 111–120 | Dog and courier | Courier enters with dog, dog becomes distracted, courier calls it back, delivery reaches gate or stall, both depart together. |
| 121–130 | Bakers’ delivery | Bakers carry baskets from gate, cool loaves, hand samples to citizens, gather baskets and return. |
| 131–140 | Fisher’s tale | Fisher carries rod and exaggerated catch, gathers listeners, demonstrates the size, loses or sells the fish, leaves. |
| 141–150 | Lost chicken | Chicken escapes from gate, zigzags around open ground, citizens coordinate a chase, chicken is gently caught and carried home. |
| 151–160 | Knight training | Squires set safe targets, knights practice spear and shield drills, collect equipment, salute and return. |
| 161–170 | Herbalist | Herbalist walks to suitable meadow cells, examines plants, gathers a few, trades or delivers a bundle, returns. |
| 171–180 | Pilgrim procession | Small procession follows the road, pauses at the keep or spire, performs a quiet ritual, continues without blocking traffic. |
| 181–190 | Rainy scramble | A brief local shower prompts citizens to open umbrellas, shelter under a built canopy, shake dry, fold gear and continue. |
| 191–200 | Festival rehearsal | Citizens carry bunting and instruments, hang temporary decorations, rehearse, correct a comic mistake, remove everything. |
| 201–210 | Scholar and apprentice | Pair measures roads/towers, apprentice records results or drops scrolls, pages are recovered, both report to gate. |
| 211–220 | Beekeeper | Keeper places a temporary skep, bees circle locally, honey is collected, a passer-by reacts, skep and tools are removed. |
| 221–230 | Tiny creatures | Rabbits, hedgehogs, frogs or squirrels forage, react to citizens, use terrain cover and leave through hidden meadow. |
| 231–240 | Royal inspection | Herald and official arrive from gate, guards present towers, notes are taken, a minor protocol joke occurs, party returns. |
| 241–250 | Midnight oddities | Ghost lantern, dancing mushrooms, sleepy troll or wandering armour performs one restrained rare vignette, then fades only while hidden in mist or inside the gate. |

## Scheduling and completion rules

- At most four stories may exist globally.
- At most two stories may occupy the same revealed block.
- Starts are randomized and staggered over minutes; families do not synchronize.
- Stories last roughly 1½–5 minutes and use gentle entry/exit fades only while
  occluded by the castle gate or world-edge fog.
- Completion is tracked by story ID. Seeing all 250 unlocks **Village Chronicler**
  and one free permanent Pathwarden upgrade. Debug previews never count.
- The development trigger can request any ID and phase without accelerating the
  production scheduler.
