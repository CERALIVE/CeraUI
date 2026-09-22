# Rock modem diagnosis fixtures [PARTIAL]

Real USB-hub observations from 2026-09-08, not synthetic support claims.
The eight modem directories identify physical ports; the Huawei `a` and `b`
suffixes distinguish two units, not different models. `imc-3572` is the
Bluetooth negative control, not a modem.

## Versions

- `installed`: `ceralive-device 2026.9.1-20260906T194131.f3c52d5`.
- `candidate`: the reviewed package `2026.9.1-20260907T172151.e19e34f6`.
- Both used ModemManager `1.24.2-2~ceralive.3`, companion `1.4.0`, and
  the same diagnostic CLI built from modem-stack commit
  `68b7acb664010ad95b55caf400acfc573c5e323b`. The CLI is not the installed
  CeraUI binding and its verdict must not be attributed to that binding.

## Files

- `*-capture.txt`: one port's actual off → five seconds → on transcript,
  disappearance proof, USB parent and descendant udev records, descriptors,
  fleet `mmcli -L` / `mmcli -m` / `-K`, target NetworkManager data, addresses,
  routes, and the actual `modem-control probe` output. Observation starts about
  forty seconds after power-on; initialization may still be in progress.
- `*-modems.json`: an actual received roster, with capture time and phase.
  This image nests it in `status.modems`; other status fields were excluded.
  It is a full roster, not a synthesized per-device payload. Installed-build
  roster capture is shared, after its port sweep; candidate capture is the
  last received roster in that device's phase. These times are not identical.
- `*-summary.json`: derived indices for the capture, not replacement wire types.
  Their JSON values match the original captured summaries; formatting is
  normalized. `mmObjectPaths: []` means no matching object **at that snapshot**,
  not that a known modem cannot be managed. `wireRowsMatchedByIdPath` is a
  convenience projection; the complete original roster remains alongside it.
- `*-mm-detail.txt`: a separately timed, USB-physdev-correlated MM observation
  from the fleet captures. The header names its source and time. This supplies
  detail for modems that had not re-enumerated in MM at the forty-second sample;
  it must not be passed off as that sample's result.

All subscriber identifiers, USB serial values, identifier-derived name suffixes,
credential values, and the board control-plane IP are replaced by explicit
redaction markers. Empty credential strings are also masked. Consequently these
are diagnostic fixtures, not guaranteed schema-valid mutation inputs. Do not
replace redaction markers with plausible subscriber numbers to make a test pass.

## Reference address classes (F2-R1)

These captures carry `192.168.*` literals from **three distinct, deliberate
classes** — none of them a board-identity leak. A future reader (or an identity
grep) should be able to tell them apart on sight:

- **HiLink vendor defaults (`192.168.8.0/24`)** — `192.168.8.100` /
  `192.168.8.1` / `192.168.8.0/24` are the client address, portal gateway and
  subnet Huawei's HiLink firmware hands out on every unit. The router-mode
  portal feature exists to recognise exactly this range; it is fixture data the
  code under test must match, not something a board leased on our own network.
- **Generic RFC1918 example (`192.168.0.0/24`)** — `192.168.0.169` /
  `192.168.0.1` / `192.168.0.0/24` come from the ZTE unit's composition capture
  and are an ordinary, unremarkable private-network example — the same class of
  literal you'd see in any router's factory documentation.
- **Bench LAN topology (`192.168.78.0/24`)** — `192.168.78.1` (gateway) and
  `192.168.78.0/24` (subnet), present in the `*-capture.txt` `ip addr`/`ip route`
  lines. This is the ONLY subnet that is actually ours (the lab bench network),
  and it is topology, not identity: the board's own `src` address on that
  subnet is already replaced with the literal `<redacted>` marker in every
  capture. A genuine leak on this subnet would be a numeric host octet other
  than `.0` (the network) or `.1` (the gateway) — e.g. `192.168.78.<host-octet>` — which
  does not appear anywhere in this directory.

The identity-check regex (`.omo/plans/media-stack-convergence.md` F2 procedure)
is scoped to catch exactly that third case and deliberately ignores the first
two, since neither can ever represent this bench's own identity.

## Observed limits

The installed roster wrongly contains the Bluetooth `13d3:3572` device; the
candidate roster excludes it. Both Huawei units and ZTE classify as router mode
without AT/diagnostic ports in this composition. The Qualcomm/HIMI device is
physically present as `05c6:9091`, with QMI, not as an active generic RNDIS
portal. Do not label that physical device absent or invent a router fixture.

No portal credential was submitted: the dialog persists it outside the permitted
secret directory before verification. No router setting was written. Portal
navigation and the post-password reason/log result remain unexercised. The
installed SimTech wrapper has a shell parse error **after** its complete capture
and `PROBE_EXIT=0`; this is harness evidence, not a modem failure.

## Portal credential regression fixture

`zte-mf79u/installed-summary.json` is additionally consumed by the portal
credential regression tests. The raw capture it derives from sits beside it as
`zte-mf79u/installed-capture.txt`; the summary is a derived index and does not
reconstruct that capture or the wider fleet diagnosis.

That capture establishes a reachable router row, a stable port key and a
`locked` state with no configured credential. Tests inject authentication
outcomes against the captured target. They do not claim a hardware-confirmed
ZTE login protocol, and no password outcome on this row was ever exercised on
the board (see Observed limits above).

Test-only password strings are authored in the tests and are not credentials
from a board. Subscriber identifiers stay redacted here, as everywhere else in
this directory.
