# @ceraui/srtla-send — Agent Knowledge Base

Parent: [`../../AGENTS.md`](../../AGENTS.md)

## OVERVIEW

The TypeScript helper layer for the `srtla_send` bonding sender: the CLI args
builder, the ADR-001 telemetry reader/watcher, and (pending a rewrite) the
control-socket client. `apps/backend` is its only consumer.

**PRIVATE, AND THAT IS THE POINT.** This used to be a public npm package. It is
now `"private": true` and consumed as `"@ceraui/srtla-send": "workspace:*"`.
Never publish it, never give it a registry pin, never add it back to
`producer-schema-drift.test.ts`'s `PRODUCER_PACKAGE_NAMES` (that list asserts
registry-resolved specifiers; `workspace:*` is precisely what it rejects). Its
telemetry schema stays in that test's drift MANIFEST — that half probes the
schema, not the pin.

The `srtla_send` BINARY is still external: it is built and released by the
sender repository as the `srtla` Debian package and installed at
`/usr/bin/srtla_send`. Only the helper layer lives here, so the binary's CLI and
telemetry contracts are still that repo's to define — read its
[AGENTS.md](https://github.com/CERALIVE/srtla-send-rs/blob/main/AGENTS.md) before touching a call site.

## STRUCTURE

```
src/
├── index.ts            # package root: re-exports sender/ + telemetry/ (NOT control/)
├── sender/index.ts     # argv builder, option schema, exec resolution, spawn/HUP helpers
├── telemetry/
│   ├── index.ts        # ADR-001/002/003 Zod schemas + readTelemetry
│   └── watch.ts        # watchTelemetry polling handle + its update/handle types
└── control/index.ts    # LEGACY dialect, TODO(41), excluded from the build
tests/
├── fixtures/*.json     # 8 Rust-producer documents, byte-frozen (see below)
└── telemetry-{reader,fixtures,roundtrip}.test.ts
```

## `--conn-timeout-ms 15000` IS UNCONDITIONAL

`buildSrtlaSendArgs` emits `--conn-timeout-ms 15000` on EVERY spawn, with no
option to suppress it. It is not a preference.

The sender is a hard fork of upstream `irlserver/srtla_send`, which ships
`CONN_TIMEOUT = 5` s. CeraLive needs 15 s — the interval the bonding receiver
holds a link open while it keeps echoing keepalives. At 5 s the sender gives up
on a link that is merely mid radio-stall, falsely re-registers, and resets its
congestion window. The fix is deliberately NOT a patched Rust constant (that
would be fork divergence to re-resolve on every upstream sync); the device value
is asserted on the command line instead, through upstream's own flag.

So: do not make it optional, do not let it default, and do not drop it in a
"simplify the args" pass. `buildSrtlaSendArgs_exact_vector_snapshot` (this
package) and the positional-contract test in
`apps/backend/src/tests/srtla-send-bindings-skew.test.ts` both pin it.

The four positionals still lead the vector in their frozen order —
`<listen_port> <srtla_host> <srtla_port> <ips_file>` — and the flag block starts
after them.

## UPSTREAM DEFAULTS ARE ACCEPTED; THE OPT-OUTS ARE PASSTHROUGH ONLY

Upstream ships re-home and stall-deselect ON. The binding does NOT re-assert a
default of its own: `noRehome` / `noStallDeselect` are optional and emit
`--no-rehome` / `--no-stall-deselect` only when explicitly set. Absent means
"whatever the sender ships", which keeps the fork's behaviour the source of
truth for the fleet rather than a number duplicated here.

## FIELD ORDER IS LOAD-BEARING, AND THE FIXTURES ARE FROZEN BYTES

`telemetry-roundtrip.test.ts` asserts
`JSON.stringify(telemetrySchema.parse(bytes)) === bytes` for the producer-ordered
fixtures. That works only because `connectionTelemetrySchema` and
`telemetrySchema` declare their keys in the Rust producer's own emission order.
Reordering either object literal breaks byte parity — that alarm is the point:
fix the order, never downgrade the assertion to `toEqual`.

The suite exists because a Zod object strips undeclared keys *silently and
successfully*. A reader that has never heard of `iface`/`link_id` parses a mapped
snapshot with no error and hands the consumer a document with both twin modems'
identities deleted. "Does it parse?" cannot see that; re-serializing and
comparing bytes can. The falsifiability control
(`a stripped identity field falsifies the byte-parity assertion`) deletes exactly
what a stripping parser would and REQUIRES the comparison to fail — without it,
byte parity would also pass for a reader that strips fields the producer never
emitted.

`tests/fixtures/*.json` are Rust-producer output, single-line and newline-free
(the ADR-001 atomic-publish shape). Biome would pretty-print them, which breaks
the byte comparison, so they are excluded twice over: `!tests/fixtures` in this
package's `biome.json` and `!packages/srtla-send/tests/fixtures` in the root
config. **Never run `biome check --write` over them**, and never regenerate
`telemetry-legacy-producer.json` — it is the frozen pre-ADR-003 document that
forms the old-shape half of the compatibility proof.

## `control/` SPEAKS THE HARD-FORKED SENDER'S DIALECT

`src/control/index.ts` is a JSON-RPC 2.0 client for `srtla_send`'s
`--control-socket`, written against the method table the binary actually
dispatches (`src/control.rs` → `const METHODS`, ten names, reproduced verbatim as
`SENDER_CONTROL_METHODS`). It is built, typechecked, tested, and re-exported from
`src/index.ts` like the other two surfaces.

Three things are load-bearing and were each verified live against
`srtla_send 4.1.0` rather than inferred:

- **Feature detection is `get_capabilities`, never `hello`.** `hello` and
  `subscribe-events` were the retired npm binding's dialect; neither exists on
  the hard-forked binary. The shipped `3.3.0` binary answers `get_capabilities`
  (underscore) with `-32601 Method not found` — it dispatches the HYPHENATED
  `get-capabilities` — so `getCapabilities()` turns `-32601` into `null` instead
  of rejecting. The caller runs this on the stream-start path, where a throw
  would turn a graceful downgrade into a failed stream.
- **Push is topic-based.** `subscribe {"topic":"stats"}` →
  `{"subscription_id":"sub-N"}`, then notifications arrive as
  `{"method":"stats.update","params":{"subscription_id","data"}}`. The topic's
  notification method is always `<topic>.update`
  (`src/subscriptions.rs::publish`).
- **`get_stats` is NOT the ADR-001 document.** Both `get_stats` and the `stats`
  topic carry the sender's `StatsSnapshot` (`src/stats.rs`): `conn_id` is a
  NUMBER, the rate field is `bitrate_bytes_per_sec` (bytes/s, no ×8), and
  `weight_percent` does not exist. `senderStatsToTelemetry` projects it into the
  file document's shape, mirroring the producer's own `conns_from_stats`
  (`src/telemetry_doc.rs`) field for field — including the
  `base_score × quality_multiplier` weight normalization and its equal-share
  fallback for a bond with no capacity signal yet.

The connection is a demultiplexer, not a single-slot line handler: a live
subscription holds the socket for the rest of its life, so responses are routed
by `id` and notifications by `method` concurrently.

The retired binding's `tests/control-client.test.ts` was deliberately NOT
absorbed — it pinned the dialect the hard fork removed. Its replacement is
`src/control/index.test.ts`, which drives the client against a scripted Unix
JSON-RPC server replaying the binary's captured frames.

## GATE

```bash
bun run --filter @ceraui/srtla-send test     # bun test
bun run --filter @ceraui/srtla-send check    # tsc --noEmit via scripts/tsc.mjs
bunx biome check packages/srtla-send         # lint/format (root config + this one)
```

Changing anything the backend imports additionally requires
`bun run --filter backend test` — `srtla-send-bindings-skew.test.ts` is the guard
that turns an export rename here into a loud failure there rather than a silent
one on a device.

## ANTI-PATTERNS

- Don't publish this package, and don't remove `"private": true`.
- Don't make `--conn-timeout-ms` optional or change `15000` without changing the
  receiver's `CONN_TIMEOUT` in lockstep.
- Don't reorder the telemetry schema keys.
- Don't format the fixtures.
- Don't build on `control/` before the rewrite lands.
- Don't redeclare a local type for a field this package already exports —
  a shadow type is what hides a stripped field from `tsc`.
