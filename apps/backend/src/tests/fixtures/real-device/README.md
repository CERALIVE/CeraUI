# Real-device parser receipts

External-command parsers MUST be tested against a real captured fixture through
the production function. Handwritten output is useful for negative cases, not
evidence of a tool's actual rendering. Keep missing rows, row order, null values,
whitespace and argv punctuation; do not add properties the command omitted.

Each capture has a board/OS/tool-version/date/normalisation header. Payloads are
selected complete command sections, delimited by `##### <name>`. Tests remove
only this envelope, never repair the command output. Raw captures stay outside
the checkout; fixture tests resolve only repo-local paths.

- `opi-d8-agent.txt`: the complete captured `agent.json` from Orange Pi D8,
  2026-10-02T00:33:44.122Z, DEV `e29eded3` on Debian 13. The 812 payload bytes
  are preserved exactly, including the absent `attemptId`; no identifiers need
  substitution in this selected section. Public release identity fields are
  retained. The capture's framing newline is excluded from the file payload.
  `os-unlaunched-d8-loader.test.ts` copies these bytes, without parsing or
  reserializing them, into the production loader/startup path. A matching
  candidate/current-boot witness cannot supply the missing historical attempt.

- `opi-systemd257.txt`: the actual guardian rejected by DEV `e29eded3`, plus
  live/absent LoadState and orphan output. All three transient-attempt UUID
  occurrences use `22222222-2222-4222-8222-222222222222`.
- `rock-systemd257.txt`: one read-only idle-board batch, 2026-10-02T02:05:30Z.
  Physical MACs and MAC-derived names use stable placeholders (twins remain
  equal); the public cellular gateway becomes TEST-NET `192.0.2.46`.
  LAN source/gateway/network/broadcast use `198.51.100.131` / `.1` / `.0` / `.255`;
  both twin LANs use `192.0.2.100` / `.1` / `.0`. Link-scope IPv4 uses
  `203.0.113.160` / `.255` / `.0`, retaining the captured `/16` prefix and
  `scope=link` label (a privacy substitution, not an operational subnet).
  IPv6 global/link-scope use `2001:db8:1::10` / `2001:db8:2::10`, keeping `/64`
  and scope labels. Both boot-ID occurrences use
  `11111111-1111-4111-8111-111111111111`. No SSID or credential was collected. Cmdline
  is base64 to preserve NUL separators. JSON is not reformatted.
  `routes-default` selects the four IPv4 default lines from the complete
  `ip route show table all` capture; it is an extraction, not a separate command.

- `rock-guardian-systemd257.txt`: isolated `uso-fixture-guard.service` lifecycle
  captured 2026-10-02T06:07Z with the exact product invocation shape, but isolated
  unit, description, helper and lock names. Fresh run tokens use
  `33333333-3333-4333-8333-333333333333` (killed) and
  `44444444-4444-4444-8444-444444444444` (released); InvocationID uses fixed
  `55555555555545558555555555555555` / `66666666666646668666666666666666`
  for the killed/released run, including the start stderr labels. Full show, product property subset,
  stderr and exit codes are separate sections. No hostname/machine-id/boot-id,
  MAC, LAN address, SSID or credential occurs in the selected output.
  The test explicitly aliases only those four isolated identity fields to the
  product constants before ownership/orphan parsing; it separately proves the
  unaliased unit is foreign. It never repairs lifecycle or exec grammar.
  `immediate` was already active with ready published, not captured starting.
  Contender exit 75, real flock fdinfo and lock-inode observations are retained
  as receipts. At the historical capture base there was no production strict
  lock-observation parser, and failed loaded units refused orphan settlement.
  H4/H6 have strict device-plus-inode lock and typed Job parsers. Acquisition
  still requires positive unit absence. An owned terminal UNLAUNCHED unit may
  settle through the full unlaunched proof; a LAUNCHED unit never gains that
  policy. Its acknowledged clean exit requires checked stop/reset, Job/kernel
  retirement and positive unit absence before its record is retired in H6.
  Normal exit renders `code=exited ; status=0`; that grammar is unchanged.
  Full show omits empty `User` and `DropInPaths`; the explicitly requested
  product property subset prints both. Orphan replay concatenates that subset
  and the independently captured LoadState reply, not invented empty fields.
  The prior product 90-second stop timeout is existing OPI recovery evidence;
  it was not repeated or collected from OPI by this fixture lane.

