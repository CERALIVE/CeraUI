<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## BROADCAST EVENTS

### Per-uplink health (`uplinks`) [EXISTS]

`modules/network/uplink-health/` owns the client-steering health verdict. Its one
exported config object fixes the 5 s cadence, three-failure down threshold,
five-success recovery threshold, 15 s hold-down and three-probe concurrency cap.
While streaming, interfaces present in SRTLA telemetry receive zero active probes:
RTT/NAK/staleness can degrade them, while only definitive carrier/route/disconnect/
expiry evidence removes them from client steering. Captive interception is
`degraded/captive_portal`, never `down`; modem signal is not an input.

The engine publishes `uplinks` records and `gateways.ts` filters default-route
candidates through their steering eligibility. The engine never edits routes;
`gateways.ts` remains the sole `ip route del default` owner. Post-login hydration
replays the current records immediately.

### …AND AN UPLINK'S KIND COMES FROM THE DEVICE, NOT FROM ITS NAME [EXISTS]

`modules/network/uplink-identity.ts` (`resolveUplinkIdentity`) is the ONE thing
the health runtime asks what an interface IS, at all three `observe()` sites. It
replaced a private `kindFor()` that read the interface NAME, and the two answers
were board-proven to disagree with the `netif` projection sitting beside them.

**BOARD-PROVEN MISMATCH** (`ceralive2`, 2026-08-30). `eth1` is a Huawei E3372
LTE dongle (`cdc_ether`, `12d1:14dc`). The `netif` projection reads USB
descriptors and stamps it `router_cellular` correctly; the health engine matched
`/^(?:eth|en)/` and published `kind: "ethernet"`. Its IDENTICAL TWIN — same SKU,
same hub, one port apart — won the udev rename race, is called
`enx0c5b8f279a64`, matched the `enx` arm first, and published `cellular`. One
device class, typed two ways, decided entirely by a rename race.

- **The markers are consulted FIRST and are authoritative.**
  `getRouterCellularMarker` then `getModemNetMarker` — the SAME cache
  `applyRouterCellularProjection` / `applyModemNetProjection` stamp onto the
  `netif` wire, so the two surfaces cannot disagree about one device. There is
  no second classifier and no second sysfs read; this module only reads.
- **The name ladder BELOW them is a fallback, never a second opinion.** It
  covers what the USB sweep structurally cannot describe — a PCIe/MHI modem, a
  PPP link — and it still runs at boot, before the asynchronous marker sweep has
  landed. `enx*` is DELIBERATELY REMOVED from its cellular arm: it is systemd's
  predictable name for ANY USB network adapter, so reading it as cellular is
  precisely the coin-flip above. `ww*` / `ppp*` / `usb*` stay, because those
  describe a device class rather than guessing at one.
- **`displayName` is ADDITIVE-OPTIONAL and NEVER FABRICATED.** It composes
  through `routerCellularDisplayName` — the SAME rule that titles the device's
  modem row — so a device is called one thing across both surfaces. A device the
  classifier could not name carries NO name, and the row renders the raw `iface`
  byte-identically to before the field existed.
- **The dongle's own admin API is NOT consulted here.** This runs on the 5 s
  health cadence while the admin cache is filled on a 30 s poll, so a name that
  changed depending on which poll last landed would be worse than the descriptor
  answer that is always available.
- **Absence RETRACTS.** `#reduce` re-derives `displayName` from the observation
  every tick and omits it when absent, rather than preserving `current`. Keeping
  it would latch a resolved identity onto whatever re-enumerates under that
  interface next — the `policy_route_missing` latch, exactly.
- **`iface` remains the row identity.** Nothing keys, joins or correlates on the
  name; two units of one SKU legitimately share one.

Coverage: `tests/uplink-identity.test.ts` — the bench topology driven through the
REAL `refreshUsbNetMarkers` sweep (the eth-named dongle typing `cellular` and
naming itself, both twins agreeing, the MM-managed data function named after its
modem), the plain-Ethernet regression lock, the markers-absent fallback proving
the pre-existing ladder, the `enx`-never-guesses negative, and the record/wire
half (stamped, omitted, retracted, `iface` still the key). Frontend half:
`apps/frontend/AGENTS.md` → AN UPLINK ROW NAMES A DEVICE.

The backend pushes typed events to all connected clients via `rpc/events.ts`. Each event type carries a monotonic `seq` counter (`Map<string, number>`) that resets to 0 on server restart.

