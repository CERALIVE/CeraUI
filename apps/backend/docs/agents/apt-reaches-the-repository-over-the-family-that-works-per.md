<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## APT REACHES THE REPOSITORY OVER THE FAMILY THAT WORKS, PER RUN [EXISTS]

A board can hold a complete IPv6 DNS answer and no IPv6 route at all. Both bench
boards do: the Orange Pi 5+ carries only default IPv6 routes it cannot use, so
`apt-get update` spent its whole budget on AAAA addresses and reported a failure
about a repository that was reachable the entire time over IPv4. The fix is a
verdict, taken fresh, spent on ONE run.

- **The verdict is per-origin and per-family, and it is derived, never guessed.**
  `parseAptSourceOrigins` reads the deb822 stanzas under `/etc/apt/sources.list.d`
  (the ONLY `/etc/apt` path this module touches), `buildProbeArgv` builds an
  argv-only `curl` probe per origin×family, and `classifyProbe` folds curl's exit
  code and status line into the wire enum `AptFamilyProbe`
  (`ok`/`blocked`/`no_route`/`dns_failed`/`captive`/`unknown`). A 4xx is `ok` — it
  proves the path, which is the question being asked. `deriveVerdict` then answers
  `any` / `force_ipv4` / `force_ipv6` / `unreachable` / `captive_portal`, and a
  family only wins by reaching **every** origin: successes split across origins
  complete no refresh, so that folds to `unreachable`, not to a family.
- **The choice is spent as a COMMAND-LINE OPTION and is NEVER persistent.** Refresh,
  discovery and the detached install append at most one
  `-o Acquire::ForceIPv4=true` / `-o Acquire::ForceIPv6=true` pair. Nothing here
  writes `/etc/apt/apt.conf`, `gai.conf`, a sysctl, `disable_ipv6`, or an interface
  binding — a device whose IPv6 comes back must not still be pinned to IPv4 by a
  file some earlier check wrote. `tests/apt-reachability.test.ts` carries a STATIC
  guard that scans the module's own source for every one of those literals, and the
  guard was proven falsifiable against a temporary copy outside the repo with a
  `writeFile` appended.
- **The argv allow-list had to ADMIT the option before it could be sent.**
  `validateDetachedAptServiceIdentity` tokenizes the transient unit's `ExecStart`
  and matches the exact flags-first prefix; it now admits zero or one pair from the
  CLOSED Force set and keeps the exact operation-tail checks. It is still exact
  matching — no substring test, no `arrayContaining` — because the predicate is what
  stops a foreign same-named unit being adopted as ours.
- **Neither-family and captive verdicts stop BEFORE apt.** They publish
  `check_failed` with `repos_unreachable` or `captive_portal`, and the block itself
  rides `update_state`'s `idle`/`checking`/`check_failed`/`available` arms. Both
  families are ALWAYS stated inside that block — a present-only-when-true family
  cannot be lowered by a merging consumer (the `policy_route_missing` latch,
  exactly), and an operator reading "no route on v6" is being told something the
  absence of a key cannot say.
- **The result is cached for `APT_REACHABILITY_TTL_MS` (60 s), and the install path
  deliberately opts out.** A manual check pressed twice must not re-probe every
  origin, but a transaction that is about to run for minutes takes a fresh verdict
  (`maxAgeMs: 0`) rather than a stale one about a link that may have moved.
- **Mock/dev execution never launches curl.** The default probe is
  `isRealDevice()`-gated and `MOCK_SCENARIO` keeps its existing simulation path.

The family probe now also supplies uncached device-bound HTTPS observations to
host election as a ranking input. A repository outage does not erase the ordinary
connectivity fallback or change shared-client health. Apt still consumes a separate
fresh UNBOUND verdict after awaited route repair; a bound success cannot stand in
for that reading. See `docs/HOST-UPLINK-ELECTION.md` from the repo root.

Board evidence: the Orange Pi 5+ drill observed the real `apt-get` argv from
`/proc` carrying `-o Acquire::ForceIPv4=true` on BOTH the refresh and the discovery
leg, and the matching frame reported `{ipv4: ok, ipv6: no_route, used: ipv4}`. The
Rock 5B+ leg of that drill was DEFERRED on board reachability and is not claimed.

Coverage: `tests/apt-reachability.test.ts` (the deb822 parse against the board's
captured `sources.list.d`, the complete `classifyProbe` matrix from captured curl
transcripts, the `deriveVerdict` fold including the split-origin cases, and the
static persistence guard) + `tests/software-updates-apt.test.ts` (the exact argv
pins, the detached-identity admission, and the unreachable short-circuit that
spawns no apt at all).

### …AND THE TRANSACTION IS ADMITTED AGAINST REAL FREE SPACE [EXISTS]

An apt transaction that runs out of disk mid-`dpkg` is the worst failure this path
has, because it lands on the ACTIVE slot with no rollback. The update continuation
therefore refuses in advance rather than discovering it late.

