<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PRESENCE IS POLLED, BECAUSE NOTHING IN PRODUCTION EMITS `modem-added` [EXISTS]

**Status polling observes; NetworkManager owns automatic activation.**
`refreshModemStatus` must not issue `nmcli conn up`. On Rock, a registered
RM530N-GL with a present SIM and a refused APN was retried by CeraUI every poll,
bypassing NM's `connection.autoconnect-retries=2` and accumulating over 500
throttled bearer attempts. The retired `GENERAL.STATE` check tested array length,
which also admitted `activating` and `activated`. Profile creation still enables
NM autoconnect with its bounded attempt batch; NM owns later retry scheduling.
Operator configuration and its reconnect scope are unchanged. No APN is guessed
or silently repaired, and no SIM-less device is blamed for this registered-modem
failure. Regression: `tests/modem-activation-ownership.test.ts`.

`handleMonitorEvent` (`modem-update-loop.ts`) switches on `modem-added` /
`modem-removed` / `device-state`. **The first two arms are unreachable on real
hardware.** The production emitter is `NmcliMonitorManager`, and its
`parseMonitorLine` can return nothing but `connection-state` and `device-state`
— `nmcli monitor` reports NetworkManager devices and connections and has no view
of the ModemManager modem lifecycle at all. Only the scripted
`MockMonitorEmitter` ever emits the modem arms, which is exactly why the whole
suite stayed green while the device did not.

So presence was established ONCE, by the boot `discoverModems()`, and the
retained 30 s poll deliberately "never re-lists / re-registers". A modem that
appeared after boot was therefore never registered — and registration is the
step that resolves, and where absent CREATES, its NetworkManager GSM profile
(`registerModem` → `getModemConfig` → `addConnectionForModem`). No registration,
no profile; no profile, nothing to activate.

**Board-measured on `ceralive2` (Rock 5B+, 2026-08-19).** ModemManager dropped
modems 3 and 5 at 23:58, created modem9 (Quectel RM530N-GL) at 23:59:52 and
modem10 (Fibocom FM350-GL) at 00:00:21. An hour later:

```
mmcli -L                    → modems 0, 6, 9, 10
ceralive journal (last 30m) → mmcli -K -m 3 , mmcli -K -m 5     ← and nothing else
                              zero lines naming modem 9 or 10
                              zero "Modem N removed" warnings
mmcli -m 10                 → state: registered, home, Movistar, packet service attached
nmcli connection show       → NO gsm profile whose gsm.device-id is the FM350's
ip -4 addr show enx000011121314 → (none)
```

The operator's report — *"it's registering to the network but apparently is not
able to connect, and it's got signal"* — was precisely this: a radio-attached
modem CeraUI had never heard of.

`runModemStatusPoll()` now runs the same `reconcileModemPresenceLocked()` as
discovery, so it re-lists every tick. Three properties are load-bearing:

- **An unreadable `mmcli -L` RETAINS every modem.** `mmListWithRetry()` answers
  `undefined` after exhausting its retries, and the old `?? []` read that as an
  empty roster. That was survivable while only boot called it; at 30 s it would
  evict the entire registry — and with it every modem's resolved profile — on one
  transient failure, then re-register everything on the next tick. `undefined` is
  a statement about the READ; `[]` is authoritative and really does remove.
- **ID_PATHs refresh on a presence EDGE only** (discovery excepted, being the
  boot seed). An ID_PATH names where a device is plugged in, so a quiet tick
  cannot move it.
- **A poll-discovered modem reconciles as a genuine `added`**, so the existing
  diff pipeline resets the cached gsm connections exactly as an event-driven add
  did. Nothing downstream needed to change.

Cost is ONE `mmcli -L` spawn per 30 s tick. Do NOT restore the
event-driven-only form without first giving the production monitor a real
modem-lifecycle source — and note the `mmcli` backend, still the supported
rollback value, has none at all.

**This fixes CeraUI's half only.** The FM350 that exposed it needs a second,
separate fix outside this repo: it enumerates in an RNDIS composition
(`option` + `rndis_host`, no MBIM/QMI port), so MM assigns `plugin: generic` and
its dial fails. With a correct profile hand-created, MM reached
`simple connect state (9/10): connect` and the bearer answered
`NotSupported: 0,NONE` on all three attempts — with the APN correctly
auto-resolved to `internet.movistar.com.co`. See the evidence note in
`.omo/notepads/modem-phase-c-quality/evidence/`.

Coverage: `tests/modem-presence-reconcile.test.ts` (the board's own 3/5 → 0/6/9/10
drift driven through the REAL poll, the FM350 registering, the retention rule,
the empty-roster control, the quiet-tick vs presence-edge ID_PATH split, and a
static lock proving `parseMonitorLine` cannot answer `modem-added` for any real
`nmcli monitor` line). Rule-E proof captured in both directions: restoring the
status-only poll reddens 4 tests; dropping the retention rule reddens 1.