- `rock-readonly-systemd257.txt`: read-only batch at 2026-10-02T06:25Z.
  DNS service IPv4 answers use `.10` / `.11` in `198.51.100.0/24`, IPv6
  answers use `2001:db8::12` / `::13`. Eth0 link/global IPv4 and broadcasts
  use `198.51.100.14` / `.15` / `.16` / `.17`; link/global IPv6 use
  `2001:db8::19` / `::18`. These are identity substitutions, not operational
  broadcast or routing topology. MACs and derived names use the same stable
  `02:00:00:00:00:NN` scheme as the first Rock fixture; twins stay equal.
  Cloudflare request ID uses fixed zero hex and its NEL reporting token uses
  `fixture-report-token`. Prefix lengths, scopes, lifetimes, flags, metric
  fields, body/marker separation, header whitespace and status framing remain.
  No hostname/machine-id/boot-id/UUID/serial/SSID/credential was collected.
  `b2-rauc-cgroup` is the cgroup-v2 row `0::/system.slice/rauc.service`, not an
  address: the capture converter's IPv6 pass accepted `0::` (a valid IPv6
  literal) and emitted `2001:db8::20`, the 11th shared-counter substitution.
  The raw frames were not retained; the hash-preserved redacted receipt
  (`<REDACTED:ipv6>/system.slice/rauc.service`, sha256 `dede2700…4320`) plus
  cgroup(7) grammar (only hierarchy 0 has an empty, hex-only controller field)
  admit exactly `0::`. That row alone was restored; no other byte changed.
- `rock-nmcli-systemd257.txt`: supplementary read-only candidate inventory.
  MAC-derived names use its own per-file `enx020000000020` / `...21` map;
  only `eth0` is offered to the replay, so no cross-file identity is inferred.
  State/type/metering values and whitespace are real; no SSID was requested.

## New parser coverage and unverified branches

| Receipt section | Production parser / verified branch | Positive branch still unverified |
|---|---|---|
| `dns-images.ceralive.tv-{4,6}`, `dns-apt.ceralive.tv-{4,6}` | `selectUpdateTransport`: real host-prefixed resolvectl answer becomes family-correct `--resolve` argv | IPv6 transfers and authenticated APT transfer; uncaptured transfers deliberately fail in the harness |
| `curl-http`, `curl-head` | `selectUpdateTransport`: empty-body 204 marker plus TLS-verified HEAD 404 selects IPv4 OS path; real 149+285 ms rounds to 434 ms | Published signature 200, portal/error responses and sustained transfer |
| `b2-rules{4,6}` | `sweepUpdateRules`: no default/foreign rule deletion | Installed owned rules and their cleanup |
| `routes-100000-{4,6}`, `routes-100001-6` | `readPinnedTopology`: stdout `[]` with real exit 2 remains unknown, never positive route loss | Installed private-table default |
| `routes-100001-4`, `b2-links`, `b2-addresses`, `b2-carrier` | `readPinnedTopology` / `classifyPinnedTopology`: real mixed address JSON, existing/up eth0 and empty successful route table prove private-route loss | Healthy installed pin; global IPv6 address is not IPv6 Internet reachability |
| `b2-status`, `b2-operation`, `b2-rauc-service`, `b2-rauc-stat`, `b2-rauc-cgroup-procs`, `b2-blocks`, `b2-mountinfo` | `observeRaucStage`: idle instance `656:879`, target inactive, boot primary `rootfs.0`, no stage resources | Live install/NBD/dm/mount ownership, writer retirement and healthy boot verdict (healthy read intentionally unavailable in replay) |
| `b2-rauc-cgroup`, `b2-dm`, `b2-nbd` | `observeRaucStage` NBD attribution accepts the real `0::/<path>` row (test-constructed `nbd0` pid only); no aggregated-output parser for dm/nbd listings; real block list contains no NBD/dm nodes | NBD attribution, dm UUID/slaves and RAUC mount positive branches require live install |
| `b2-clients` | `osInstallClientsGone`: actual NUL-separated RAUC service argv is not an installer; captured comm-filtered inventory contains only RAUC | A present installer client and whole-proc race/failure handling |
| `b2-nmcli` | `selectUpdateTransport` / `discoverCandidates`: real Ethernet connected/unmetered candidate classification | Other device-kind qualification |
| `b2-version`, guardian `version` / `os`, guard fdinfo/locks/job | Historical capture-base supporting evidence; H4/H6 now replay it through exported strict lock ownership and typed zero-Job observation | New positive kernel-resource and nonzero-Job captures remain owed; parser implementation is not a hardware pass |