- **The order is pre-clean → admission → stamp → launch → post-clean, and each step
  is where it is for a reason.** `apt-cache-clean.ts` calls `spawnWithTimeout`
  directly with exactly `['/usr/bin/apt-get','clean']` (30 s bound, spawn-policy id
  `softwareUpdates.aptCacheClean`, no transient unit): reclaiming first is what
  makes the measurement honest, because admitting against space a stale archive is
  holding would refuse a transaction that fits. Admission then builds ONE
  `--print-uris` transcript from the SAME install argv the transaction will run,
  under child-local `LC_ALL=C`. Post-clean is best-effort and lives in the SHARED
  completion monitor, so a transaction that was RECOVERED after a backend restart
  is cleaned too.
- **The planned-shutdown marker moved to the last possible moment.**
  `startSoftwareUpdate()` stays synchronous and stamps nothing; the stamp is written
  only after pre-clean and admission have both succeeded, immediately before the
  detached launch. A refusal that had already stamped it would suppress stream
  restoration for an update that never ran.
- **Both volumes are parsed before either is compared.** The archive path comes from
  `apt-config`, device identity from `stat(..., {bigint: true}).dev`, and available
  bytes from `statfs(..., {bigint: true})`. Same-device requires download + net
  growth + reserve; split-device requires download + reserve on the archive volume
  AND net growth + reserve on root. The earlier short-circuit form hid a root
  overflow behind an archive shortage, which is why both requirements are
  range-parsed first — a `value_out_of_range` and an `insufficient_space` are
  different operator facts.
- **`APT_SPACE_RESERVE_BYTES` (268435456) is engineering margin, not a guarantee.**
  apt reports NET installed growth; it says nothing about the transient
  unpack/backup peak inside dpkg. The reserve reduces ENOSPC risk and does not
  eliminate it, and no RAUC rollback is claimed for a package transaction mutating
  the active slot. Do not document it as one.
- **A refusal is TERMINAL and typed.** `update_preflight_failed` carries
  `preflight_reason`, one of the eleven `UPDATE_PREFLIGHT_REASONS` literals
  (`insufficient_space`, `apt_config_failed`, `archive_path_invalid`, `probe_failed`,
  `probe_no_uri_rows`, `probe_uri_size_malformed`, `probe_delta_malformed`,
  `stat_failed`, `statfs_failed`, `value_out_of_range`, `pre_clean_failed`). Every
  one of them clears the `updating` latch ATOMICALLY, in ONE frame carrying both
  `updating: null` and the terminal state — a refusal that cleared the latch in a
  separate frame is how a dialog comes to sit on "Applying…" forever. Success alone
  may carry `cleanup_warning: 'post_clean_failed'`; a failed post-clean never
  overwrites the transaction's own verdict. All eleven reasons and the warning have
  operator copy in all ten locales — this is not a backend-only enum.

Coverage: `tests/software-updates-apt.test.ts` and the update-lifecycle suites —
the eleven refusal publications, the marker preserved byte-for-byte on each, the
three stamp-before-launch controls that stop the marker proof going vacuous, the
recovered-transaction post-clean, and the split-volume overflow case. The clean
helper itself was exercised against synthetic archive bytes in a network-disabled
Trixie container; no board cache was touched and no package was installed.

### …AND THE PACKAGE MUST NOT DISABLE THE DEVICE IT IS UPGRADING [EXISTS]

dpkg runs the OLD `prerm` before unpacking the new package. The shipped `prerm`
stopped AND disabled `ceralive.service` on every invocation, so a self-update
disabled the control plane and `Restart=always` — inert after an explicit stop —
never brought it back. The device came up with no UI.

- **`prerm` gates on `$1`.** Only `remove` stops and disables (including the legacy
  `ceralive.socket` line); `upgrade`/`deconfigure`/`failed-upgrade` do nothing. Every
  pre-existing line is preserved verbatim inside that case.
- **`postinst` enables UNCONDITIONALLY, with `systemctl enable … || true`.** This is
  the todo-36 board finding and it is the opposite of the intuitive fix:
  `deb-systemd-helper enable` succeeds and DOES NOT recreate a missing enablement
  link once its own installation state exists, so on the second upgrade of a device
  the old `prerm`'s `disable` won, the helper's `enable` was a silent no-op, and
  `deb-systemd-invoke` then refused to start a disabled unit. Both helper binaries
  were present — this was NOT the missing-helper variant the plan predicted, so do
  not "restore" the conditional on the grounds that the helper exists.
- Board evidence: Rock 5B+, real `.deb` self-upgrade with the original package
  reinstalled afterwards. The failing arm reproduced disabled+inactive; the fixed
  arm repaired it to enabled+active, the repeat install showed no `prerm` stop, and
  the browser reached the new build. The device was restored to its original
  package, binary hash, and service state.
- **The upgrade's own status push is locked too.** The initial authenticated status
  frame carries BOTH `updating` and `update_state` — including an explicit
  `updating: null` — and the recovery `onAttached` path broadcasts the same pair, so
  a client that connects mid-transaction or just after one hydrates the real answer
  instead of an empty slot it will never be told about. That is a characterization
  lock, not a behaviour change: `tests/software-updates-initial-push.test.ts` pins
  the three surfaces and no second apt transaction is started by any of them.

Coverage: `scripts/build/deb-maintainer-scripts.test.sh` (invoked from
`scripts/build/release-package-contracts.sh`), including the retained-helper
regression that reproduces the silent no-op, and
`tests/software-updates-initial-push.test.ts`.

