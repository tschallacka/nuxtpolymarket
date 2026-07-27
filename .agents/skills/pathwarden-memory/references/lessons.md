# Pathwarden accumulated lessons

## Contents

1. Product identity and terminology
2. Road model and expansion semantics
3. Repeated road-rendering failures
4. Visual geometry and painter order
5. Combat, enemies, and projectiles
6. Interaction and camera
7. Ambient world
8. Economy, progression, and monetization
9. Verification discipline
10. Current files and unfinished work

## 1. Product identity and terminology

- Pathwarden is a faux-3D isometric tower-defense game inspired by Rogue Tower, but it must have its own assets and identity.
- The run currency is **Aether**, consistently green in the HUD and all purchase contexts.
- Global **Coins** are earned at checkpoints/completion and buy permanent progression or defenses.
- **Gems** buy supercharges, cooldown shortcuts, selected permanent upgrades, and cosmetic bragging-right skins.
- A complete run has 12 waves and checkpoints at waves 4, 8, and 12.
- The intended tension is spending enough Aether to survive while saving enough for a lucrative checkpoint conversion.
- Players may cash out or continue only at checkpoints.
- A run starts a two-hour cooldown; Gems can shorten it.
- Debug mode permits purchases without funds and unlimited expansion testing, but debug resources must never become real account rewards.

## 2. Road model and expansion semantics

### Authoritative plan

- Precompute the complete seeded expansion graph at initialization.
- `plannedSections` is immutable geometry; `claimedSections` is selection state.
- `extendPath()` may only commit a precomputed section. It must never generate, reroute, or overwrite geometry.
- Random seed changes the map, while the same seed must reproduce it.
- One chosen route must support 13 expansion clicks for the 12-wave run. Terminal enemy approaches remain precomputed beyond the visible frontier.
- Unchosen expansion options persist. Choosing A must not remove B or any earlier road mouth.
- Roads may branch through authentic crossroads, T-junctions, and Y-like turns. A split is a graph node, not overlapping independent rounded strokes.
- Planned cells cannot overlap, U-turn, hairpin, run alongside unrelated roads, enter buildings/decorations/keep clearance, or reconnect into existing roads unexpectedly.
- Collision recovery belongs in plan generation and whole-plan retry, not in reveal-time mutation.

### Visible frontier contract

- The currently revealed world owns visual truth.
- Any planned road portion crossing revealed terrain is permanent and solid.
- Concealed road geometry remains unpainted. Do not show translucent “ghost paths.”
- Road geometry stops at the revealed-terrain clip. World-border fog softens the cut.
- Never extrapolate a fake road, terminal ray, rounded nub, or decorative exit into mist.
- Every visible road mouth has exactly one expansion control.
- Expansion controls sit on the next concealed road cell, just past the revealed border. They do not sit on arbitrary grass, a remote section endpoint, or an invented extrapolation.
- A path touching fog without a control is invalid. A control without a matching visible path mouth is invalid.
- Selecting a section reveals terrain and commits the exact geometry already planned. No side road may suddenly appear on land that was visible before the click.

## 3. Repeated road-rendering failures

### On-the-fly generation

**Failure:** Reveals overwrote neighboring routes, created dead ends, parallel roads, U-turns, and branches that changed direction after selection.

**Cause:** Geometry was generated or repaired at click time using only local knowledge.

**Rule:** Precompute the seeded graph, validate it globally, and only reveal immutable sections.

### Artificial mist rays

**Failure:** Rounded beige nubs, gaps between road and mist road, roads extending past the world edge, and exits with no gameplay meaning.

**Cause:** `extrapolatedFrontierCell()`, terminal mouth projections, or similar fallback geometry painted a direction that was not an actual planned link.

**Rule:** Never render extrapolated roads. Add a real planned link through the first hidden cell and clip it to revealed terrain.

### Translucent ghost paths

**Failure:** Rounded silhouettes protruded through fog and looked like roads that might disappear. Multiple branches created dark overlapping bulbs.

**Cause:** Concealed plan geometry was painted beneath semi-transparent fog.

**Rule:** Hidden roads remain simulation-only. Fog does not need road silhouettes.

### Duplicate road renderers

**Failure:** Narrow spikes, doubled brown borders, bright overlaps, grass wedges, circular seams, and malformed crossroads.

**Cause:** `drawRoad()` painted visible active-choice links and `drawFrontierRoads()` painted them again with different caps/nodes.

