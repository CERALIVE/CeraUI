<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK [EXISTS]

`modules/wifi/wifi-adapter-lock.ts` owns the ONLY per-adapter lock-key
derivation in the codebase, and both layers import it: the oRPC procedures
(`runGuarded` in `rpc/procedures/wifi.procedure.ts`) and the hotspot
start/stop/reconfigure transactions (`wifi-hotspot-activation.ts`,
`wifi-hotspot-config.ts`).

**The two layers used to derive their own, and they disagreed.** The RPC layer
keyed on the adapter's registry MAC; `startHotspotForInterface` /
`stopHotspotForInterface` / `wifiHotspotConfig` /
`reconfigureHotspotForRegdomain` keyed on `wifiInterface.ifname`. Those are two
different strings for one radio, so `withDeviceLock` handed both callers the
lock simultaneously and the guard that exists to serialize an NM activation
against a station mutation serialized nothing. `wifiConnectNewProcedure`
compounded it by taking no lock at all — the one mutating procedure that skipped
`runGuarded` entirely.

- **The key is the PERMANENT hardware address**, i.e. the same value
  `wifiInterfacesByMacAddress` is keyed on (`resolveWifiPermanentMac`), so a lock
  key and a registry lookup can never name different adapters. An ifname cannot
  carry that guarantee: NetworkManager renames adapters (this fleet's
  duplicate-MAC dongles rename against each other on replug), and the AP+STA
  concurrent path activates the hotspot on a SECOND, virtual `clap-<parent>`
  interface belonging to the same radio — an ifname key there leaves the
  parent's station mutations unguarded for the whole activation.
- **It is the BARE normalized MAC, no prefix.** It shares the process-wide
  `withDeviceLock` registry, so prefixing would silently stop matching a key an
  existing caller already holds.
- **An unresolvable adapter runs UNGUARDED, deliberately.** `runGuarded` runs
  `op` when the device id / connection uuid names no known radio: there is no
  adapter to contend for, and refusing would be dishonest in the other
  direction.
- **The station procedures hold the lock across their DISPATCH, not across the
  nmcli work** — `handleWifi` fires connect/disconnect/forget/scan/new with
  `void`. The hotspot transactions DO hold it for their full NM activation,
  which is the ordering that matters: the destructive multi-step operation
  cannot be interleaved with a station mutation. Making the station legs
  awaitable under the lock is a separate change with its own RPC-latency
  consequences, and the `wifi.procedure.ts` header says so rather than claiming
  more than the code delivers.

Coverage: `tests/wifi-adapter-lock.test.ts` — the two layers' derivations
compared for string equality AND both CALL SITES proven to refuse under one
externally-held key, plus the `connectNew`-versus-hotspot-start race asserting
the refused op dispatched ZERO nmcli and the admitted one observed the first
op's terminal state. Rule-E proof captured in both directions: reverting the
activation key to `ifname` reddens the first test, and un-guarding
`wifiConnectNewProcedure` reddens the second.

### …AND A HOTSPOT TOGGLE NEVER CLAIMS MORE THAN NM HAS CONFIRMED [EXISTS]

`withDeviceLock` is **NOT re-entrant**, and sharing ONE key between the RPC layer
and the transactions is exactly what exposed that. The hotspot procedures
dispatched INSIDE `runGuarded`, so the outer lock was still held when the
transaction reached `withDeviceLock` — and a `void` does not help, because an
async body runs SYNCHRONOUSLY up to its first `await` and the busy check is
before any await. On a real device **every** hotspot start/stop/configure refused
ITSELF with `DEVICE_BUSY` while the procedure ignored the result and answered a
fabricated `{ success: true }`. Nothing caught it: no test asserted the
dispatched outcome.

| Procedure | Lock posture |
|---|---|
| station (connect/connectNew/disconnect/forget/scan) | UNCHANGED — `runGuarded` across dispatch only |
| `hotspotStart` / `hotspotStop` | NO `runGuarded`: an `adapterBusy()` admission PROBE (acquire+release), then AWAIT the transaction and return its typed outcome |
| `hotspotConfigure` | NO `runGuarded`: same probe, then a dispatch ack — awaiting it risks 2 × `HOTSPOT_UP_TO` (60 s) against a 30 s RPC timeout |

**The probe is required, not decorative: two id→MAC resolutions exist and they
disagree.** `getMacAddressForWifiInterface` reads `getWifiIdToMacAddress()`;
`wifiAdapterLockKeyForDeviceId` scans the registry by `.id`. A caller that
resolves a lock key but not a MAC would be answered `no-device` where
`DEVICE_BUSY` is owed.

**`modules/wifi/wifi-hotspot-outcome.ts` is the ONE builder of a
`wifi` → `hotspot.start` / `hotspot.stop` frame**, and it BROADCASTS: the path
that most needs a terminal (the bounded NM confirmation) settles from a monitor
event or a backoff poll with no requesting socket in hand. **Exactly ONE
publisher per exit path** — refusals from `wifiHotspotStart`, the already-active
short-circuit from `startHotspotLocked` (nothing was dispatched, so no
confirmation will ever settle), confirmed/never-confirmed from
`registerPendingConfirmation`, every stop outcome from `wifiHotspotStop`, and an
unexpected throw from the `.catch` arms in `handleWifi`. `wifiHotspotStart`
deliberately does NOT publish on success — that would resolve the operator's op
before NetworkManager has answered.

**A state broadcast is not a terminal outcome.** `giveUp()` already called
`broadcastState()`, which says "still a station"; it does not say the START
failed, so the keyed op could only expire on its TTL. Hence `not-confirmed`,
which is deliberately NOT `activation-failed` — NM accepted the activation and
never reported the AP up, which is a different thing to tell someone.

`accepted: true` on the reply means "a terminal frame follows", never "the access
point is up". Wire contract: `hotspotToggleErrorSchema` (six members, none
collapsible) + `hotspotToggleOutputSchema` in `@ceraui/rpc`.

The adapter-mode wrapper places a bounded terminal watchdog around that promise.
If the delegated publisher is lost entirely, the mode operation settles once as
typed `not-confirmed`; a late publisher is fenced and cannot emit a second mode
terminal. This does not change admission or re-enter the per-adapter lock.

**`runWifiNew`'s `ok:true, uuid:undefined` is AMBIGUOUS, not failed.** It emits
`{new:{error:"ambiguous"}}` and deliberately does NOT run
`wifiDeleteFailedConns()` — the failure path does, because a failure proves the
profile never activated, and this path proves nothing.

Both `publishOutcome` deps are OPTIONAL so the existing suites' exact dep objects
still typecheck; production wires them in the `default*Deps`. Coverage:
`tests/wifi-hotspot-terminal-outcomes.test.ts` (11 tests — every typed refusal,
both accepted-path settlements, both stop outcomes, the RPC caller's typed
reply, and the two station-join frames). Rule-E: all 11 fail on the pre-fix tree.

