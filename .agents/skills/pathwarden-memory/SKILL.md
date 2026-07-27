---
name: pathwarden-memory
description: Preserve and apply the accumulated Pathwarden game context, product requirements, road-generation/rendering invariants, visual QA standards, gameplay/economy decisions, and known failed approaches. Use whenever inspecting, debugging, extending, balancing, testing, documenting, or reviewing Pathwarden files, screenshots, canvas behavior, roads, fog, towers, enemies, ambient stories, progression, shop, boosts, checkpoints, cooldowns, or rankings.
---

# Pathwarden Memory

Continue Pathwarden as an existing game with strict visual and behavioral contracts. Do not redesign a subsystem from remembered intent alone.

## Load context before acting

Read these files completely:

1. `references/lessons.md` for current invariants, repeated failures, causes, and safe implementation patterns.
2. `../../../docs/pathwarden-handoff.md` for implementation history and validation state.
3. `../../../docs/pathwarden-visual-qa.md` before any canvas, road, fog, terrain, building, weapon, enemy, projectile, camera, or animation change.
4. `../../../docs/pathwarden-ambient-catalogue.md` before ambient-life changes.

Then inspect the live implementation relevant to the request. Treat documentation as memory, not proof that current code still complies.

## Core workflow

1. Reproduce the issue through the development bridge before editing.
2. Inspect serialized graph/state and capture an original-resolution screenshot.
3. Identify which single source of truth should own the behavior.
4. Remove competing renderers, fallback geometry, or duplicated state instead of masking their artifacts.
5. Add or strengthen a structural invariant when the defect can recur procedurally.
6. Run Nuxt typecheck and focused ESLint.
7. Reproduce the exact before/after transition with Playwright.
8. Inspect the complete canvas critically at original resolution.
9. Test several seeds for procedural changes and a full human-style run for gameplay changes.

Use the `playwright-game-debug` skill with this skill for visual or interaction work.

## Non-negotiable principles

- One concept has one authoritative representation. Road generation, committed links, visible road geometry, enemy routing, expansion controls, and fog mouths must agree.
- Never introduce decorative or extrapolated road geometry that is absent from the immutable plan.
- Every visible road mouth must correspond to exactly one actionable expansion choice. Every expansion control must sit on the next concealed cell of that road.
- Paint committed and currently selectable road segments as one graph. Never overlay a second frontier road renderer.
- Clip road geometry to revealed terrain. Fog softens the clipped border; concealed roads are simulation-only.
- Fill genuine interior graph junctions. Do not fill frontier-transition nodes or expose rounded section caps.
- A procedural validator passing is necessary but never substitutes for screenshot inspection.
- Preserve uncommitted user work. Never reset the dirty Pathwarden worktree.

## Current handoff

At the time this skill was created, `drawRoad()` was being consolidated into the sole visible road renderer:

- active choices add one link through their first concealed cell so clipping reaches the terrain boundary;
- frontier nodes are excluded from junction fills;
- road strokes are clipped to revealed terrain;
- calls to the duplicate `drawFrontierRoads()` and fake `drawTerminalRoadMist()` were removed.

Nuxt typecheck passed after this edit. Focused ESLint and the final Playwright visual audit were still pending because the user requested this memory skill mid-verification. Run them before considering the road issue complete.
