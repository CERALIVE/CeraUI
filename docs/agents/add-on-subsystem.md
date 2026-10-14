<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ADD-ON SUBSYSTEM [EXISTS]

The add-on subsystem lets CeraUI install, enable, and disable optional feature
sysexts at runtime without a reflash. It is gated on `isRealDevice()` — all
add-on operations are no-ops in dev/emulated mode.

**Zod schemas** (`packages/rpc/src/schemas/addons.schema.ts`) [EXISTS]

`AddonDescriptorSchema` mirrors the image-baked JSON descriptor format from
`image-building-pipeline/v2/manifests/schema/addon.schema.json`. It is the single
TypeScript source of truth for the descriptor shape — never duplicate it in `apps/`.

`AddonStateSchema` describes per-feature runtime state persisted under the `addons`
key of `config.json`. Fields: `enabled`, `phase`, `versionMaterialized`,
`osVersionMaterialized`, `userConfig`, `lastError`, `autoDisabled`.
`osVersionMaterialized` (T29) records the OS VERSION_ID the staged `.raw` was
fetched for, so the reconciler can detect an OTA-stale artifact by exact (G1)
match. The persisted `phase` enum (`ADDON_PHASES`) is
`idle | installing | active | pending | disabling | error`; `pending` (T29) is
the reconciler's non-terminal "wanted but not yet materialisable" state.

Key regex constants (defined once in `addons.schema.ts`, imported everywhere):
- `ADDON_ID_RE` — lowercase alphanumeric + hyphens (stricter than `APT_PACKAGE_NAME_RE`)
- `SEMVER_RE` — `MAJOR.MINOR.PATCH` with optional pre-release/build
- `SYSEXT_PATH_RE` — `/usr/…` or `/opt/…` only (G2 contract)
- `ARTIFACT_URL_RE` — HTTPS with mandatory `{os_version}` placeholder

**Config atomicity (E3)** [EXISTS]

All writes to `config.json` go through `writeFileAtomicSync` in
`apps/backend/src/helpers/config-loader.ts`. The pattern: write to a sibling temp
file (`.<name>.<pid>.tmp`), `fsync`, then `rename` — so a crash mid-write never
corrupts the live config. The `addons` key in `runtimeConfigSchema` defaults to
`{}` when absent, so old configs without the key parse cleanly.

Test coverage: `apps/backend/src/tests/addons-config-state.test.ts` — round-trip,
crash-mid-write, and missing-key defaulting.

**Manager state machine** (`apps/backend/src/modules/addons/manager.ts`) [EXISTS]

The runtime orchestration layer (T28). Mirrors the kiosk state machine: every
OS/network/persistence primitive is injected through `AddonManagerDeps` (DI for
tests), and the SAME crash-loop discriminator drives auto-disable.

- **Manager phases** (`AddonManagerPhase`): `disabled → enabling → enabled`,
  `enabled → disabling → disabled`, plus `failed`, `pending`, `auto_disabled`.
  `toAddonState`/`phaseFromState` losslessly map these onto the schema-valid
  `AddonState` triple (`enabled` + `phase` + `autoDisabled`), so `config.json`
  always parses even though the persisted `phase` enum is coarser.
- **Enable pipeline** (ordered, each gated/atomic): `isRealDevice()` (G6) →
  free-space precheck (E1: `/data` free > `sizeInstalled × 2 + 512 MiB`) →
  download → `/data/tmp/<id>.raw.tmp` → sha256 + bounded detached-signature fetch →
  atomic preparation of raw/signature in `/var/cache/ceralive/addons` (not the scan
  directory) → `ceralive-addon-helper enable <id>` (authoritative GPG/sha256
  validation, scan publication and refresh) →
  unmask + start descriptor units → validation probe (auto-disable on failure).
- **Disable pipeline**: reverse + idempotent — stop + mask units → helper
  `disable` → remove artifact → drop config state.
