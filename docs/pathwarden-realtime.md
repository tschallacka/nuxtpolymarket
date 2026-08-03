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

## Packet contract

Gameplay packets use `shared/pathwarden/protocol.ts`. They are bounded binary packets, not JSON. Map compounds are split into 12 KiB chunks; all packets are capped at 64 KiB. Every input has a monotonically increasing sequence, and every authoritative snapshot acknowledges the latest applied sequence.

The server sends a full map and entity/world snapshot on connection. Subsequent world updates are emitted at tick boundaries: entity lifecycle changes use upsert/removal deltas, map changes use monotonic claimed-room/revealed-cell deltas, one-shot gameplay effects use stable-ID event packets (`impact`, `enemy-defeated`, `enemy-leak`, `wave-cleared`, and `ambient-story-completed`), and ordinary world snapshots omit repeated map arrays. A reconnect receives a fresh full snapshot and may resend only still-pending semantic commands. WebSocket ordering makes these deltas reliable within a session; reconnect always resets from the full snapshot and the renderer deduplicates replayed event IDs. A client more than 100 ticks behind requests a bounded reconnect resync.

## Recovery and rollback

1. If the WebSocket closes, the client reconnects to the same run ID and waits for the full snapshot.
2. If a newer session replaces an old session, the old world is stopped and its latest state is flushed before the replacement continues.
3. If persistence fails, the session remains authoritative in memory and retries through the serialized persistence chain; terminal settlement must wait for the forced flush.
4. In development, an authenticated operator can inspect bounded replay records at `/api/pathwarden/replay?runId=...`. Records contain semantic commands, ticks, acceptance, event IDs/types, and compact state hashes; `comparePathwardenReplay` reports bounded first divergences.
5. Runtime counters are available through the authenticated development endpoint `/api/pathwarden/metrics`.

To roll back a deployment, stop accepting new live sessions on the new server build and let existing sessions reach a terminal or persisted checkpoint. Do not re-enable the legacy HTTP save path while a WebSocket session owns a run; the `409` ownership guard exists to prevent split authority.

## Adding a gameplay feature

Add the feature in this order:

1. Add a semantic command or server-only system in `shared/pathwarden/protocol.ts` and `server/pathwarden/world.ts`.
2. Validate ownership, phase, IDs, bounds, resources, and offer revision in `canApply`; revalidate at the tick boundary.
3. Store gameplay values in server entity components or the world snapshot.
4. Add compact renderer data and a world/reconnect test.
5. Add a client input adapter that sends the command and a renderer adapter that consumes the authoritative result.
6. Keep particles, interpolation, audio, and layout local. Do not add a second outcome calculation to the browser.

The Pathwarden development bridge is intentionally scoped to Pathwarden visual QA. Other games must not import or register it.