**Rule:** Paint visible committed and selectable links in one graph pass. Do not call a second frontier renderer.

### Rendering all descendants

**Failure:** Deeper planned roads became visible without expansion controls, producing unexplained fog exits.

**Cause:** A visual workaround recursively painted descendants merely because terrain shoulder reveal exposed them.

**Rule:** Visible road mouths and actionable choices must remain one-to-one. Do not expose non-actionable descendant exits. Fix reveal radius/section geometry or activation semantics instead of painting inaccessible branches.

### Rounded section caps and filled frontier nodes

**Failure:** Road “nubs” appeared inside revealed land or at fog boundaries.

**Cause:** Independent section strokes used round caps, or a node at the discovered/hidden transition was filled as an interior junction.

**Rule:** Use butt caps for graph links, fill only genuine discovered interior nodes, and exclude frontier-transition nodes from node fills.

### Far or fallback marker anchors

**Failure:** Reveal controls appeared on unrelated grass, far beyond their road mouth, overlapped each other, or left exits unmarked.

**Cause:** Anchors used the last hidden section cell or an extrapolated cell when terrain shoulder reveal exposed a short section.

**Rule:** Anchor to the first concealed real road cell. If an entire section is already revealed, diagnose the reveal/section model; never invent a marker location.

### Graph validator blind spots

**Failure:** `roadValidation.valid` passed while screenshots still contained doubled strokes or controls without exits.

**Cause:** Structural validation covered cell topology but not renderer ownership or screen-space correspondence.

**Rule:** Add audits for visible mouths ↔ choices and inspect screenshots. Data validity and visual validity are separate gates.

## 4. Visual geometry and painter order

- Tile center is the ground contact for buildings and actors.
- Building artwork rises from that point; it never floats above or anchors to a tile corner.
- Weapons pivot at the roof center and remain attached throughout rotation/recoil.
- The keep is centered over its tile and the road reaches the center of a visible gate.
- The keep must resemble a proper castle and must not be faded by fog behind it.
- Use ground-contact Y for painter order. North-west objects pass behind; south-east objects pass in front.
- Shadows and range/glow effects cannot cross roads incorrectly. Building glow appears only on hover.
- Terrain should read as natural sloped land, while avoiding hidden-neighbor wedges, floating faces, hard artificial edges, and hill blocks over roads.
- Roads form one continuous filled graph with no caps at internal nodes, border doubling, seams, pinches, or grass wedges.
- All undiscovered area is misted; edge fog alone is insufficient.
- Fog is behind revealed objects and in front of hidden enemies.
- Run the visual-guide overlay for anchors, bounds, weapon pivots, muzzles, road plans, and mortar trajectories.

## 5. Combat, enemies, and projectiles

- Enemies spawn on the centerline of precomputed concealed roads, travel under mist, fade in behind it, and become targetable only after fully exiting.
- Enemy routes use preset road links exclusively. Never fall back to a direct polyline or straight-line shortcut over grass.
- Enemies reaching the keep remain at the gate and attack until killed; they do not vanish on contact.
- The keep displays health and supports a proper castle-loss sequence.
- Towers, enemy health, and wave pressure must require meaningful investment; effortless checkpoint arrival is a balance failure.
- Ballistas and weapons rotate toward targets in the isometric plane.
- Mortars use a visible ballistic arc from the rendered muzzle to impact. An elevated barrel firing a flat/downward line fails QA.
- Attack animation, projectile origin, projectile direction, recoil, hit effect, and damage timing must visually agree.
- Building-specific elemental relics need distinct mechanics, not near-identical percentage text:
  - radiance communicates burst/area behavior;
  - venom communicates damage over time;
  - lightning communicates chain count and falloff;
  - frost communicates area slow;
  - fire communicates burning behavior.
- Low-rarity bonuses must be modest and choices must explain why one differs from another.
- Only equal boost types may merge; applying an incompatible type replaces/invalidates the previous type according to the game rule.

## 6. Interaction and camera

- Building placement, hover, dragging, fusion, salvage, expansion controls, projectiles, and debug guides must all use camera-aware coordinates.
- Drag a building to move it; drop onto an equal compatible building to fuse.
- Dismantling refunds exactly 50% of actual Aether investment.
- Insufficient Aether shows a red shaking ghost building at the attempted tile plus a floating “need X more Aether” message.
- Tall sprites only own input on their lower body so decorative overhang does not steal neighboring terrain clicks.
- Expansion mode shows the pulsing expansion control only; do not draw a second selection tile beneath it.
- The first click on the visible control must select that exact branch, after camera movement and zoom.
- Edge scrolling works in all directions until the outermost revealed block can reach screen center.
- Mouse wheel zooms in/out around the pointer.
- Mandatory choices are automatically framed after waves.
- Placement rules must be visually inferable. Empty revealed grass is buildable unless occupied by visible road, scenery, building, castle silhouette, or a visible immediate frontier-clearance requirement.

