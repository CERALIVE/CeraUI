<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SOFTWARE-UPDATE CHECK CONTRACT [EXISTS]

Install post-acceptance limits: D8 Known gaps (c). Check wire reference:
`docs/DEVICE-UPDATES.md`.

- Keep `check_failed` distinct from an install failure: it says the device
  could not establish whether an update exists.
- **`checked_at` is load-bearing, not decoration.** Without it a successful check
  that finds nothing rebroadcasts a byte-identical state, so a working check and a
  dead button are indistinguishable.
- **Precedence** (`deriveUpdateState`): `check_failed` sits BELOW `available` — a
  proven-available update stays installable even when a later refresh could not
  confirm it — and ABOVE `idle`, because "we could not check" must never render as
  "up to date".
- Apt writes benign warnings on a healthy refresh; do not use those warnings
  as proof of a failed check.
- **A failed refresh is NOT cleared by a later successful discovery.** Only the
  START of a new cycle clears it. Otherwise `dist-upgrade --assume-no` parsing the
  STALE package lists reports "0 upgraded" and erases the very failure that made
  the answer untrustworthy — that is exactly how the device came to answer
  "System is up to date" when it had reached no repository at all.
- Publish the discovery outcome so its early returns do not leave a dead button.
- Orchestrator manual and scheduled package checks skip the package cycle when
  `apt_update_enabled:false`, without a failure notice or growing backoff. OS checks
  remain independently eligible. Enabled checks call `runSoftwareUpdateCheck()`:
  refresh starts a new failure lifetime, then discovery publishes the result. Calling
  discovery alone replayed a prior captive failure alongside a fresh healthy probe.
  Exit-zero warnings remain benign; a real failed refresh settles the port without
  running same-cycle stale-list discovery or publishing a new offer. An unexpected
  refresh exception logs and settles the callback as `discovery_failed`, releasing
  the refresh latch so Check answers and scheduled ticks can continue. Existing
  offers retain the documented wire precedence above; the failure survives in
  the port result and `lastCheckFailure`. A stream/concurrent-refresh refusal still
  returns `busy` without clearing evidence.
- **A refused check restores what it did not replace.** `triggerManualUpdateCheck`
  save/restores `lastUpdateFailure`/`lastUpdateSucceeded` around dispatch, so a
  skipped check no longer wipes the failed-install state the operator was reading
  and then broadcasts nothing in its place.

Coverage: `tests/software-updates-check-visibility.test.ts`,
`tests/update-transport-captive-recovery.test.ts` + the frontend half in
`apps/frontend/src/main/dialogs/UpdatesDialog.check.test.ts`.

Address-family and install-set rules are in `docs/DEVICE-UPDATES.md`.

### …AND DISCOVERY REPORTS WHAT IT CANNOT INSTALL [EXISTS]

Legacy classification is exact-name (`package-layer.ts`); capable-image
classification is origin-based (`apt-all-packages.ts`). See `docs/DEVICE-UPDATES.md`.
The unchanged global inventory/Release join lives in `apt-all-source-policy.ts`;
row structure lives in `apt-simulation-row.ts`, independently of eligibility.