| Event type | Interval | Source |
|------------|----------|--------|
| `netif` | 5 s | `modules/network/network-interfaces.ts` |
| `sharing_diag` | 30 s, on-change + post-login snapshot | `modules/network/sharing-diag/` (real devices only — `isRealDevice()`-gated) |
| `sensors` | 1 s | `modules/system/sensors.ts` |
| `encoder-load` | 2 s | `modules/system/encoder-load.ts` (real devices only — `isRealDevice()`-gated) |
| `fan` | 5 s | `modules/system/fan.ts` (real devices only — `isRealDevice()`-gated) |
| `cpu` | boot + initial-state push | `modules/system/cpu.ts` (core count; NOT gated — every host has CPUs) |
| `gateways` | 2 s | `modules/network/gateways.ts` |
| `modems` | 30 s | `modules/modems/modem-update-loop.ts` |
| `status` | on-change + 5 s | streaming state transitions; carries `linkTelemetry`, `network_ingest`, and the typed `audio_sources` beside legacy `asrcs` |
| `config` | on-change | `setConfig` / `start` / `stop` |
| `wifi` | on-change | WiFi scan / connect / disconnect |
| `relays` | on-change | relay list mutations |
| `acodecs` | on-change | audio codec list changes |
| `pipelines` | on-change | pipeline list changes; each entry carries `requires_gateway` (rtmp/srt) + `audio_kind` (`selectable`/`embedded`/`none`) — **deprecation shim**, see "Device-First Source Model" below |
| `sources` | on-change + post-login snapshot | unified device-first source list (`modules/streaming/sources.ts`), folds pipelines+devices+device_modes into one `StreamSource[]` |
| `capabilities` | post-login snapshot | engine capability contract; carries `transports`, per-device `device_modes` (Tier-2 caps folded from `list-devices`, kbps-normalized bitrate — **deprecation shim**, see below), and `network_embedded_audio` |
| `notifications` | on-demand | user-facing toast events |
| `log` | on-demand | `system.getLog` / `system.getSyslog` — diagnostic journal for download |
| `ping` | 5 s | heartbeat emitter |

### Observable logs (`getLog` / `getSyslog`) [EXISTS]

`system.getLog` (device/application log, defaults to the `ceralive.service` unit)
and `system.getSyslog` (full boot journal) both invoke `modules/system/logs.ts`
`getLog(conn, service?)`, which `journalctl`s the journal, pushes it as a `log`
event the frontend `LogsDialog` turns into a file download, AND returns
`{ name, contents }` so the RPC is a real data source (NOT the former
`{ log: "" }` stub that fired no push). On a dev/CI host there is no systemd
journal, so under `shouldUseMocks()` `getLog` serves the in-memory log ring
buffer (`helpers/logger.ts` `getRecentLogLines`) — a bounded mirror of the same
backend records fed by a Winston `Stream` transport after `redact()` — so the
whole getLog → `log` push → download path is exercisable end-to-end without
hardware (`tests/observable-logs.test.ts`, e2e `logs-dialog.spec.ts`).

`notifications.getPersistent` returns the live persistent set via
`getPersistentNotifications(true)` (not an empty stub). The frontend
NotificationsPanel reads the live `notification` push cache; this RPC is the
pull-equivalent (same data) for any consumer asking for the snapshot directly —
keep it even though the panel does not call it.

### Post-login initial-state push

After a client authenticates, the backend immediately broadcasts a full snapshot of every event type. Clients don't need to wait for the first periodic tick to render.

For `device-stats`, `device-stats-snapshot.ts` retains the completed collector
payload before fan-out, and `rpc/adapter.ts` sends it to the newly authenticated
browser. Before sampling it sends nothing rather than fabricating values.
Replacement is whole-snapshot, never a merge of old optional readings. Coverage:
`tests/device-stats-initial-push.test.ts` and the browser
`device-health-initial-snapshot.spec.ts`; the latter excludes periodic rescue.

### Heartbeat emitter

`rpc/events.ts` emits `{ ping: { t: number } }` every 5 s to all connected clients. This lets the frontend detect half-open connections (no ping for ~15 s triggers a reconnect) without relying on TCP keepalive alone.

### Sensor coalescing

High-frequency sensor ticks (1 s) are coalesced before broadcast — only the latest value within a tick window is sent, preventing queue buildup under slow clients.

### Applied-state returns

All RPC setters return `{ success: boolean, applied: <fields> }`. The `applied` object reflects post-clamp, post-validation values actually written to config — not the raw client input. Clients must lock fields to `applied`, not to their intended value.

