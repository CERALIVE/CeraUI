<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SOFTWARE-UPDATE CHECK CONTRACT [EXISTS]

The install path above never refuses in silence; the CHECK path now never
*answers* in silence either. A manual "Check for updates" used to change nothing
observable at all — confirmed live on a Rock 5B+, where the button produced no
spinner, no result and no error for 11 s while `debug.log` recorded
`System: manual software update check started` and `apt-get update: success`
1.8 s later. The check ran; only its result was unpublished.

- **A check has THREE outcomes, never zero.** `update_state` gains
  `check_failed` (typed `UpdateCheckFailureReason`: `refresh_failed` /
  `discovery_failed`) and a `checked_at` epoch-ms stamp on
  `idle`/`checking`/`available`/`check_failed`. `check_failed` is DISTINCT from
  `failed` — the latter is an install that ran and failed; the former means the
  device could not establish whether an update exists at all.
- **`checked_at` is load-bearing, not decoration.** Without it a successful check
  that finds nothing rebroadcasts a byte-identical state, so a working check and a
  dead button are indistinguishable. It is also the ONLY completion signal the
  frontend can latch on: `checking` sits below `available` in precedence, so a
  device that already knows about an update never publishes a `checking` frame.
- **Precedence** (`deriveUpdateState`): `check_failed` sits BELOW `available` — a
  proven-available update stays installable even when a later refresh could not
  confirm it — and ABOVE `idle`, because "we could not check" must never render as
  "up to date".
- **The operator-visible verdict keys on the apt EXIT CODE, never stderr.**
  `classifyAptUpdateResult`'s stderr rule is retained for the RETRY CADENCE only.
  apt writes benign warnings on a healthy refresh, and one unreachable repo among
  several still exits 0 (verified on the board) — escalating either would
  false-alarm and would break the documented "a noisy-but-nonfatal `apt-get
  update` must not suppress the broadcast" invariant.
- **A failed refresh is NOT cleared by a later successful discovery.** Only the
  START of a new cycle clears it. Otherwise `dist-upgrade --assume-no` parsing the
  STALE package lists reports "0 upgraded" and erases the very failure that made
  the answer untrustworthy — that is exactly how the device came to answer
  "System is up to date" when it had reached no repository at all.
- **`runUpdateDiscoveryAndReport()` is the ONE landing seam** for both the
  periodic loop and the manual re-check: it stamps `checked_at` BEFORE discovery
  (so discovery's own broadcast already carries it) and ALWAYS emits a terminal
  frame, because discovery has several early returns that broadcast nothing.
- **A refused check restores what it did not replace.** `triggerManualUpdateCheck`
  save/restores `lastUpdateFailure`/`lastUpdateSucceeded` around dispatch, so a
  skipped check no longer wipes the failed-install state the operator was reading
  and then broadcasts nothing in its place.

Coverage: `tests/software-updates-check-visibility.test.ts` + the frontend half in
`apps/frontend/src/main/dialogs/UpdatesDialog.check.test.ts`.

**Each check chooses an address family before apt runs.**
`apt-reachability.ts` probes every configured origin over both families; refresh
and discovery append exactly one `Acquire::ForceIPv4=true` or
`Acquire::ForceIPv6=true` option when only that family reaches every origin.
Neither-family and captive-portal verdicts stop before apt and publish
`check_failed` as `repos_unreachable` or `captive_portal`, with both family
results carried on the update state. Mock/dev execution never launches curl:
the default probe is `isRealDevice()`-gated, and `MOCK_SCENARIO` keeps its existing
software-update simulation path.

Detached installs take a fresh, uncached verdict and install only the sorted app
allowlist in `modules/system/package-layer.ts`. The transient-service builder
rejects `dist-upgrade`, platform/unknown packages, and unsorted package vectors;
service recovery remains tolerant of the historical `dist-upgrade` identity so
an update started by an older backend can still be reattached safely.

### …AND DISCOVERY REPORTS WHAT IT CANNOT INSTALL [EXISTS]

Discovery no longer answers with a bare package list. `buildDiscoveredPackages`
tags every name the `dist-upgrade --assume-no` cycle saw with its layer — from
`classifyPackageLayer`, the ONE exact-name allowlist in
`modules/system/package-layer.ts`, never a substring or prefix test — and with
whether apt kept it back. It derives `actionable` ONCE, as
`layer === "app" && !kept_back`, so the install argv, the wire count and the
operator's band cannot disagree.

- **The kept-back block is read on EVERY cycle**, from the original dist-upgrade
  stdout, not only when nothing could be upgraded. apt reports kept-back packages
  alongside real upgrades, and an operator must be told either way. The existing
  count-0 `apt-get install --assume-no` fallback is unchanged; in that branch the
  re-parsed summary describes an explicit install plan rather than an upgrade set,
  so nothing there is treated as upgradable and every entry is a kept-back one.
- **Kept-back membership WINS over the upgradable list.** apt can name a package
  in both, and the honest answer for such an entry is that it is not installable —
  so an `app`-layer package that was kept back is reported, and is NOT actionable.
- **`parseKeptBackPackageNames` DROPS a name that fails `APT_PACKAGE_NAME_RE`
  rather than throwing**, which is the deliberate opposite of its sibling
  `parseHeldBackPackages`. That one feeds an argv and stays fail-loud; this list
  is informational, so a malformed entry must cost one row, never the whole
  discovery cycle. Do not "unify" the two readers.
- **Platform and kept-back entries never reach an install argv.**
  `actionableAppNames` is what `buildAptUpgradeArgs` and `doSoftwareUpdate` read,
  and the existing `actionableAppPackages.length === 0` refusal is what makes a
  platform-only or kept-back-only discovery uninstallable by construction.
- **The wire carries both facts.** `update_state`'s `available` arm gains
  `packages` (each entry `{name, layer, kept_back?, actionable}`) and
  `actionable_count`. The count is emitted even when it is `0` — that is a real
  answer, and it is what a consumer gates the Install control on, never
  `package_count`. `packages` is OMITTED when nothing was classified, so a
  pre-classification frame keeps parsing.

Coverage: `tests/software-updates-apt.test.ts` — app-only, platform-only, mixed,
kept-back-only, the app-package-kept-back case, the COMPLETE ModemManager closure
(every member `app` and counted), the charset drop, and
`gstreamer1.0-rockchip-ceralive` in BOTH the upgradable and kept-back positions
proving it is informational, `actionable: false`, absent from the install argv and
`actionable_count: 0` when it is the sole entry. Rule-E proof in both directions:
dropping the layer gate reddens 4 tests, dropping the kept-back gate reddens 2.