- **Disruptive admission**: manager and operator prelude paths consume the
  shared runtime adapter; refusal preserves intent and uses the existing typed
  reason. The privileged wrapper checks again before submission. The sole gated
  action inventory, late-refusal limits and host-proof boundary live in
  [START-LIFECYCLE.md](../START-LIFECYCLE.md#disruptive-action-gate-partial--host-tested-board-re-drill-owed).
- **Transaction settlement**: every published `installing`/`disabling` phase has
  one terminal frame on success, ordinary failure or late refusal. A pre-helper
  refusal restores prior intent, live phase and subscriber projection (including
  explicit disabled state for a new absent add-on). Refusal after completed
  activation but before the unit tail finishes records `pending` with the actual
  new materialized version, not the old `active` receipt. RPC carries userConfig as
  an operation-scoped draft, not a separate pre-call write/rollback: the manager
  applies it only when its admitted transition starts and owns all settlement.
  Persistence failure is contained independently of publication: a terminal `error`
  frame uses the existing enable/disable failure token, the live snapshot remains
  authoritative for this process, and writes retry on the next mutation or boot/
  hydration settlement. No durability or successful activation is inferred from that
  frame. Configuration commits also supersede any older pending persistence.
- **Concurrency**: manager enable/disable, kiosk toggles/polls and reconciler final
  publication share a reentrant per-ID lock. Manager/safety intent changes advance
  an in-process revision; a held reconciler checks it and fresh enabled/autoDisabled
  intent before refresh and every publication, including failure and raw fast paths.
  Reconciler preparation remains outside the lock; manager preparation remains
  inside it (a stalled download can delay a same-ID action). These are in-process rules, not a new
  persisted-format or cross-process authority.
- **Reservation seam**: all disruptive publication/helper/unit calls route through
  `disruptive-sysext-step.ts`, carrying one still-active operation identity through
  awaited nested calls. Mutation, draft-baseline and operation tokens retire in
  `finally`; inherited context alone grants no authority after release. Recurring
  kiosk intervals are registered outside all three contexts, never under Start/Stop.
  The outer step takes ONE service-lifetime `withServiceReservation` hold owned by that
  identity; nested steps re-enter it by depth through `getDisruptiveActionDecision({
  heldBy })` and only the outermost release reopens admission. Other owners, a pending
  reboot/poweroff and late descendants of a released operation are refused with
   `update_in_progress`; a held step refuses reboot/poweroff the same way. Direct unit
   steps retain their existing ordinary-failure policy; uncertain outcomes poll their own
   unit: no queued job plus that unit
  type's steady state (`.service` running/exited, `.socket` listening, `.timer`
  waiting/elapsed, `.path` waiting, `.target` active, `.mount` mounted, or any
    inactive/dead or failed/failed). Mutating helper enable/disable/refresh instead uses
    ordinary Bun spawn of `/usr/bin/setsid -w -- /usr/bin/ceralive-addon-helper action [id]`:
    no sudo, PTY, detached spawning or `setsid -f`. The checked no-fork launcher makes
    PID=PGID=SID; `-w` itself does NOT wait for all descendants. The packaged backend is
    root/root and refuses non-root mutation. PATH and locale are fixed; BASH_ENV,
    SHELLOPTS and CERALIVE_* tool/path overrides are not inherited. Status retains sudo.
    With a returned handle, success AND every possibly-effectful failure, including exit 1, require actual
    direct-child exit and literal ESRCH from `kill(-ownedPGID, 0)`, with integer PGID > 1.
    A successful syscall means present; every other errno, including EPERM, is UNKNOWN.
    First retirement is latched, so subsequent unit polling cannot probe a reused number.
    The collector still signals only its direct child; timeout retains partial output,
    its failure class and actual 137/143 evidence. TERM-induced zero is not success.
    The runner's typed dispatch fact is none/started/unknown, independent of error spelling.
    A proved prelaunch failure (the runner's root/launcher/options checks or pre-spawn abort),
    or a Bun Error tagged `socketpair`, `fcntl` or `posix_spawn`, releases immediately with the original error and
    no group/unit probe or retry. A returned handle is irrevocably started, including an
    abort racing its assignment; allocated-but-unexecuted evidence stays unknown. This
    pre-exec tag proof depends on the fixed Bun 1.4.2 spawn shape, not generic errno
    clearance. Bun can exec successfully, fail `pidfd_open`, block in `wait4` until the
    leader exits, then throw with no handle. That error, absent/unknown tags and non-Error
    throws stay unknown. Handle-less unknown uses the existing consistent kernel-backed
    helper/sysext census followed by descriptor units, never a nonexistent leader/PGID.
    This rare fallback cannot enumerate arbitrary unrecognized orphan install/rm/jq/systemctl
    descendants or recover their lost group; empty recognized evidence is not absolute
    descendant retirement. Unreadable rows or persistent unrelated churn may over-hold.
    It uses capped cancellable retries, not a total deadline. Other callers' ordinary-failure
    policy and manager failure tokens are unchanged.
    Enable/disable derives the
    baked unmask→enable→start unit union (deduplicated) before submission, then observes
    its jobs/lifecycles AFTER group retirement. Descriptor failure prevents submission.
    Groups retain inherited clients, filesystem mutators, asynchronous jq substitution,
    exec/fork/double-fork and reparented descendants regardless of names. A zombie holds
    until reaped; there is no census-based zombie exemption or elapsed-time clearance.
    A descendant changing its session/group escapes: adding such a tool triggers a
    replacement with scope containment. Groups do NOT contain submitted PID-1 jobs,
    services/hooks or other-daemon work, manager Reload (including enable/disable reload
    and sysext metadata reload), or an unacknowledged request left by a killed client.
    A descriptor observation on another connection is not a general request-drain barrier.
    Manager's separate systemctl tails retain their own unit evidence, not group ownership.
    The legacy census remains for generic outer operations and the rare handle-less unknown
    fallback, never as an additional AND-condition for a returned helper handle; its readable
    named observations are not a descendant inventory.
    Timers only re-observe, never clear a hold. Cancellation/retired tickets schedule no
    retry, including rejection of the first observation. Installed behavior remains unqualified.
- **Stuck service hold (operator meaning)**: a service hold has NO supersede path; only
  re-submitting the SAME pending power action supersedes a SHUTDOWN hold. Natural causes
    (the 30 s helper timeout, a slow unit, a denied group probe or an unreaped zombie) can
   settle on later positive evidence, but eventual settlement is not guaranteed.
   In particular, manager preparation/download has no application-level total
   deadline (`manager.ts`); a naturally stalled kiosk Start can retain its outer hold
   indefinitely. Persistent unreadable evidence or unsettled work also retains it.
   The operator escape is
  restarting `ceralive.service` or a power cycle; there is deliberately no in-product
   override (Atlas D249, owner decision). Reservations/evidence are process-local;
   restart clears the local hold, not proof that surviving helper or delegated manager
   work completed. PGID isolation retains the service cgroup: `KillMode=mixed`'s final
   kill phase still reaches its descendants. Kiosk Start holds its one reservation across
  the whole start, including the add-on artifact download, so Go Live is refused with
  the commit-stage `update_in_progress` copy during that download (documented residual,
   N/MINOR).
    Board drills must establish installed setsid/environment, real helper descendants,
    orphan/zombie retirement under the installed init, signal/output mapping, queued
    descriptor jobs and service restart on BOTH boards, plus a real launcher failure leaving no hold
    and a post-exec pidfd failure retaining exclusion. Forcing that pidfd fault on an installed
    image requires privileged instrumentation; the unprivileged host control is not board proof.
   Host fixtures do not prove installed completion, shutdown or safe power loss.
- **Validation deadline**: `runValidateCmd` uses `spawnWithTimeout` and its shared
  termination classification. A TERM-induced zero after timeout throws typed
  `SpawnTimeoutError`; the enable pipeline maps it to `addon_validation_failed`
  and auto-disables. Only a natural zero before termination is healthy. The
  descriptor/dependency signatures and persisted schema are unchanged; proof is host-only.
- **Crash-loop auto-disable**: `pollAddonCrashLoop` reads `NRestarts` per unit;
  `>= ADDON_CRASH_LOOP_RESTART_THRESHOLD` (3) masks the units and parks the
  add-on in `auto_disabled` (same rule as kiosk T5).
- **Interrupted startup**: only `installing` and `disabling` are stored transitional
  phases in the existing schema. Startup, the default boot reconciler, and initial
  authenticated hydration settle any such state without a live per-ID owner into
  `pending` for enabled intent or `error` for disabled intent, with existing
  `addon_enable_failed`/`addon_disable_failed` tokens and unknown materialization
  omitted. They do not claim activation/teardown succeeded. Enabled unresolved
  intent retries through admitted reconciliation; disabled intent stays actionable
  and non-busy. Hydration preserves a phase that has a live owner in this process.
- All privileged work is delegated to `ceralive-addon-helper` (G-trust); the
  manager never mutates the sysext scan dir or systemd directly on the trusted
  path — it drives the helper and argv-only `systemctl`.

Test coverage: `apps/backend/src/tests/manager.test.ts` — pure mapping, the
enable/disable pipelines, crash-loop + validation auto-disable, and the G6/E1
negative paths.

**Post-boot reconciler** (`apps/backend/src/modules/addons/reconciler.ts`) [EXISTS]

`runAddonReconciler()` (T29) reconciles desired state (config.json `addons`)
against the materialised `/data/extensions/<id>.raw` sysexts after a boot/OTA. It
is **fire-and-forget and NEVER gates boot or the OS-update healthcheck/rollback** —
every failure is caught and downgraded to a persisted `pending` phase; the run
never throws and self-serialises (a concurrent call is a no-op).

- Per enabled add-on: if the staged `.raw` is missing **or** its
  `osVersionMaterialized` ≠ the live `/etc/os-release` VERSION_ID (G1 exact
  match — never loosened), re-fetch `artifact.urlTemplate` (substituting
  `{os_version}` + `{board}`) → sha256 + GPG verify in a private cache preparation
  directory → revalidate current intent under the shared lock → admitted atomic
  scan publication → helper `refresh`. A refusal before refresh rolls scan
  publication back (absent for a new artifact; prior payload bytes for replacement).
  Prepared/cache bytes are cleaned after refusal or supersession. Cache publication
  supports different filesystems by copying into a non-raw sibling before rename.
- **No compatible artifact** (404 / network / descriptor `compatibleOsVersions`
  excludes the live OS): set `phase: pending` + `lastError:
  addon_not_available_for_os_version`. Boot is unaffected.
- **No shared admission**: a disruptive refresh is deferred — set `phase: pending` +
  `lastError: addon_refresh_deferred_streaming`; retried on the next boot.
  Unknown stream evidence and interruptible updates/maintenance also defer;
  admission is re-read after awaited preparation and before refresh. A typed helper
  refusal has the same pending/deferral classification, never OS unavailability.
  Raw presence avoids refresh only for a settled `active` baseline with no
  `lastError` and exact descriptor-version and current-OS metadata. Error,
  interrupted installing, pending, missing-version and mismatched-version evidence
  require admitted fetch/verification and refresh. The unchanged helper publishes
  scan bytes before refresh; if submitted enable fails, the manager omits uncertain
  materialization metadata instead of pairing replacement bytes with an old version.
- Triggered from `main.ts` at startup (non-blocking) and re-pokable via SIGUSR1
  from the `ceralive-addon-reconciler.service` oneshot (deployment/), which is
  deliberately NOT wired into any rollback/healthcheck target.
- The main service uses `Type=notify`: it reports ready after reserving boot
  signals and binding the control server, before optional subsystem initialization.
  The ordered oneshot therefore cannot signal the native-runtime/import window.
  Add-on work remains asynchronous and never gates readiness. See
  [`docs/BOOT-READINESS.md`](../BOOT-READINESS.md).
- All effectful surface is injected via `ReconcilerDeps`; default deps are built
  lazily (dynamic import) so the module never pulls the streaming/config graph or
  requires `setup.json` at test-import time.

Test coverage: `apps/backend/src/tests/addon-reconciler.test.ts` — re-materialise
(missing + VERSION_ID mismatch), idempotency, the pending/defer negative paths,
and the boot-safety (never-throws) + emulated-mode no-op guarantees.

Tail coverage: `sysext-tail-{settlement,reconcile,interleavings}.test.ts` and
`sysext-artifact-publication.test.ts` exercise literal subscriber frames, config
bytes, private physical scan files, superseded intent and refresh ledgers. Initial
authenticated hydration emits explicit disabled entries for baked-but-absent IDs,
because the frontend merges add-on frames by ID and an empty map cannot clear a
retained busy entry. No frontend schema/merge or catalog change is needed.
Real helper execution during stream start, hardware late-refusal settlement and
uninstall during a held real reconciliation remain board drills, not host passes.
`sysext-{owner-lifetime,outcome-settlement,activation-evidence}.test.ts` adds
registration-time async-context preserving timer injection, real procedure and
startup hydration, terminal EIO/retry, and unchanged Bash helper publication followed
by exit 1 against private directories. Signature and systemctl tool sinks in that
failure fixture do not qualify real signatures or device services. Board drills
still owe Start/Stop while polling, reinstall with a mid-activation stream, backend
kill during disable, and a refresh failure on the installed helper.

**Packaging contract (#194).** `ceralive-addon-reconciler.service` is staged into
the `.deb` **from `deployment/`**, not from `dist/`. `dist/` only ever held the
unit as a side effect of `build_backend_only` mirroring `deployment/*` into it, so
the unit's presence in the package was hostage to that mirror step. Sourcing it
directly from `deployment/` makes the staging explicit and mirror-independent.
Pinned by a contract test wired into `bun run test:release-package-contracts`,
which asserts the unit is staged, enabled in `postinst`, and present in the payload
of a scratch-built `.deb` — so a future build-script refactor cannot silently drop
the post-boot reconciler from the device image.

**sysext refresh protocol**

The add-on manager must follow the protocol from
`image-building-pipeline/v2/docs/addon-sysext-refresh.md`:
- **Update:** `systemd-sysext refresh` → `systemctl restart <addon>.service`
- **Disable:** `systemctl stop <addon>.service` → `systemd-sysext refresh`

Never report an add-on "updated" or "disabled" on the strength of the sysext call
alone. The service restart (on update) or stop (on disable) is what makes the
transition real.

**isRealDevice() gate**

All add-on operations (install, enable, disable, refresh) MUST call
`await isRealDevice()` at entry. In dev/emulated mode return
`{ success: false, error: "addon_unavailable_in_emulated_mode" }` without touching
`systemd-sysext` or `systemctl`. Read-only status queries are NOT gated. The
manager's `enableAddon`/`disableAddon`/`pollAddonCrashLoop` all enforce this gate
as their first step (`ADDON_UNAVAILABLE_ERROR`).
