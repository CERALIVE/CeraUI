# Monitor-Subscription Spike — Findings (T8)

Validates the assumptions behind the future **event-driven network monitor**
(T12), which aims to replace today's all-polling architecture with a hybrid
event+poll model. Produced as a research spike; **no production monitor is
implemented here** (that is T12's job).

| Item | Verdict |
|------|---------|
| `Bun.spawn` streams stdout line-by-line | **PROVEN** — `src/tests/bun-spawn-stream.test.ts`, 3 pass |
| `Bun.spawn` detects exit promptly | **PROVEN** — exit observed < 500 ms after last line |
| `nmcli monitor` emits per-event lines | **CONFIRMED via docs** (binary absent on dev machine) |
| `nmcli monitor` survives NM restart | **CONFIRMED via docs** — reconnects, emits stopped/running notices |
| `mmcli --monitor-modems` exists | **CONFIRMED via docs** — `-M` flag present on all MM versions checked |
| `mmcli --monitor-modems` covers add/remove only | **CONFIRMED** — no per-modem status/signal stream |
| Event key | **device name (ifname)** — see decision below |

### Dev-machine environment (evidence gap disclosure)

```
which nmcli  → not found
which mmcli  → not found
bun --version → 1.3.14
bash          → /usr/bin/bash (stand-in for the monitor binary)
```

`nmcli` and `mmcli` are **not installed** on this dev machine. All nmcli/mmcli
claims below are sourced from the NetworkManager reference manual, the
ModemManager `mmcli` man pages (versions 1.14 → latest, incl. Debian), and
published real-world captures. The `Bun.spawn` streaming claim is proven
empirically with a `bash` stand-in process (deliverable 2) — it needs no
hardware. T12 must re-confirm the nmcli/mmcli line shapes on real target
hardware before relying on exact text.

---

## a. `nmcli monitor` behavior

`nmcli monitor` (the **global** monitor) "watches for changes in connectivity
state, devices or connection profiles" and "prints a line whenever … changes"
(NetworkManager reference manual). It runs in the foreground, blocks, and only
reports events that occur *after* it starts (no historical replay).

### Line format / fields

Human-readable, **no `--terse` mode, no stable separator**. Three line shapes:

| Shape | Example | Key field |
|-------|---------|-----------|
| Device state | `eth0: connected to "Wired connection 1"` | leading token before `: ` = **ifname** |
| Device state (bare) | `wlan0: disconnected` | ifname |
| Connection activity | `"Wired connection 1" (ethernet, 192.168.1.100/24): connection activated` | quoted connection name (NOT ifname) |
| Global NM state | `NetworkManager is now in the 'connected (global)' state` | none (global) |
| Connectivity | `Connectivity is now 'full'` | none (global) |

Device states observed (`nmcli device monitor` set): `connecting (<phase>)`,
`connected`, `disconnected`, `unavailable` (no carrier / cable unplugged),
`unmanaged`, `deactivating`. Full fixture: `src/tests/fixtures/network/nmcli-monitor-events.txt`.

Sample event lines (verbatim shape):

```
eth0: connecting (getting IP configuration)
eth0: connected to "Wired connection 1"
"Wired connection 1" (ethernet, 192.168.1.100/24): connection activated
wlan0: disconnected
wlan0: unavailable
Connectivity is now 'full'
NetworkManager is now in the 'connected (global)' state
```

**Parsing strategy for T12:** split on first `: `; if the left side does NOT
start with `"` and is not a known global prefix (`NetworkManager`,
`Connectivity`), treat it as an **ifname** event and re-query authoritative
state (the monitor is a *trigger*, not a data source — the human-readable text
carries no MAC, throughput, or signal numbers).

### Survives an NM restart?

**Yes.** The *global* `nmcli monitor` is tied to NetworkManager **availability**,
not to a specific device/connection. On `systemctl restart NetworkManager` it
does NOT exit; it reconnects over D-Bus and emits `NetworkManager is stopped` /
`NetworkManager is running` notices, then resumes streaming. (NM exposes the
`manager-running` / `manager-stopped` notice states for exactly this.)

> Contrast: `nmcli device monitor <if>` and `nmcli connection monitor <id>`
> **terminate** when their monitored devices/connections disappear. The spike
> therefore mandates the **global** `nmcli monitor` for T12, plus a supervisor
> that respawns the child if the process itself ever dies (defence in depth).

### What events it covers vs. what must stay polled

Covers (as triggers): device up/down/connecting/unavailable/unmanaged
transitions, connection activate/deactivate, global connectivity + NM state,
and **device add** (a new ifname appears mid-stream). Does **NOT** cover with
usable data: throughput/byte counters, IP duplicate detection, WiFi scan
result lists, per-modem signal/registration, and **device removal** is only
implicit (ifname stops appearing — must be reconciled against a poll/snapshot).
See the event-vs-poll split table in section **e**.

---

## b. `mmcli --monitor-modems` availability

**Available.** The `-M` / `--monitor-modems` flag is documented as "List
available modems and monitor modems added or removed" across **every**
ModemManager `mmcli` version checked: 1.14.0, 1.20.0, latest, and Debian
(bullseye) man pages. Safe to assume present on the Armbian/Debian target.

### Format it emits (JSON vs text)

**Text.** `--monitor-modems` is a continuous list-style action. The JSON (`-J`)
and key-value (`-K`) machine-output flags apply to one-shot *status* actions
(`--modem=X`), **not** to the monitor stream. So the monitor itself emits the
human-readable modem-list shape, e.g.:

```
/org/freedesktop/ModemManager1/Modem/0 [QUECTEL] EM05-G
```

…with lines added/removed as modems appear/disappear. Like nmcli, treat it as a
**trigger**: on any change, re-run the authoritative `mmcli -m <id> -K` query
(the existing `mmcli.ts` flat `-K` parse) to get the real fields.

### Whether it covers add/remove

**Add/remove: YES.** That is precisely and only what `--monitor-modems` does.
It does **NOT** stream per-modem state changes (signal quality, registration,
roaming, access-tech). Those must stay polled.

### If unavailable → polling-only fallback

Not needed (flag is present on target), but documented for completeness: if
`--monitor-modems` were missing or the child died, fall back to the **current
10 s `mmList()` poll** in `modem-update-loop.ts` — which already reconciles
add/remove by diffing the modem list each cycle. The event path is a *latency
optimization over* this existing poll, never a replacement for it.

---

## c. `Bun.spawn` streaming — PROVEN

Proven by deliverable 2, `src/tests/bun-spawn-stream.test.ts` (3 tests pass,
17 assertions, ~0.9 s, no hardware). A `bash` loop emits N lines with 100 ms
gaps then exits; the consumer iterates `proc.stdout` (a
`ReadableStream<Uint8Array>`, async-iterable in Bun) and splits on `\n`.

- **Streams line-by-line (not all-at-once at end)?** **YES.** Each line is
  timestamped on arrival; the spread between first and last line is > 150 ms
  (≈ the inter-line sleeps), and the first line arrives > 100 ms before process
  exit — impossible if output were buffered until exit. A second test asserts
  each successive line lands > 50 ms after the previous (monotonic streaming).
- **Exit detected promptly?** **YES.** `await proc.exited` resolves < 500 ms
  after the final line (asserted). Non-zero exit codes are surfaced correctly
  (`exit 3` → `exitCode === 3`).

**T12 pattern:** `Bun.spawn(["nmcli","monitor"], { stdout: "pipe" })`, iterate
`proc.stdout` with a `TextDecoder({ stream: true })` + newline buffer (carry the
partial tail between chunks — chunk boundaries do not align to lines). This is
the **long-lived spawn** counterpart to today's one-shot `execFileP` in
`helpers/exec.ts` (which buffers the whole output and resolves once — wrong tool
for a never-exiting monitor).

---

## d. Event keying decision — **device name (ifname)**, NOT MAC address

**Decision: key monitor events by device name (ifname, e.g. `wlan0` / `eth0` /
`ww0`).**

### Reasoning

1. **It is the only key the monitors emit.** `nmcli monitor` device lines carry
   the **ifname** as the leading token and **never** a MAC address. `mmcli
   --monitor-modems` keys by ModemManager **modem index/D-Bus path**, also not a
   MAC. Keying by MAC would force an extra authoritative lookup on every event
   just to resolve the key — defeating the latency win.
2. **The event is a trigger, not state.** The monitor line tells us *which
   interface changed*; T12 then re-queries authoritative state. ifname is the
   natural join key for that re-query (`ifconfig <name>`, `mmcli -m <id>`).
3. **Consistency with existing poll code.** `network-interfaces.ts` already
   keys `netif` by **name** (`netif[name]`), and `modem-update-loop.ts` keys by
   modem id/ifname. Matching the existing key avoids a translation layer.

### Caveat T12 must handle (why MAC still matters internally)

The **WiFi subsystem already keys by MAC address** —
`wifi-connections.ts` stores `wifiInterfacesByMacAddress` and resolves
device→MAC via `wifiDeviceListGetMacAddress(device)`. ifnames are **not stable**
across reboots/hotplug for USB adapters (a re-plugged `wlan1` may reappear as
`wlan2`). So:

- **Event transport / dispatch key: device name** (what the monitor gives us).
- **Internal WiFi identity / dedupe: MAC address** (existing, stable, unchanged).
- T12 bridges the two with the existing `wifiDeviceListGetMacAddress(ifname)`
  map. Do **not** rename or re-key the WiFi MAC store — events resolve *through*
  it, they don't replace it.

Net: events flow in keyed by **device name**; WiFi state stays keyed by **MAC**;
the device-name→MAC map already exists and is the join point.

---

## e. Event vs. poll split table

"Event" = surfaced by a monitor subscription (trigger → re-query authoritative
state). "Poll" = must remain on a timer because no event source exists or the
data is a continuously-varying scalar. The monitor is **additive**: every poll
loop below stays as a correctness backstop; events only cut latency.

| State change | Source | Mechanism | Today (poll) | T12 target |
|--------------|--------|-----------|--------------|------------|
| Netif up / down / carrier | nmcli monitor (`<if>: connected/disconnected/unavailable`) | **event** → re-read `ifconfig <if>` | 1 s `setInterval` (`network-interfaces.ts`) | event-triggered + slow safety poll |
| Netif **added** (new ifname) | nmcli monitor (new ifname appears) | **event** | 1 s poll | event-triggered |
| Netif **removed** | nmcli monitor (implicit — ifname stops) | **poll** (reconcile vs snapshot) | 1 s poll | keep poll (reconcile) |
| Netif throughput / TX bytes | — (scalar counter) | **poll** | 1 s poll | **keep 1 s poll** (no event source) |
| Duplicate-IPv4 detection | — (derived from full set) | **poll** | 1 s poll | keep poll |
| WiFi connect / disconnect | nmcli monitor (`wlan0: connected to "…"`) | **event** → `nmScanResults` refresh | 6-timer cascade (`wifi-connections.ts`) | event-triggered refresh |
| WiFi **scan result list** (SSIDs/signal) | — (scan is inherently async) | **poll** | 6-timer 1–20 s cascade | **keep cascade** (post-rescan settle) |
| WiFi adapter add/remove | nmcli monitor + ifconfig MAC list | **event** | via netif poll | event-triggered |
| Modem **added / removed** | `mmcli --monitor-modems` | **event** → `mmGetModem(id)` | 10 s `mmList()` poll | event-triggered |
| Modem signal / registration / roaming / access-tech | — (continuously varying) | **poll** | 10 s poll (`modem-update-loop.ts`) | **keep 10 s poll** (no event source) |
| Modem NM connection activate | nmcli monitor (`ww0: connected`) | **event** | 10 s poll side-effect | event-triggered |
| Global connectivity (`full`/`limited`/`none`) | nmcli monitor (`Connectivity is now '…'`) | **event** | (derived) | event-triggered |
| NM daemon up/down (restart) | nmcli monitor (`NetworkManager is stopped/running`) | **event** → resync all | not tracked | event-triggered resync |

**Rule of thumb for T12:** *discrete transitions* (link up/down, device
add/remove, connection activate, connectivity flip) → **event**; *continuous
scalars* (throughput, signal quality) and *list snapshots requiring settle
time* (WiFi scan results) → **poll**. Removals that lack an explicit line →
**poll-reconcile**. Every event path keeps its existing poll as a backstop.
