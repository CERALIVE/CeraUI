<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A VERSION AN OPERATOR READS MUST BE A LIVE READ [EXISTS]

`modules/system/revisions.ts` feeds Settings → Versions. It gained two rows the
operator previously could not see — the board's running kernel and the cerastream
engine version — and one contract that is easy to break from either side.

- **`revisions.kernel` is `os.release()`** (`node:os`, kept per the Bun-native
  policy: fully supported, no Bun gain), i.e. the running `uname -r`. It is a
  boot-time read because a kernel cannot change without a reboot.
- **`revisions.cerastream` is NOT.** cerastream is systemd-owned (ADR-0005): it
  can be stopped, crash, or be apt-upgraded underneath a running backend, and
  CeraUI connects to it rather than owning it. A version observed once is
  therefore not something the device can still vouch for, so
  `refreshEngineRevision()` RE-READS it and an unreachable engine publishes
  `ENGINE_UNREACHABLE_REVISION` instead of retaining the last-known value. A
  cached-forever version would keep naming a build that may no longer be
  installed — the same latched-stale family as `policy_route_missing` and
  `active_encode`.
- **The read costs no new IPC.** `engine_version` has always ridden the `hello`
  handshake; it was simply never surfaced. The default probe is the SAME
  short-lived connect → `hello` → close that `checkEngineCompatibilityOnStartup`
  uses (`cerastreamBackend.probeEngine()`), so no connection is held open for a
  version string and the systemd-owned engine is never spawned or stopped. The
  import is lazy, mirroring `capabilities.ts`'s `setup.ts` import, so this
  module's load path does not pull the streaming graph.
- **`getRevisionsProcedure` is `async` and re-probes before answering.** The
  login-time `revisions` push is a snapshot: an engine that came up (or was
  upgraded) after the operator logged in would otherwise be reported unreachable
  for the rest of the session. The push and the pull are both kept — the push
  seeds the dialog instantly, the pull corrects it.
- `setEngineVersionProbe(probe | null)` is the test seam (the `set*Runner`
  convention). Coverage: `tests/revisions-kernel-engine.test.ts`.

Board-proven on a Rock 5B+ across a full engine stop/start with NO backend
restart: `2026.7.2` → `engine unreachable` → `2026.7.2`.

## …AND A BUILD-TIME VERSION IS NOT A COMMIT [EXISTS]

The row above is the LIVE-read one. `revisions.ceralive` is the opposite kind of
fact — a static build-time stamp — and it was published as the wrong fact
entirely: the `CeraUI` row read as a bare git short-SHA (`8738fd63`) beside four
rows showing real CalVer versions.

**The fallback chain was never broken, and that is the whole diagnosis.** On a
packaged device the PRIMARY read succeeds — `build-debian-package.sh` stamps
`/opt/ceralive/revision` precisely so `git rev-parse` is not the always-taken
path — so what was wrong is WHAT that file carries. The commit is build
metadata; it was occupying a slot an operator reads as a version.

**Two stamps now, and the second is a SIBLING rather than a repurposing.**
`revision` keeps its exact meaning and byte-identical content; the build script
additionally stamps `/opt/ceralive/version` with the CalVer read from the root
`package.json` (`get_ceraui_version`, `shared-build-functions.sh`). Widening the
`revision` file's content instead would silently change the meaning of a file
whose NAME says commit, and would leave a consumer unable to read either fact on
its own.

**A third stamp, `/opt/ceralive/build-id`, is not a version row.** It is the
`CERAUI_BUILD_ID` the packaged frontend bundle was built with (its
`__APP_VERSION__`): `ensure_build_id` derives it once per build from the
git-tracked frontend inputs, before any generation step, and both packages and
the system archive stamp it beside the bundle (the build fails when the bundle
does not carry it). `readBuildIdentity` reads it, else `CERAUI_BUILD_ID` from the
environment (dev, e2e), and the UI-build gate compares it with the build a page
names on its socket. Coverage: `scripts/build/build-identity.test.sh` for the
stamp each artifact installs, `tests/ui-build-wiring.test.ts` for
`readBuildIdentity` and every link from it to a refused call (the shipped
entrypoint, with a stamp, with only the environment and with neither, over real
sockets), `tests/ui-build-admission.test.ts` for what each refused call answers.

**`resolveCeraUiRevision` is the ladder, and its three rungs answer three
different questions:**

| Rung | Source | When it answers |
|---|---|---|
| 1 | the `version` stamp | a packaged device — the version of the build that is RUNNING |
| 2 | `dpkg-query -W -f='${Version}' ceralive-device` | a real device whose stamp is gone |
| 3 | none — the row falls back to the commit alone | a dev checkout, which genuinely has no packaged version |