Rock had no active NBD/dm mapping or private update route. Its real empty private
table proves `private-route-lost`, not a healthy installed pin. Replaying its
main-table default through the same route parser proves the JSON grammar only.
The OPI `systemctl cat`/show proves the product's systemd-run argv created the
intended transient exec service; no new unit was started for these tests.
Live-stage resource ownership, restart completion and stage-success settlement
still require the hardware re-drill. Do not manufacture “real” positive fixtures
for those cases from an idle capture.

## Real product helper, second Rock capture [PARTIAL]

`rock-guardian2-systemd257.txt` records the capture-base packaged-source helper running
under isolated `uso-fixture-guard2.service`, captured 2026-10-02T10:49:23Z on
Debian 13 with shipped deb #5. Its test-directory/uid environment overrides were
capture-base behavior, not current production behavior. H6 removes them from the
shipped helper: production uses only `/run/ceralive/os-stage` and root ownership.
Hermetic tests generate a test-only copy differing in exactly those two constants,
with byte-parity and package contracts. H7 aliases only the historical environment
names to `FIXTURE_CAPTURE_DIR` / `FIXTURE_CAPTURE_UID`, retaining their values;
these inert capture labels are not read by any helper. All other output bytes stay intact;
no sleep, barrier or helper-like replacement was added to the original capture.
The header records every normalization: released/killed UUIDs become the existing
333/444 placeholders; their InvocationIDs become the existing 555/666 placeholders.
Cmdline base64 is decoded, token-substituted and re-encoded with NULs intact.
PIDs, fd identities, mount IDs, kernel rows, timestamps and whitespace are unchanged.
Hostname, machine-id, boot-id, MACs and LAN addresses are absent; if future captures
contain them, use `fixture-rock`, 111/222 UUIDs, `02:00:00:00:00:NN` and RFC5737
addresses respectively and document each map. Never insert those absent fields.

The complete combined observation request is captured directly, not assembled
from subset/full-show replies. Real flock/bash/sleep cmdlines, their individual
inherited fdinfo and fd stat receipts, complete `/proc/locks`, st_dev and mountinfo
cover the steady-state tree. ACK sample zero has a 0600 release file while the
unit remains live. Normal exit, loaded KILL failure and stop/reset absence are real.
The startup loop began before systemd-run with 5 ms sleeps, but show commands
already saw a live unit; **starting-before-ready remains unverified**. The separate
1 ms transient loop caught no `stat` child. Thirty-two isolated ext4 files failed
to match the tmpfs lock's inode; **different-device/same-inode remains unverified**.
Positive NBD/config, dm UUID/slaves, bundle mounts, installed priority-120 rules,
teardown errors and live RAUC Progress still require an authorized live install.
Private originals retain pre-normalization hashes; tests never read outside this repo.

## Singleton wrapper, Orange Pi H7 rehearsal [PARTIAL]

`opi-singleton-proc.txt` selects the actual backend singleton wrapper's cmdline
and lock fdinfo from H7 A3 `h7p2-opi-observe` / `live-manual`, captured
2026-10-02T18:40:30.823Z / .842Z. Board: Orange Pi 5+, Debian 13,
`7.2.0-ceralive-rk3588`; kernel `/proc` ABI, base64/cat capture commands.
The matching mountinfo row and backend lock-stat row are complete extractions,
not synthesized replies. Selected payload bytes are unchanged and contain none
of the forbidden private identifiers; no privacy substitutions were necessary.
The hexadecimal device `21` / decimal `33`, inode `7`, mount ID `39` and owner
PID `2202416` are retained as correlated kernel metadata, not device identities.

`backend-singleton-real-proc.test.ts` decodes the captured cmdline and drives
the production census through the real `singletonLockIdentity` reader. fdinfo
and mountinfo enter unchanged. The captured stat numbers are supplied through
the injected stat seam on a regular host file; executable dev/inode and uid
metadata are injected, not purported board captures (no exe stat was collected).
Synthetic negative controls alter the grant owner, waiter shape, file kind or
remove the grant explicitly. No whole-proc snapshot consistency, PID-reuse
protection or new on-board H11 qualification is claimed.

## Singleton credentials, Linux workstation [PARTIAL]

`linux-singleton-status.txt` selects the byte-exact Name/State/Uid/Gid rows
read from `/proc/self/status` on an Arch Linux workstation at 2026-10-03T00:51Z,
kernel `7.2.8-1-cachyos-bore`. Tabs and numeric values are unchanged; no hostname,
boot ID, credential secret or personal path is selected. The parser test removes
only the provenance envelope. This is kernel grammar evidence, not a board or
non-dumpable attack receipt. The Orange Pi replay's status credentials remain
explicitly injected, just like its executable metadata.
