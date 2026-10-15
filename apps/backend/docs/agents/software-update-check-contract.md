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
- **A refused check restores what it did not replace.** `triggerManualUpdateCheck`
  save/restores `lastUpdateFailure`/`lastUpdateSucceeded` around dispatch, so a
  skipped check no longer wipes the failed-install state the operator was reading
  and then broadcasts nothing in its place.

Coverage: `tests/software-updates-check-visibility.test.ts` + the frontend half in
`apps/frontend/src/main/dialogs/UpdatesDialog.check.test.ts`.

Address-family and install-set rules are in `docs/DEVICE-UPDATES.md`.

### …AND DISCOVERY REPORTS WHAT IT CANNOT INSTALL [EXISTS]

Legacy classification is exact-name (`package-layer.ts`); capable-image
classification is origin-based (`apt-all-packages.ts`). See `docs/DEVICE-UPDATES.md`.

Simulated `Inst` rows accept one optional terminal ` []` or ` [name name]` broken-package annotation (single spaces, each name matching `APT_PACKAGE_NAME_RE`); these names are context only, never install authority, in discovery and the pinned recheck.

Capable APT refusals log `reason`, a closed substep, process `exit` when known,
and optional sanitized detail (500 UTF-16 units maximum) at the discovery or
pinned-install catch. Normalize the whole text (including CR/LF and Unicode line
separators) before detecting secrets. A secret-bearing record, URL or PEM marker
suppresses every remaining continuation; only independent benign prefixes survive.
Redaction precedes truncation. The internal SHA256 fingerprint uses the FULL
sanitized text, never raw secrets or the truncated display. The last reason/exit/
fingerprint signature per step is deduplicated for the process lifetime, including
across successful discovery; safe evidence changed beyond the display cap logs again.
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
