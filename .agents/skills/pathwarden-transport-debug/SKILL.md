---
name: pathwarden-transport-debug
description: Trace Pathwarden websocket packets and server-authoritative commands with the development-only client/server ring logger. Use when debugging missing packets, rejected commands, placement failures, desyncs, protocol errors, or websocket lifecycle problems.
---

# Pathwarden Transport Debug

Use this skill only with a Nuxt development server. The logger, query API, global helpers, and bridge actions are disabled outside `import.meta.dev`.

## Start the Environment

1. Start the Nix development server with `./dev/run` from the repository root.
2. Open `/pathwarden` in the authenticated browser.
3. Wait for the Pathwarden development bridge:

```ts
await page.evaluate(async () => {
  await window.__POLYNUX_DEV_BRIDGE__?.waitFor()
})
```

4. Inspect the available actions:

```ts
await page.evaluate(() => window.__POLYNUX_DEV_BRIDGE__?.list())
```

## Logger Architecture

There are two independent in-memory logs:

- `client`: browser websocket lifecycle, sent/received packets, decoded packets, commands, acknowledgements, and client decode errors.
- `server`: websocket lifecycle, received/sent packets, decoded commands, command queue/rejection records, protocol errors, and tower entity upserts.

The logger instances are also available as development globals:

- Browser: `window.__POLYNUX_PATHWARDEN_DEBUG_LOG__`.
- Nitro server: `globalThis.__POLYNUX_PATHWARDEN_SERVER_DEBUG_LOG__`.

Use the combined helper or dev bridge for normal investigation because it queries both sides and keeps server access authenticated.

Each side retains the newest 10,000 records. Records are structured and include:

- `id`: side-local monotonic id such as `client-42` or `server-42`.
- `timestamp`: ISO timestamp.
- `timestampMs`: numeric timestamp for ordering.
- `side` and `event`.
- Packet metadata: `packetKind`, `packetKindCode`, `packetSequence`, `byteLength`, `tick`, and `acknowledgedInput`.
- Command metadata: `inputSequence`, `commandType`, `command`, and `reason` where applicable.
- Correlation metadata: `runId`, `entityId`, `col`, and `row` where applicable.

Raw packet bytes are never retained.

## JavaScript Commands

The page installs `window.__POLYNUX_PATHWARDEN_DEBUG__` in development. Use `page.evaluate` to call it:

```ts
const result = await page.evaluate(() =>
  window.__POLYNUX_PATHWARDEN_DEBUG__?.query({
    filter: '.event == "command.rejected"',
    select: '{id, timestamp, inputSequence, commandType, reason}',
    limit: 20
  })
)
```

Available methods:

- `query(options, side?)`: Query active records. `side` is `both`, `client`, or `server`; default is `both`.
- `scroll(options, side?)`: Query with `before` or `after` cursors to page through history without returning the full log.
- `save(name, options, side?)`: Save matching raw records under a name for later comparison.
- `listSaved(side?)`: List saved segment names, counts, timestamps, and first/last ids.
- `deleteSaved(name, side?)`: Delete a named saved segment.
- `clear()`: Clear active logs and clear server-side saved segments. Client local saved segments remain.

The existing bridge exposes the same operations as explicit actions:

- `queryTransportLog`
- `scrollTransportLog`
- `saveTransportLog`
- `listSavedTransportLogs`
- `deleteSavedTransportLog`
- `clearTransportLog`

Example bridge call:

```ts
await page.evaluate(() => window.__POLYNUX_DEV_BRIDGE__?.run('queryTransportLog', {
  filter: '.inputSequence == 7 and contains(.event; "command")',
  select: '{id, timestamp, side, event, inputSequence, reason}',
  limit: 50
}))
```

## Query Syntax

Filters are deliberately limited and safe. They are parsed, never evaluated as JavaScript.

Supported comparisons:

```text
.event == "packet.received"
.side != "client"
.packetSequence >= 20
```

Supported boolean operators:

```text
.side == "server" and .direction == "in"
.event == "command.rejected" or .event == "packet.decode_error"
```

Supported substring matching:

```text
contains(.reason; "mist")
contains(.event; "packet")
```

Projection examples:

```text
{id, timestamp, side, event, packetKind, inputSequence, reason}
.id
```

Always provide a `limit`; the implementation caps it at 500. Query results contain `total`, `returned`, `nextBefore`, and `nextAfter`.

## Trace a Placement Failure

Clear active records before reproducing, then perform one placement attempt:

```ts
await page.evaluate(() => window.__POLYNUX_PATHWARDEN_DEBUG__?.clear())
// Select a tower and click a visible buildable canvas cell here.
```

Query the complete placement lifecycle:

```ts
const trace = await page.evaluate(() =>
  window.__POLYNUX_PATHWARDEN_DEBUG__?.query({
    filter: 'contains(.event; "command") or .event == "packet.received" or .event == "entity.tower_upserted"',
    select: '{id, timestamp, side, event, packetKind, inputSequence, commandType, reason, entityId, col, row}',
    limit: 100
  })
)
```

Interpret the first divergence:

- Client `command.sent` exists but server `packet.received` is absent: the browser did not deliver the websocket packet, or the socket was not open.
- Server `packet.received` exists but `command.received` is absent: packet decoding or packet-kind handling failed.
- Server `command.rejected` exists: inspect `reason`; the command reached the server and failed authoritative validation.
- Server `command.queued` exists but no `entity.tower_upserted` follows: inspect the server tick and authoritative world application path.
- `entity.tower_upserted` exists but the client has no corresponding `packet.received` or entity update: inspect server output delivery and client packet reconciliation.
- Client `command.rejected` exists: the server returned a command rejection; correlate by `inputSequence`.

Use `nextBefore` from a result to scroll backward:

```ts
const earlier = await page.evaluate((before) =>
  window.__POLYNUX_PATHWARDEN_DEBUG__?.scroll({
    before,
    limit: 100,
    select: '{id, timestamp, side, event, packetKind, inputSequence, reason}'
  }), trace?.server.nextBefore)
```

## Save a Trace

Save before clearing or starting a comparison run. Saves contain raw structured records, not the current projection:

```ts
await page.evaluate(() => window.__POLYNUX_PATHWARDEN_DEBUG__?.save('placement-before', {
  filter: 'contains(.event; "command") or .event == "packet.received" or .event == "entity.tower_upserted"',
  limit: 500
}))
```

Client saved segments are persisted under local storage key `polynux:pathwarden:debug-saved:v1` and survive reloads. Server saved segments remain in the dev server process and are removed by `clearTransportLog` or server restart.

Query a saved segment later:

```ts
await page.evaluate(() => window.__POLYNUX_PATHWARDEN_DEBUG__?.query({
  saved: 'placement-before',
  filter: '.event == "command.rejected"',
  select: '{id, timestamp, inputSequence, reason}',
  limit: 50
}))
```

## Direct Server Query

The server log is available through the authenticated development endpoint:

```text
GET /api/pathwarden/debug-log
```

Query parameters mirror the JavaScript options: `filter`, `select`, `limit`, `before`, `after`, and `saved`. The endpoint also returns `savedSegments`. It requires an authenticated user and returns 404 outside development.

## Safety and Verification

- Never enable this logger in production.
- Never add secrets, cookies, auth headers, or raw packet payloads to records.
- Prefer projections and limits to avoid flooding the agent context.
- Save a focused segment before clearing active history.
- Check browser console errors and failed requests alongside the packet trace.
- Keep screenshots and traces outside the repository under `/tmp`.