### Store-and-forward buffering (`status.buffering`)

`CerastreamBackend.handleEvent` (`cerastream-backend.ts`) reads the additive
store-and-forward fields off the cerastream `status` event (cerastream Task 32:
`buffering` / `spooled_bytes` / `data_headroom_bytes` / `disk_warning`) via the
pure `extractBufferingStatus()` and re-broadcasts them on the EXISTING `status`
event bus through `bridge.broadcastBuffering()` — it rides the engine event bus,
NOT the 5-signal `device-stats` channel (S1 lock untouched). `extractBufferingStatus`
returns `null` when the engine does not advertise `buffering` (the capability gate
the HUD honors), so an older engine surfaces no indicator. The wire shape lives in
`@ceraui/rpc/schemas` (`bufferingStatusSchema`, `buffering` on `statusResponseSchema`);
fields are read defensively so a partial frame never throws. Coverage:
`tests/buffering-status.test.ts`.

### srtla link telemetry (`status.linkTelemetry`)

`modules/streaming/link-telemetry.ts` folds `srtla_send`'s per-uplink telemetry
into the existing `status` flow as a `linkTelemetry` field — no new endpoint.
`startStream` passes `--stats-file` (`srtlaStatsFile()` → `/tmp/srtla-send-stats-9000.json`,
the binding's `senderTelemetryPath` convention) and starts the binding's
`watchTelemetry`; the watcher stops when `srtla_send` exits or the stream stops.
`broadcastLinkTelemetryIfChanged` is wired onto the 5 s heartbeat tick and emits
a `status` message only when the payload changes.

Shape (`null` when unavailable):

```ts
linkTelemetry: {
  links: Array<{
    conn_id: string;       // srtla tlm_id, stringified
    iface: string;         // human name from the backend-owned IP list
    rtt_ms: number;        // sender reports 0 (RTT is receiver-side)
    nak_count: number;
    weight_percent: number; // link's normalized share of total selection weight (0-100, active links sum to ~100; lone link = 100). Source: the srtla sender's src/telemetry_file.rs weight_share_percent
    bytes_sent_total?: number; // CUMULATIVE wire BYTES this uplink sent this session (srtla_send ADR-002). Absent = UNKNOWN.
    stale: boolean;
  }>;
  bytes_sent_total?: number;   // CUMULATIVE wire BYTES the whole bond sent this session. Absent = UNKNOWN.
} | null
```

**`bytes_sent_total` is BYTES and is NOT summed here.** It sits beside
`bitrate_bps` (bits/s, ×8) and carries no multiplication — a count, not a rate.
The bond-level value is **forwarded verbatim** from the sender's own session
accumulator: a link torn down by a SIGHUP IP-list reload leaves `connections[]`
while its bytes stay banked, so summing the live links would make an operator's
"total transferred" run **backwards**. It survives a per-link reconnect and a
backend restart that re-adopts a running stream (the sender owns the counter, not
CeraUI), and restarts at 0 only on a genuinely new stream — `srtla_send` is
spawned once per session, so process lifetime IS session lifetime. Full contract:
[ADR-002](https://github.com/CERALIVE/srtla-send-rs/blob/main/docs/adr/ADR-002-session-bytes-telemetry.md).

**It read `undefined` while the npm binding was pinned**, and that was
expected, not a bug: the pinned binding's Zod reader strips unknown keys, so
`asCumulativeBytes` (which reads the field defensively, like the audio join keys
in `sources.ts`) finds nothing. Absent means UNKNOWN, never zero — the same
convention `bitrate_bps` already uses. Coverage:
`tests/link-telemetry.test.ts` → "cumulative session bytes".

Three observable states: `srtla_send` not running (or no fresh snapshot yet) →
`null`; last read stale/absent while running → cached links flagged `stale: true`;
fresh read → values populated, `stale: false`.

**conn_id → iface mapping is backend-only.** `srtla_send` assigns each link a
stable numeric `tlm_id` in source-IP-file order on first appearance (monotonic,
reset on process restart). CeraUI WROTE that file, so it is the only component
that can map a `conn_id` back to an interface name. `registerSrtlaIpList`
(called from `setSrtlaIpList`) mirrors srtla's assignment exactly so SIGHUP
reloads stay correlated. Do not change `SRTLA_LISTEN_PORT` (9000) without
updating both the spawn site and the stats-file path.

See [`docs/RPC_COMMUNICATION.md`](../../../../docs/RPC_COMMUNICATION.md) for the full wire-protocol reference.