## 7. Ambient world

- Ambient life is slow background theatre intended to remain interesting over hours, not a burst of simultaneous one-minute loops.
- At most four stories exist globally and at most two occupy one revealed block.
- Starts are randomized and staggered over minutes; events do not pop in/out together.
- Actors enter/exit through the keep gate or hidden world beyond mist. No visible teleporting.
- Actors pathfind around roads, towers, scenery, and terrain obstacles.
- Stationary actors stand, sit, eat, gesture, or work; they do not walk in place.
- Animals do not oscillate mechanically between two points.
- Markets are erected, traded at, packed, and dismantled.
- Hunters stalk/chase, may catch deer, and drag successful catches to the keep; failures continue naturally beyond mist.
- On gameplay input, citizens flee naturally to gates/mist before combat begins.
- Debug previews can select an ambient story but never count toward the 250-story completion achievement.
- Follow `docs/pathwarden-ambient-catalogue.md` for all families and scheduling.

## 8. Economy, progression, and monetization

- Use Polynux server-side transactional balance utilities and refresh client auth after mutations.
- Permanent upgrade prices scale steeply for high ranks and support starters, midgame accounts, and users with hundreds of billions of Coins/thousands of Gems.
- Fifty defense blueprints span ten tactical families and five tiers; purchased defenses need faithful visual previews and unique silhouettes, not three recolored templates.
- Cosmetic skins use Gems, alter building architecture meaningfully, preview accurately, and confer no gameplay benefit.
- Shop is a dedicated page and is linked beside Wiki/Rankings.
- Boost/relic inventory belongs in the HUD; building-specific boosts drag onto compatible towers.
- Generic boosts apply immediately.
- Checkpoint conversion rate increases with progress, rewarding saved Aether without making underspending safe.
- Rankings must use server-verified outcomes. Client-reported/debug Aether is capped and cannot mint real Coins.
- The 98% RTP requirement applies to the eventual money-making layer; gameplay must work and feel good first.

## 9. Verification discipline

- Use Bun exclusively.
- Run:
  - `bun --bun node_modules/.bin/nuxt typecheck`
  - focused `bun --bun node_modules/.bin/eslint ...`
- Use the development bridge rather than guessed canvas coordinates.
- Capture at original resolution and inspect, rather than trusting thumbnails.
- For road/fog changes:
  1. fresh state across at least four seeds;
  2. before/after every expansion;
  3. all simultaneous exits;
  4. several sequential expansions along one branch;
  5. crossroads and T-junctions;
  6. camera pans and zoom;
  7. visible mouth/control one-to-one audit;
  8. no doubled road pixels, caps, nubs, gaps, or roads beyond revealed border.
- For procedural changes, one successful seed proves nothing.
- For gameplay changes, play ten rounds with ordinary interactions, then adversarially attempt exploits.
- Do not report completion while the exact latest visual capture still contains an obvious artifact.
- Browser `ERR_ABORTED` noise caused by development teardown is not an engine failure, but record actual console/runtime errors separately.

## 10. Current files and unfinished work

Primary files:

- `app/utils/pathwarden-engine.ts`
- `app/components/games/PathwardenGame.client.vue`
- `app/pages/pathwarden/index.vue`
- `app/pages/pathwarden/shop.vue`
- `app/pages/pathwarden/wiki.vue`
- `shared/utils/gamelogic/pathwarden.ts`
- `server/utils/pathwarden.ts`
- `server/api/pathwarden/`
- `server/database/schema.ts`

Important development bridge actions include road laboratory controls, frontier claiming, visual guides, loadout construction, wave start, time scale, and ambient-story triggering. Discover current names through `window.__POLYNUX_DEV_BRIDGE__`.

The worktree is intentionally dirty and Pathwarden is largely untracked. Preserve it.

At skill creation, the latest edit removed the duplicate frontier and fake terminal render calls from `drawRoad()`, added one clipped link into each active choice’s first hidden cell, and excluded frontier nodes from fills. Typecheck passed; focused ESLint and a final multi-seed Playwright audit remained to run.
