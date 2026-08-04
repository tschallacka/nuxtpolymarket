# Pathwarden realtime authority

Pathwarden live runs use one authoritative server world. The browser submits semantic input commands over the authenticated binary WebSocket and renders the server snapshots. Coins, gems, and permanent progression remain platform state; gameplay state belongs to the Pathwarden world.

## Ownership

| Concern | Owner | Client responsibility |
| --- | --- | --- |
| Map seed, rooms, roads, reveal, legal placement | `server/pathwarden/world.ts` | Draw the map and send semantic choices |
| Towers, enemies, projectiles, ambient actors, relic entities | server entity registry | Interpolate and render entity snapshots |
| Wave clock, movement, targeting, damage, effects, rewards | server fixed 50 ms tick | Predict presentation only; accept corrections |
| Choices and revisions | server choice revision and identity keys | Display server-supplied offer IDs and send the selected index plus revision |
| Relic binding and Arcanist rebinding | server validation, deterministic odds, and Aether debit | Send a compact command and render the resulting entity state |
| Persistence and reconnect | `server/pathwarden/session.ts` | Reconnect with pending input sequences |
| Canvas camera, hit testing, particles, audio, debug bridge | browser | Never modify authoritative outcomes |

Before a run is opened, the browser engine may prepare the seeded map and play
the intro presentation, but it is already marked server-authoritative. It can
change presentation-only selections, camera state, and effects; every gameplay
mutation is either sent as a WebSocket command or ignored until the server has
created the run. There is no offline gameplay fallback.

## Packet contract

Gameplay packets use `shared/pathwarden/protocol.ts`. They are bounded binary packets, not JSON. Map compounds are split into 12 KiB chunks; all packets are capped at 64 KiB. Every input has a monotonically increasing sequence, and every authoritative snapshot acknowledges the latest applied sequence.

The server sends a full map and entity/world snapshot on connection. The compact world snapshot includes keep capacity and aggregate global-relic identities/power so reconnects cannot regress the HUD or selected-building progression view. Subsequent world updates are emitted at tick boundaries: entity lifecycle changes use upsert/removal deltas, map changes use monotonic claimed-room/revealed-cell deltas, one-shot gameplay effects use stable-ID event packets (`impact`, `enemy-defeated`, `enemy-leak`, `wave-cleared`, and `ambient-story-completed`), and ordinary world snapshots omit repeated map arrays. A reconnect receives a fresh full snapshot and may resend only still-pending semantic commands. WebSocket ordering makes these deltas reliable within a session; reconnect always resets from the full snapshot and the renderer deduplicates replayed event IDs. A client more than 100 ticks behind requests a bounded reconnect resync.

## Recovery and rollback

1. If the WebSocket closes, the client reconnects to the same run ID and waits for the full snapshot.
2. If a newer session replaces an old session, the old world is stopped and its latest state is flushed before the replacement continues.
3. If persistence fails, the session remains authoritative in memory and retries through the serialized persistence chain; terminal settlement must wait for the forced flush.
4. In development, an authenticated operator can inspect bounded replay records at `/api/pathwarden/replay?runId=...`. Records contain semantic commands, ticks, acceptance, event IDs/types, and compact state hashes; `comparePathwardenReplay` reports bounded first divergences.
5. Runtime counters are available through the authenticated development endpoint `/api/pathwarden/metrics`.

To roll back a deployment, stop accepting new live sessions on the new server build and let existing sessions reach a terminal or persisted checkpoint. Run state is persisted by the authoritative server world; gameplay state is never accepted through a client HTTP save endpoint.

## Adding a gameplay feature

Add the feature in this order:

1. Add a semantic command or server-only system in `shared/pathwarden/protocol.ts` and `server/pathwarden/world.ts`.
2. Validate ownership, phase, IDs, bounds, resources, and offer revision in `canApply`; revalidate at the tick boundary.
3. Store gameplay values in server entity components or the world snapshot.
4. Add compact renderer data and a world/reconnect test.
5. Add a client input adapter that sends the command and a renderer adapter that consumes the authoritative result.
6. Keep particles, interpolation, audio, and layout local. Do not add a second outcome calculation to the browser.

The Pathwarden development bridge is intentionally scoped to Pathwarden visual QA. Other games must not import or register it.

The optional Battle simulator is not a client simulation: its authenticated
`POST /api/pathwarden/simulate` endpoint runs the bounded analysis on the
server, and the browser only renders the returned report. It never shares or
mutates a live run.

## Gameplay transition table

Every live gameplay mutation enters through the binary command stream. The
browser may predict only the presentation-safe phase change noted below; the
server validates the command again at the tick boundary and the next snapshot
is authoritative.

| Command | Server validation | Authoritative transition | Renderer result |
| --- | --- | --- | --- |
| `select-tower` | Known owned blueprint identifier | Changes the selected blueprint for the run | Updates placement preview metadata |
| `place-tower` | Planning phase, revealed non-road cell, empty cell, sufficient Aether | Debits Aether, increments purchase scaling, spawns tower entity | Renders the spawned tower; rejected placement leaves no tower |
| `upgrade-tower` | Existing tower, planning phase, level and Aether bounds | Debits cost and updates level/investment | Renders updated tower components |
| `fuse-tower` | Two existing same-type/same-level towers below cap | Removes source and raises target level/investment | Applies entity removal/update delta |
| `move-tower` | Existing tower and legal revealed destination | Updates tower coordinates | Renders the entity at its new cell |
| `salvage-tower` | Existing tower during planning | Removes tower and credits its server-calculated refund | Removes entity and reconciles Aether |
| `set-targeting` | Existing tower during planning | Stores the targeting mode | Renders the selected targeting mode |
| `start-wave` | Planning phase and remaining waves | Starts the fixed-tick wave and sets spawn schedule | Predicts only the phase label; server supplies enemies and timing |
| `pause` | Non-terminal phase | Changes the authoritative pause flag | Predicts the toggle until the server accepts/rejects it |
| `checkpoint-choice` | Current checkpoint offer and revision | Applies the selected checkpoint effect once | Renders the next server snapshot |
| `continue-checkpoint` | Checkpoint phase | Opens the next path/relic offer or completes victory | Renders the server-supplied offer/terminal state |
| `claim-path` | Current path offer, revision, and index | Claims the selected room and reveals its server map state | Applies map delta and next choice offer |
| `relic-choice` | Current relic offer, revision, and index | Materializes the catalogue definition and applies its effect | Renders inventory/global-relic entity state |
| `bind-relic` | Existing tower/relic in planning | Transfers the catalogue relic to the tower | Applies tower/relic entity deltas |
| `rebind-relic` | Existing tower/relic, valid Aether amount and focus | Resolves deterministic preservation and debits Aether | Renders recovered relics and updated tower |
| `sell-relic` | Existing relic outside wave/checkpoint | Credits the server sell value and removes the relic | Removes the relic and reconciles Aether |

Coins and gems cross the live-game boundary only through authenticated
Pathwarden economy endpoints for boosts, checkpoint settlement, abandon, and
cooldown actions. Gameplay commands never accept client-supplied currency,
score, reward, damage, route, timing, or modifier values; permanent
Pathwarden progression is stored in Pathwarden-owned records, while the
platform-shared economy contains only coins and gems.