- **The stamp OUTRANKS `dpkg`, deliberately.** The stamp names the build whose
  binary is executing; `dpkg` names what the package manager last recorded, and
  the two come apart during an upgrade or a `dev-sync` push.
- **The `dpkg` rung is `isRealDevice()`-gated.** A developer who once installed
  the `.deb` on their workstation would otherwise have their git checkout report
  that unrelated package's version as the running build — a plausible wrong
  answer, which is worse than the honest SHA.
- **Rung 3 is PRESERVED EXACTLY, not tolerated.** A dev checkout has no packaged
  version, so the bare `git rev-parse --short HEAD` value is the truthful answer
  there and its output is byte-identical to before this change. Nothing readable
  at all still yields the pre-existing `"unknown revision"`.
- **The commit is DEMOTED, never discarded.** `composeCeraUiRevision` emits
  `<version> (<commit>)` — the SAME shape `srtla_send -v` already emits — so the
  frontend's existing `splitVersionValue` promotes the version and demotes the
  commit to the row's secondary line with NO schema change, NO new wire field and
  NO row-specific branch in `VersionsDialog`. A `dpkg` version whose iteration
  already embeds the commit is left alone rather than repeating it.
- **`probe(argv)` is a separate primitive from `readRevision(cmd)`**, because the
  ladder must tell "this rung had no answer" from "this rung answered":
  `readRevision` answers the literal `"unknown revision"`, which is a fine value
  to RENDER and useless to RESOLVE with. It is registered separately in
  `SPAWN_POLICY` (`revisions.installedPackageVersion`, bounded-probe) so a hung
  `dpkg` lock is capped like every other probe.
- **`CeraUiRevisionSources` is the seam** (the `*Deps` convention, not
  `set*Runner`), passed as an optional argument to `initRevisions`, so the whole
  ladder is drivable with no packaged tree, no `dpkg` database and no git
  checkout — and `initRevisions()` with no argument is byte-unchanged for every
  existing caller.

Both stamps are read RELATIVE to the working directory, matching the original
`revision` read and `ceralive.service`'s `WorkingDirectory=/opt/ceralive`. Do NOT
absolutize them: a dev checkout having neither file is exactly what keeps rung 3
reachable.

Coverage: `tests/ceraui-version-revision.test.ts` (all three rungs against a real
staged temp tree, the empty-stamp fall-through, the no-duplication rule, the
gated `dpkg` reader, and the dev-checkout regression lock) +
`scripts/build/deb-version-stamp.test.sh` (wired into
`bun run test:release-package-contracts`: the version source is EXECUTED against
`package.json`, and both stamping lines are pinned).

## Boot version context [EXISTS]

`modules/system/version-context.ts` collects the existing revision snapshot,
validated booted OS stamp (falling back to the trimmed legacy image file), one
RAUC status document for `booted` and `compatible`, and the device-tree model.
Optional failed reads remain null. The engine's unreachable sentinel maps to
null. Mock mode uses the existing device-stats slot fixture and leaves optional
facts absent from the scenario null, without reading host hardware.

All new log consumers obtain journal-form boot IDs through
`modules/device-logs/boot-id.ts`: remove hyphens, lowercase, then require 32 hex
characters. The streaming marker's existing kernel-form reader is unchanged.
Missing boot identity fails collection rather than inventing a valid ID; the
non-critical boot guard reports that failure while startup continues.

`main.ts` starts the boot-record guard without awaiting it. Inside the guard,
revision initialization finishes before `logBootRecord()` emits exactly one
`logger.info("device started", { module: "boot", versions })`. The sender field
is `senderVersion`, because `sender` is reserved for redacted SMS content.
The published `VersionContext` schema and the existing revisions wire shape are
unchanged. Coverage: `tests/version-context.test.ts`.

Each collection refreshes the mutable engine and sender through the revisions
owner before reading its record. CeraUI, kernel and Bun remain facts about this
running process. `refreshSenderRevision()` uses the bounded asynchronous command
runner; unreadable or empty sender output becomes the existing unknown sentinel.
Mock collection skips both live probes. A boot record collects once and emits
one line; later exporters and bundles collect again to observe upgrades.

Boot identity, collection, logger and source-boundary coverage live in
`tests/version-context-boot.test.ts`, `tests/version-context.test.ts` and
`tests/version-context-sources.test.ts`. Source tests retain the real validated
OS reader and revisions owner and drive RAUC and sender executables through the
actual command runner; only their filesystem/executable locations are redirected
to private test fixtures.