Simulation row parsing follows [apt 3.0.3 `pkgSimulate`](https://github.com/Debian/apt/blob/45bebdfb891535d15e66e860aab1ee7c7b2ecaab/apt-pkg/algorithms.cc#L82-L269), shared by discovery and pinned recheck:

| Row | Description and suffixes | Installation authority |
| --- | --- | --- |
| `Inst NAME` | Optional ` [CURRENT]`, optional ` (CANDIDATE RELEASE [ARCH])`, zero or more ` [NAME:ARCH on NAME:ARCH]`, optional ShortBreaks | Exactly one valid candidate version is required for a pinned pair; duplicate names refuse. |
| `Conf NAME` | Optional candidate description, optional ShortBreaks | Context only; malformed rows and the separate `Conf NAME broken ...` branch refuse. |
| `Remv NAME` / `Purg NAME` | Optional current description and ShortBreaks | Always refuse the entire plan, before or after any install. |

ShortBreaks is ` []` or a single-space-separated package list with apt's final
space: ` [name:arch name:arch ]`. The historically accepted no-final-space form
remains tolerated. Every token still matches `APT_PACKAGE_NAME_RE`; nested,
unterminated, repeated or misplaced groups, invalid tokens and unknown action
verbs refuse. Reverse-dependency notes require architecture-qualified full names.
All annotation names are context only, never extra install candidates.
[RelStr](https://github.com/Debian/apt/blob/45bebdfb891535d15e66e860aab1ee7c7b2ecaab/apt-pkg/pkgcache.cc#L909-L960)
joins release displays with comma-space, can include spaces/punctuation in labels,
and can have an empty display. Release text is not provenance; unsafe control,
semicolon or ambiguous bracket-bearing displays retain refusal. An absent
candidate is structurally valid producer output but cannot authorize a pin.
The former negative assertion for ` [libcurl4t64 ]` was disproved by ShortBreaks
and the unchanged Orange Pi nginx capture; it is now positive coverage in both
paths, without deleting any genuinely malformed case.

Coverage: `tests/apt-all-real-capture.test.ts`, `tests/apt-all-row-grammar.test.ts`,
`tests/apt-all-inst-annotation.test.ts`. The separate legacy package-list reader
normalizes CRLF before recognizing headings; its informational/argv distinction
below is unchanged. Sweep coverage: `tests/apt-parser-sweep.test.ts` and
`tests/apt-dpkg-version-sweep.test.ts`. Dpkg revision output remains display-only,
not install authority; these are host parser proofs, not a new board install.

The row/prose boundary also accepts apt-get install's `Suggested packages:` and
`Recommended packages:` headings, additional/NEW package lists and simulation
banner. [ShowWeakDependencies / DoInstall](https://github.com/Debian/apt/blob/45bebdfb891535d15e66e860aab1ee7c7b2ecaab/apt-private/private-install.cc#L1169-L1299)
prints these for newly installed packages; they are not action rows and cannot
add installation authority. Known action verbs still require the exact row
grammar (including refusal of tab-separated `Inst`), and unknown row-shaped
verbs refuse. The source census includes debug literals and action tokens as
well as prose; its action tokens are explicitly negative coverage.
Coverage: `tests/apt-all-install-prose.test.ts` and `fixtures/apt/README.md`.

Discovery and detached pinned-argv validation share `compareAptPackageNames`:
strict ascending JavaScript code-unit order, never locale collation. This keeps
`+`, `-`, `.`, and architecture-qualified names launchable without allowing
duplicates or accepting a noncanonical unit argv. Coverage includes the three
reviewed library pairs and every ordered pair in a generated 20-name set in
`tests/apt-all-install-order.test.ts`. The shared APT command runner supplies
`LC_ALL=C`, `LANG=C` and an unset `LANGUAGE` to discovery, policy, holds and pinned
recheck children; `tests/apt-all-command-locale.test.ts` observes a real child's
environment at both simulation boundaries under an inherited non-English locale.

Capable APT refusals log `reason`, a closed `stage` (`source-policy`,
`package-policy`, `simulation` or `parse`), the more specific `step`, process
`exit` when known, and optional sanitized detail (300 UTF-16 units maximum) at the discovery or
pinned-install catch. Normalize the whole text (including CR/LF and Unicode line
separators) before detecting secrets. A secret-bearing record, URL or PEM marker
suppresses every remaining continuation; only independent benign prefixes survive.
Redaction precedes truncation. The internal SHA256 fingerprint uses the FULL
sanitized text, never raw secrets or the truncated display. The last reason/exit/
fingerprint signature per step is deduplicated for the process lifetime, including
across successful discovery; safe evidence changed beyond the display cap logs again.
Pinned parse refusals carry `step=pinned-recheck`, separate from discovery's
`parse-simulation`, so identical details at these boundaries cannot suppress each
other. An `apt-mark showhold` command failure has `step=held-packages` and
`stage=simulation`, not a parse failure. The 300-unit cut removes a dangling high
surrogate; production JSON coverage is in `tests/apt-all-journal-surrogate.test.ts`
and step/dedupe coverage in `tests/apt-all-refusal-steps.test.ts`.
URL/JWT recognition consumes disjoint maximal tokens rather than retrying their
suffix at every internal boundary. No input prefix cap hides late markers or safe
identity. Valid Unicode retains its UTF-8 SHA256; lone-surrogate text uses a 0xff
domain byte followed by its full UTF-16LE representation, avoiding UTF-8 replacement
collisions without hashing suppressed credentials.
This context is internal/log-only: refusal state, notification and install
admission are unchanged. Coverage: `tests/apt-all-diagnostics.test.ts` and
`tests/apt-all-diagnostic-text.test.ts`, `tests/apt-all-diagnostic-folding.test.ts`
and `tests/apt-all-diagnostic-dedupe.test.ts`, `tests/apt-all-diagnostic-linear.test.ts`;
host proof, not board qualification.

- Apt reports kept-back packages alongside real upgrades; retain both readings.
- **Kept-back membership WINS over the upgradable list.** apt can name a package
  in both, and the honest answer for such an entry is that it is not installable —
  so an `app`-layer package that was kept back is reported, and is NOT actionable.
- **`parseKeptBackPackageNames` DROPS a name that fails `APT_PACKAGE_NAME_RE`
  rather than throwing**, which is the deliberate opposite of its sibling
  `parseHeldBackPackages`. That one feeds an argv and stays fail-loud; this list
  is informational, so a malformed entry must cost one row, never the whole
  discovery cycle. Do not "unify" the two readers.
- Keep install argv and the Install control tied to actionability, rather than
  the inclusive discovered package count.
- Capability-read ambiguity is not an ordinary failed refresh retaining a usable
  offer: no install regime is known, so cached actionability is withdrawn. Only
  genuine absence or a valid declaration may select legacy. See UPDATE-RECOVERY.md.

Coverage: `tests/software-updates-apt.test.ts` — app-only, platform-only, mixed,
kept-back-only, the app-package-kept-back case, the COMPLETE ModemManager closure
(every member `app` and counted), the charset drop, and
`gstreamer1.0-rockchip-ceralive` in BOTH the upgradable and kept-back positions
proving it is informational, `actionable: false`, absent from the install argv and
`actionable_count: 0` when it is the sole entry. Rule-E proof in both directions:
dropping the layer gate reddens 4 tests, dropping the kept-back gate reddens 2.
