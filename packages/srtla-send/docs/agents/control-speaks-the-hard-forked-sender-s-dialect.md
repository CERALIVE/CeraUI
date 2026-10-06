<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

