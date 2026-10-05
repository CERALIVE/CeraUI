<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SIGUSR2 UDEV HOTPLUG HOOK [EXISTS]

`main.ts`'s `process.on("SIGUSR2", udevDeviceUpdate)` re-scans Cam Link USB2 +
audio devices on an Elgato/USB-audio hot(un)plug. The signal is delivered by two
udev rules in `deployment/` (`98-ceralive-audio.rules`,
`99-ceralive-check-usb-devices.rules`) that MUST target the unit's main pid:

```
RUN+="/usr/bin/systemctl kill --kill-whom=main --signal=SIGUSR2 ceralive.service"
```

NOT `pkill -f ceralive` (the retired form). `pkill -f` substring-matched
avahi-daemon's process title `avahi-daemon: registering [ceralive.local]` (the
device hostname is `ceralive.local`) and killed mDNS on every hotplug.
`--kill-whom=main` scopes the signal to the tracked MAIN pid via the unit cgroup —
mirroring the old `pkill -o` single-process intent — so the whole-cgroup default
 (`all`) can never collaterally SIGUSR2-terminate `srtla_send` (which shares
`ceralive.service`'s cgroup while streaming and do NOT handle SIGUSR2). `systemctl
kill` from a udev `RUN+=` is safe: it creates no systemd job (returns after the
PID-1 D-Bus request), so the `--no-block` / deadlock caveats that apply to
`start`/`stop`/`restart` do not apply. Regression lock:
`src/tests/udev-rules-sigusr2-scope.test.ts` (static assertion on the shipped rule
files). Do NOT reintroduce a broad `pkill`, and do NOT drop `--kill-whom=main`.

## …AND A GUARDED SIGNAL IS RESERVED BEFORE THE BOOT LADDER RUNS [EXISTS]

`SIGUSR1` and `SIGUSR2` default to TERMINATE, so a process only survives one by
installing a handler FIRST — and `main.ts` installed both at the very END of a
top-level-`await` boot ladder, after config load, the WS bind, the engine probe
and the network/audio scans. Every second of that ladder was a window in which an
arriving SIGUSR1 killed `ceralive.service` outright.

The sender is `ceralive-addon-reconciler.service`, confirmed by a real boot trace
linking its systemctl PID's `Manager.KillUnit` call to PID 1's SIGUSR1 delivery
and the backend's death. With the former `Type=simple`, `After=ceralive.service`
released that oneshot at process creation, before JavaScript could reserve the
signal. The service now uses the readiness barrier described below.

**A SECOND, INDEPENDENT HAZARD sat in the same unit:** it omitted
`--kill-whom=main`, and systemctl's default is `all`. `srtla_send` shares
`ceralive.service`'s cgroup while streaming and does not handle SIGUSR1, so a
reconcile poke could terminate the sender mid-broadcast. That is byte-for-byte
the defect the two SIGUSR2 udev rules above were already fixed for; the unit now
carries the same scoping.

`helpers/boot-signals.ts` is the backend half. Five properties are load-bearing:

- **It RESERVES the signal, it does not handle it early.** The work cannot run
  early — `runAddonReconciler` and the audio/Cam Link rescan both read modules
  the ladder has not initialised — so the guard is deliberately inert: it RECORDS
  that the poke arrived and returns. `armBootSignalHandler` then installs the real
  handler AND replays a pending poke exactly once, so a signal received after
  reservation is neither fatal nor lost.
- **`installBootSignalGuards()` is the FIRST executable statement of the ladder**,
  before `runCritical("config", …)`, and a static test asserts that ORDER against
  the shipped `main.ts` — a behavioural test cannot see a reorder inside a
  top-level-`await` entry module (the `cellular-boot-order.test.ts` precedent).
- **It is idempotent and ALSO installs at module scope**, so a refactor that drops
  the explicit call degrades to "reserved a little later" rather than back to
  "fatal".
- **A storm replays ONCE** (a `Set`, not a queue), and the pending flag is cleared
  BEFORE the replay, so a handler that re-arms itself cannot loop.
- **`process.on("SIGUSR1"/"SIGUSR2", …)` is BANNED in `main.ts`** — a bare
  registration would shadow the guard's own listener and reopen the window for
  whichever signal it took over. `SIGTERM`/`SIGINT` are untouched: they are
  handled at the ladder's end by design and their default disposition is the
  correct behaviour in the meantime.

**READINESS COVERS THE ORDERED SENDER.** `deployment/ceralive.service` uses
`Type=notify`, `NotifyAccess=main`. After signal reservation and the critical
control-server bind, `main.ts` awaits `runCritical("systemd-ready",
notifyServiceReady)` before any optional initialization. The bounded argv-only
`/usr/bin/systemd-notify --ready --pid=parent` call uses the root service's main
PID identity and retains the manager-acknowledgement barrier (no `--no-block`).
An absent `NOTIFY_SOCKET` or a non-production environment does nothing; a failed
notification in the notify service fails startup visibly, never claims readiness.
The ordered add-on poke can arrive during the remaining ladder and is replayed
when its owner arms. Optional add-on/network/engine work does not gate readiness.

Native startup and import evaluation still precede any JavaScript handler.
UNORDERED callers, including the udev SIGUSR2 rules, are not protected in that
window. This change closes the proven add-on SIGUSR1 race, not every possible
signal race. Full contract: [`docs/BOOT-READINESS.md`](../../../../docs/BOOT-READINESS.md).

Coverage: `src/tests/sigusr1-boot-race.test.ts` — the pure guard (mid-ladder
survival + replay, storm bound, post-arm passthrough, signal independence, the
no-re-entry rule), the `main.ts` ordering lock, and the reconciler unit's
`--kill-whom=main` + leading-`-` + no-`pkill` assertions, plus the notify-unit and
readiness-call ordering. `src/tests/systemd-ready.test.ts` covers acknowledgement,
failure propagation and standalone execution.

**SIGUSR2 does NOT rebuild the unified `sources` list — video hotplug does.** The
handler only re-scans audio + Cam Link USB2 (a generic UVC capture dongle like a
RØDE is not even covered by the Elgato-scoped `99-ceralive-check-usb-devices.rules`).
The live video-hotplug → `sources` reactivity is owned by `modules/streaming/
devices.ts`: its `/dev` `fs.watch` + 2 s `VIDEO_HOTPLUG_POLL_INTERVAL_MS` poll
already detected the device-set change but previously only rebroadcast the legacy
`devices` event. It now also fires the injected `onDevicesChanged(observed)`
(default → `sources.ts` `refreshSourcesForHotplug()`) on a genuine device-SET
change — keyed on the device array alone, so a live `active_input` switch (same
set) never re-probes and the boot seed (already covered by `main.ts`) is skipped.
This is why unplug/replug updates the Live Sources list with no page refresh.
cerastream's own `GstDeviceMonitor` DOES watch add/remove but the production
engine wires it to a `NullSink`, so the engine emits no device-change IPC push
today — CeraUI's `/dev` watch is the live trigger.

**The rebuild prefers the engine probe but never LOSES a removal to it.**
`refreshSourcesForHotplug(observed)` first re-fetches the AUTHORITATIVE engine
`list-devices` (idle-safe short-lived probe) so the correct engine kind labels
(e.g. `mjpeg`) are preserved — the local v4l2 scan's display-name heuristic is
still not what feeds `sources` on the happy path. But that probe is a SECOND,
separately-fallible round-trip, and `tryRefreshEngineDeviceCache` deliberately
RETAINS the last-known cache when it throws (a transient outage must not erase
the device list). For a REMOVAL that retention is exactly wrong: it rebroadcasts
the device the operator just unplugged as still available until some later poll's
probe happens to answer — observed live on a board as a stale, still-selectable
source row that self-corrected only after ~a minute. So a FAILING probe now hands
over to `applyObservedDevicesAndBroadcast(observed)`, applying the list the
registry's own scan already proved current. The engine-fetch path itself is
unweakened — retain-on-failure is still its contract for every caller that has no
independent observation (`main.ts` boot seed, `engine-reconnect.ts` heal). Do NOT
"simplify" the hotplug path back to a bare `refreshAndBroadcastSources()`.

**On the hotplug path the OBSERVED set is authoritative for MEMBERSHIP; the probe
supplies METADATA only.** A probe that answers is not the same as a probe that is
right. Its `list-devices` reflects whatever the engine could enumerate at the
moment it was asked, and a just-replugged USB device the kernel has not finished
re-enumerating is truthfully ABSENT from a successful answer. Overwriting the
cache with that reply hid a device the registry's own scan had already proved
present — confirmed live: a RØDE HDMI-to-USB-C came back at the kernel level but
its row stayed `lost:true`, and because `lost` is never explicitly cleared (a live
row simply wins) and the registry only re-pokes on a device-SET *change*, the row
stayed stuck rather than self-correcting. This is the mirror of the probe-FAILURE
case above and needed its own fix: `mergeObservedWithProbe(observed, probed)`
(`sources.ts`) now takes video membership from `observed` and metadata from
`probed` — a probe entry matching an observed `input_id` wins outright (typed
kind, caps, `stable_id` all survive), a video device the probe never mentions
keeps its observed row instead of vanishing, and a video device the probe still
lists but the scan no longer sees is dropped. NON-video entries follow the probe
verbatim: the observed list's audio rows are in CeraUI's own `audio:<id>`
namespace, not the engine's, and `buildSources` overlays video only. The
`engineAudioDeviceCache` is still refreshed from the probe on this path — it is
the one cache the local scan cannot populate.

**A SIGNAL change is invisible to every hotplug detector, so it gets its own
tick.** All three triggers above — `fs.watch` on `/dev`, the 2 s poll's
device-SET comparison, and the boot/reconnect seeds — key on a device
APPEARING or DISAPPEARING. A capture device that stops or starts carrying a
usable picture does neither: same node, same `input_id`, same place in the set.
Confirmed live on a Rock 5B+ whose HDMI-RX answered `VIDIOC_QUERY_DV_TIMINGS`
with `ENOLINK` for the ~6 s its link spent retraining (`dmesg`:
`hdmirx_query_dv_timings port has no link!` ×3 → `hdmirx_phy_register_write
wait cr write done failed!` ×15 → `signal lock ok` → `New format:
1920x1080p59.94`). cerastream drops a signal-less receiver's degenerate range
caps entirely, so `fromEngineDevice` stamped `signal: 'absent'` from that
retraining answer — and 45 minutes later the engine's `list-devices` reported
`1920x1080 @ 60000/1001` while the UI still read "No signal", because nothing
had asked it again. While IDLE nothing can: `listDevicesIfActive()` returns
`null` with no live control session, so the registry's own poll is the local
v4l2 scan, whose output is byte-identical every tick forever.

`recheckSourceSignals(observed)` (`sources.ts`), fired by the registry's
`onSignalRecheck` on a `VIDEO_SIGNAL_RECHECK_INTERVAL_MS` (5 s) interval, is the
re-poke that closes it. It is device-agnostic BY CONSTRUCTION — no driver name,
no controller string, no HDMI special case anywhere in the path; it re-reads
whatever the engine's `VIDIOC_QUERY_DV_TIMINGS` result projected into `caps[]`,
so any device whose engine-reported caps change is picked up identically. It
reuses `refreshSourcesForHotplug`'s membership rule, metadata rule and
generation fence verbatim, with THREE deliberate divergences:

- **A probe that says nothing changes nothing.** A hotplug tick MUST fall back
  to `observed` (it holds a detected removal the retained cache would mask);
  this tick holds no detected transition at all, so falling back would
  republish the scan's coarse guess over the engine's last real answer for no
  reason. An unreachable engine simply leaves the last-known view standing.
- **It broadcasts only on change** (`broadcastSourcesIfChanged`), so `sources`
  keeps its documented on-change cadence instead of pushing an identical
  snapshot to every client every 5 s.
- **A tick that finds one already in flight YIELDS** (`signalRecheckInFlight`).
  This is the one caller that fires unconditionally on a fixed interval, so it
  is the one that can supersede ITSELF: a probe slower than the 5 s interval is
  fenced out by the very next tick, whose probe is fenced out by the one after
  it, and the loop publishes nothing for as long as the engine stays slow. An
  enumeration is exactly what gets slow when a receiver loses its link (the
  kernel re-runs `VIDIOC_QUERY_DV_TIMINGS` against a retraining PHY), so the
  direction this tick exists to report is the direction that starves it. Do NOT
  "simplify" this away by leaning on the generation fence — the fence orders
  DIFFERENT views, and two consecutive ticks of the same periodic loop are not
  that.

While STREAMING this tick is redundant-but-harmless: a live control session
makes `getEngineDevices()` engine-backed, so a signal change DOES alter the
device-SET serialization and the ordinary hotplug trigger already fires. Both
paths commit the same engine-authored rows, so they cannot disagree.
Coverage: `tests/hdmi-signal-recheck.test.ts`.

**Overlapping hotplug refreshes are ordered by a generation fence.** Each
`onDevicesChanged` starts its own probe, so an unplug and a replug moments apart
run two round-trips concurrently and the OLDER one can answer LAST — republishing
the world it asked about over the newer, correct view. `refreshSourcesForHotplug`
therefore takes a monotonic `hotplugRefreshGeneration` ticket before probing and
drops its result (no cache write, no broadcast, on BOTH the success and the
observed-fallback branch) if a newer refresh has since started. The counter is
deliberately NOT reset by `resetEngineDeviceCache()` — a superseded probe must
stay superseded. This is why the probe round-trip (`probeEngineDevices`) is split
from the cache write (`commitEngineDevices`): the fence has to be checked between
them. `tryRefreshEngineDeviceCache` is the unchanged probe+commit composition for
every caller that has no ordering concern.

**Staying PRESENT is not the same as staying ITSELF — an observed row falls back
to the engine's LAST ANSWER before it falls back to the scan's guess.** The
fallback is id-safe: `buildDeviceList()` keys the fallback scan `/dev/<card>`,
byte-identical to the engine's own `input_id` (verified on a real Rock 5B+:
cerastream reports `/dev/video0` + `/dev/video1`, and de-dupes the RØDE's two
nodes exactly as the scan does), so a fallback row can never split into a
duplicate or orphan a persisted `config.source`. What the scan CANNOT supply is
`kind`: `deriveKind()` guesses it from the card name, and for a UVC dongle named
`RØDE HDMI to USB-C: RØDE HDMI` the guess is `usb` — which bridges to NO
pipeline. This was previously written off as a bounded cosmetic degradation; it
is not. An unbridged row is DROPPED by `buildSources` (no capture row) and is
simultaneously live enough to suppress its own `lost` row, so its coarse slot
renders as **"USB MJPEG · not connected"** — a device that is physically present,
enumerated, and named, reported as absent under a generic label. And the same
"nothing re-pokes a stable device set" fact that made the #215 bug permanent
makes this one permanent too. Confirmed live and reproduced byte-for-byte from
the board's own `list-devices` + `/sys/class/video4linux/*/name` payloads.

`lastEngineVideoDevices` (`sources.ts`) is the fix: the last ENGINE-AUTHORED row
per `input_id`, recorded in `probeEngineDevices` and monotonic (a device leaving
the list must not erase what the engine said about it — the whole case is a
device that left and came back). A video device the probe omits, on BOTH the
merge path and the #214 probe-failure path, is restored from it.
It is **guarded by display name, not `input_id` alone**: the kernel recycles node
paths, and inheriting an identity is worse than showing a coarse one. Both lists
read the name from the same kernel string (byte-identical on the bug hardware),
so an equal name is real evidence of the same device and an unequal one leaves
the observation untouched. `resetEngineDeviceCache()` clears the map.

**What it restores is IDENTITY (`kind` + `stable_id`) — never the remembered
`caps` or `signal`.** Restoring the whole remembered row was the second half of
the latch above, in the other direction: a capture input that LOSES its signal
and drops out of `list-devices` had its last locked answer re-asserted on every
tick, so the payload never changed, `broadcastSourcesIfChanged` correctly stayed
silent, and an already-open UI kept rendering a live 1080p59.94 source for an
unplugged cable — indefinitely, because nothing else re-pokes a stable device
set. `kind`/`stable_id` are properties of the HARDWARE (and `kind` is the whole
point of the memory — a `usb` guess bridges to no pipeline); `caps` and the
`signal` projected from them are one probe's reading of what the cable was
carrying when it was asked. This is the same provenance rule `fromEngineDevice`
states: only the engine's own answer authors a verdict, so a row the engine did
not confirm THIS time carries no caps because nothing probed it — which reads
`unknown` (no badge, no modes), never a remembered `present`. Do NOT widen the
restore back to a whole-row `{...remembered}` copy.

**Staying ITSELF is not the same as keeping its NODE PATH, and the persisted id
must follow the hardware.** A replug WHILE STREAMING cannot reuse the old node —
the engine still holds it open — so the device returns on a new one. Confirmed on
a Rock 5B+: `config.source` stayed `/dev/video1` while the RØDE came back as
`/dev/video2`, and `last_seen_devices` carried BOTH ids under one `stableId`. Every
consumer matches that id LITERALLY against a `sources[]` row, so ONE stale string
stranded four operator surfaces at once (stuck lost-alert, raw `/dev/videoN`
labels, dead audio meter, vanished Switch card). Two fixes, both in `sources.ts`:

- **`liveStableIds` is recorded only AFTER the bridge check.** Todo 34 drops a
  remembered `lost` row when a live successor shares its stable identity — but "the
  successor owns the row" is false for a device whose kind bridges to no pipeline,
  because it renders NO row. Recording it earlier suppressed the `lost` row for a
  successor that never appeared, so the device vanished from the list entirely.
  Keeping the `lost` row is the honest floor.
- **`reconcileConfiguredSourceIdentity(sources)`** (called from `broadcastSources`)
  PERSISTS the migration: it runs the same `resolveSourceIdentity` rule PR #197
  already used read-only at the routing choke point, writes the successor to
  `config.source` (and to `selected_video_input` when that field still names the
  old id), `saveConfig()`s, and rebroadcasts `config`. `broadcastSources` rebuilds
  the payload after a migration because `config.source` feeds
  `collectLostCandidates`. Match is by STABLE IDENTITY only — a different device
  that merely took the freed slot is never adopted, and a true unplug (no
  successor) keeps its `lost` row untouched.

The retired id is ALSO published on the wire as `previousIds` on the successor's
capture row (`captureSourceSchema`, additive-optional), because the engine keeps
reporting the node it opened at start: without the alias every consumer holding the
old id resolves to nothing and reports a live device lost. Frontend half:
`apps/frontend/AGENTS.md` → "Re-enumeration is MOVED, not GONE".

The audio twin is `reconcileConfiguredAudioIdentity()` (`audio.ts`) — `config.asrc`
stores a kernel-assigned ALSA card key and the kernel recycles those identically.
It is backed by `rememberedAudioIdentities` (monotonic `asrc → stable_id`, the
mirror of `lastEngineVideoDevices`) and runs BEFORE the `reportActiveAudioSource`
lost verdict, because a card that only changed id is not lost and reporting it lost
raises a persistent alert nothing can clear.

The specific USB-as-HDMI mislabel this seam was originally warned about still
cannot recur (`deriveKind` tests usb/uvc BEFORE hdmi), and a device seen for the
FIRST time while cerastream is unreachable still has no memory to draw on — it
keeps the coarse fallback, which is the accepted degradation.
Coverage: `tests/source-identity-renumber.test.ts` + `tests/audio-identity-renumber.test.ts`.
Coverage: `tests/devices.test.ts` (`fires onDevicesChanged on a hotplug set
change…` + `hands onDevicesChanged the list this scan observed…`) and
`tests/lost-device-retention.test.ts` (`refreshSourcesForHotplug — a failing
engine probe never masks a removal` + `refreshSourcesForHotplug — a stale
successful probe never masks the observed set`, which covers the replug-vs-empty-
probe case, the removal-vs-pre-removal-probe case, metadata preference, the audio
cache, and both out-of-order fences).

