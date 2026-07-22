# Config Persistence — Placement Map + Storage-Engine Decision

**Status:** `[EXISTS]`

This document answers two questions about every piece of runtime state CeraUI
writes to disk: **where does it live, and how durable does it need to be**
(the placement map), and **should the backend move off hardened atomic JSON
onto something like `bun:sqlite`** (the decision record).

It exists because T6 (crash-atomic cache writes) and T7 (boot-time orphan
sweep) just closed the one real reliability gap this stack had — a crash
mid-write could truncate a config file. With that fixed, "should we use a
database instead of JSON files" is a fair question to ask explicitly, once,
and write down — rather than re-litigate it the next time someone notices
`config.json` is a flat file.

## 1. Per-file placement map

Every file CeraUI's backend writes at runtime, grouped by durability
category. "Atomic" means the write goes through `writeFileAtomicSync`
(`apps/backend/src/helpers/config-loader.ts:278`): write to a sibling temp
file, `fsync`, then `rename` over the target — a crash mid-write can never
leave a truncated or half-written file on disk, because POSIX `rename` is
atomic. The exact temp-file name is:

```
.<basename>.<pid>.tmp
```

e.g. `.config.json.12345.tmp`, `.auth_tokens.json.999.tmp`. `writeTextFileAtomic`
(`apps/backend/src/helpers/text-files.ts:43`) is a thin wrapper that delegates
to the same function, so every atomic writer in the table below leaves an
orphan matching that one pattern and nothing else. T7's boot sweep
(`apps/backend/src/helpers/boot-cleanup.ts`, wired into `main.ts` right after
config load) matches that exact glob (`/^\.[^./][^/]*\.\d+\.tmp$/`) and unlinks
any leftover from a prior crash, fail-soft, every boot.

### Durable device config

| File | Writer | Atomicity | Notes |
|------|--------|-----------|-------|
| `config.json` | `saveConfig` (`modules/config.ts:93`) | Atomic (`writeFileAtomicSync`) | The single runtime state file: relay target, audio/video settings, kiosk state, add-on state, and (see below) the password/SSH hashes. Pre-dates T6 (E3 guardrail); unchanged by this wave. |
| `notification_dismissals.json` | `NotificationDismissalStore.recordDismissal` (`modules/ui/notification-dismissals.ts`) | Atomic (`writeFileAtomicSync`) | Durable record of which persistent notifications the operator dismissed, keyed by SEMANTIC identity so a dismissal survives a page reload AND a backend restart. LRU-bounded, corruption-quarantined. Path overridable via `CERALIVE_DISMISSALS_FILE` (tests). See the dedicated subsection below. |

#### Notification dismissal store — on-disk format + semantics

The durable dismissal store (`apps/backend/src/modules/ui/notification-dismissals.ts`)
records which persistent notifications an operator dismissed so they stay
dismissed. It replaces an in-memory `Map` that survived neither a page reload nor
a backend restart.

**On-disk format** (`notification_dismissals.json`):

```json
{
  "version": 1,
  "entries": [
    { "key": "update:2026.7.3", "dismissedAt": 1737590400000 }
  ]
}
```

- `version` — the store schema version (currently `1`); a future shape change
  bumps it.
- `entries` — an ordered array of `{ key, dismissedAt }`. Array order IS LRU order:
  the front is the least-recently-dismissed. `dismissedAt` is a `Date.now()`
  millisecond epoch.

**Keyed by semantic identity.** The `key` is the notification's SEMANTIC identity,
never an incidental per-boot id. For a software-update notification the key is the
version string (`update:<version>`), so dismissing "update 2026.7.3 available" does
NOT suppress a later "update 2026.7.4 available" — a NEW version re-notifies because
its key was never dismissed. A notification without a semantic dismissal key is
merely removed (its dismissal is not persisted), preserving the pre-existing
transient behavior.

**Durability guarantees.**

- **Atomic write** — every `recordDismissal` re-serializes the whole set and writes
  it through `writeFileAtomicSync` (temp file → `fsync` → `rename`), so a crash
  mid-write leaves the previously-committed file intact; a torn write can never
  corrupt the committed dismissals.
- **LRU bound** — the set is capped (`DEFAULT_MAX_DISMISSALS = 256`). Recording past
  the cap evicts the oldest dismissal; re-recording an existing key refreshes its
  recency. The cap is also enforced when loading an over-cap file off disk.
- **Corruption quarantine** — on load, an unparseable file (or a well-formed JSON
  file whose shape fails the Zod schema) is renamed aside to
  `notification_dismissals.json.corrupt-<timestamp>`, the event is logged, and the
  store starts fresh with an empty set. A corrupt file never throws or crashes boot.
  The quarantine sidecar uses a `.corrupt-<ts>` suffix — distinct from the atomic
  writer's `.<basename>.<pid>.tmp` temp convention, so the T7 orphan sweep does not
  touch it.

### Setup / hardware identity

| File | Writer | Atomicity | Notes |
|------|--------|-----------|-------|
| `setup.json` | **none — read-only at runtime** | N/A | Loaded once at boot via `loadJsonConfigSync(..., required: true)` (`modules/setup.ts`). Hardware type, exec-path overrides, and the streaming-engine flag are written once at image-build / first-run time, never mutated by the running app. A legacy `engine` value is coerced to `"cerastream"` at parse time (with a warning), but that coercion happens in memory — it is never written back to disk. |

### Credentials

| File / field | Writer | Atomicity | Notes |
|---|---|---|---|
| `auth_tokens.json` | `savePersistentTokens` (`rpc/procedures/auth.procedure.ts:41`) | Atomic (`writeFileAtomicSync`, direct) | Persistent login tokens. Made atomic in T6 — previously routed through the non-atomic `writeTextFile`. |
| `password_hash` / `ssh_pass_hash` | `saveConfig` (`modules/config.ts:84-93`) | Atomic (rides `config.json`'s write) | These are fields **inside** `config.json`, not separate files — `saveConfig` always re-serializes them alongside the rest of the runtime state, so they get the same crash-atomic guarantee as everything else in that file. |

### Regenerable caches

All four of these are populated from the network (DNS lookups, relay-catalog
fetches, GSM operator lookups) and can always be rebuilt from scratch if lost
— a corrupted or missing cache degrades performance, never correctness. All
four now write **exclusively** through `writeTextFileAtomic` (T6); before T6
they used the non-atomic `writeTextFile` (plain `Bun.write`).

| File | Writer | Atomicity | Load-time tolerance |
|------|--------|-----------|----------------------|
| `dns_cache.json` | `dnsCacheValidate` (`modules/network/dns.ts:230`) | Atomic (`writeTextFileAtomic`) | `loadCacheFile` returns an empty cache on missing/invalid JSON — never throws. |
| `gsm_operator_cache.json` | `writeGsmOperatorsCache` (`modules/modems/gsm-operators-cache.ts:36`) | Atomic (`writeTextFileAtomic`) | Same tolerant `loadCacheFile` path. |
| `relays_cache.json` | `updateCachedRelays` (`modules/remote/remote-relays.ts:153`) | Atomic (`writeTextFileAtomic`) | Same tolerant `loadCacheFile` path. |

(`relays_cache.json` has one writer function; the table lists it once, not
per-call-site.)

### Ephemeral tmpfs (explicitly NON-atomic by design)

These files are either regenerated on every stream (re)start, live only for
the current boot, or are secrets that must never touch durable disk. None of
them go through `writeFileAtomicSync` — that's intentional, not an oversight,
and T6/T7 explicitly scoped them **out**:

| File | Writer | Why non-atomic is correct |
|------|--------|----------------------------|
| `/run/ceralive/kiosk-token` | `mintKioskToken` (`modules/ui/kiosk-token.ts:87`, plain `Bun.write`) | Single-use, 32 bytes of entropy, invalidated on first read. `/run` is tmpfs — gone on power-off by design; there is nothing to protect against a torn write because a torn token is simply rejected and re-minted. |
| `/run/ceralive/sim-pin.secret` | `storeSimPin` (`modules/modems/sim-secrets.ts:80`, plain `Bun.write`) | Deliberately kept OUT of `config.json` so it never gets swept up in a config read/backup. tmpfs, 0600, cleared on any auto-unlock failure — same non-durability contract as the kiosk token. |
| SRTLA IP list (`setup.ips_file`, default `/tmp/srtla_ips`) | `setSrtlaIpList` (`modules/streaming/srtla.ts:57`, plain `Bun.write`) | Regenerated from the live network-interface list on every call; a torn write is simply overwritten on the next interface change or stream restart. Feeds `srtla_send` via SIGHUP reload, not read at boot. |
| `bcrpt` source-IP / server-IP / key files (`<bcrpt_path>/source_ips`, `/server_ips`, `/key`) | `generateBcrptSourceIps`, `generateBcrptServerIpsFile`, `generateBcrptKeyFile` (`modules/streaming/bcrpt.ts:100,136,145`, all via `writeTextFile`) | Same story: regenerated from `getNetworkInterfaces()` / the relays cache on every relay-config change, then `bcrpt` is reloaded. Nothing reads these files independent of the generator that just wrote them. |
| `/tmp/ceralive_restarted` (autostart marker) | `autoStartStream` (`modules/streaming/streamloop/autostart.ts:50`, `fs.writeFileSync`) | An empty marker file — its only content is its own existence. `/tmp` is not guaranteed durable across reboot on every board, which is exactly the semantic this flag wants (detect "did we already run once this boot"). |

**T7's boot sweep does not touch this category.** The orphan-cleanup regex
(`/^\.[^./][^/]*\.\d+\.tmp$/`) only matches the atomic writer's dotted temp-file
convention; none of the files above ever produce a file matching that pattern,
so there is nothing for the sweep to find or remove here — by construction,
not by exclusion logic.

### Out of scope: add-on sysext binary artifacts

For completeness (this section exists specifically so no runtime-written file
is silently missing from the audit): the add-on manager and reconciler
(`modules/addons/manager.ts:404`, `modules/addons/reconciler.ts:421-433`) also
write files — downloaded `.raw` sysext images and `.sig` signatures under
`/data/extensions/` and a cache dir. These are **not config state**: they are
multi-megabyte binary artifacts fetched from a remote URL, verified by GPG +
sha256, and staged with their own temp+rename pattern
(`.{id}.raw.{pid}.tmp`, distinct from the config-loader's convention). They
are a different persistence class entirely (installer/artifact storage, not
device configuration) and are intentionally excluded from the placement map
above and from T6/T7's scope.

## 2. Decision record: stay on hardened atomic JSON

**Recommendation: keep hardened atomic JSON files as the persistence
mechanism. Do not migrate to `bun:sqlite`.**

### Why atomic JSON is the right fit, not a compromise

- **The files are tiny.** `config.json`, `auth_tokens.json`, and the three
  caches are all small, flat, whole-file writes — none of them are
  approaching a size or write-frequency where file I/O is a bottleneck.
- **Every write is a whole-file replace anyway.** `saveConfig`,
  `savePersistentTokens`, and the three cache writers all serialize the
  entire object and write it in one shot. There's no per-key mutation pattern
  in this codebase that a database's row-level writes would actually help
  with — a database would just be a fancier way to do the same whole-object
  replace.
- **There are no query needs.** Nothing in CeraUI ever needs to filter, join,
  or index into `config.json` or the caches. Every read is "load the whole
  file, validate it with Zod, hand back the object." A query engine solves a
  problem this codebase doesn't have.
- **Human-inspectable JSON is a field-support asset, not a nicety.** When a
  device in the field misbehaves, a support engineer (or the device owner,
  or a support script) can `cat config.json` over SSH and read it directly —
  no `sqlite3` CLI, no schema archaeology, no risk of a lock held by a live
  process blocking a read. This matters concretely for a fleet of physical
  streaming boxes that don't always have a maintainer standing next to them.
- **The actual reliability gap is already fixed.** The historical risk with
  this approach was never "JSON is unsafe" — it was "a crash mid-write can
  truncate a file that was written with a naive `fs.writeFileSync`/`Bun.write`
  call." T6 closed that for every durable/cache file (`writeFileAtomicSync` /
  `writeTextFileAtomic`, all four caches + `config.json` + `auth_tokens.json`),
  and T7 closed the "orphaned temp file taking up space after a crash"
  follow-on. The write mechanism — not the file format — was the gap, and
  it's now closed with the standard write-temp/fsync/rename pattern that
  database engines themselves rely on internally.

### The `bun:sqlite` alternative — documented for a later decision, not chosen now

`bun:sqlite` is a legitimate alternative and worth recording so a future
agent or maintainer doesn't have to re-derive the tradeoff from scratch. It
offers real properties this stack doesn't have today:

- **ACID transactions + WAL-mode durability** as a built-in guarantee, rather
  than a hand-rolled temp+fsync+rename convention that every new writer has
  to remember to use correctly.
- **Per-key writes** — updating one field wouldn't require re-serializing and
  rewriting the entire object.

But those properties come with real costs that outweigh the benefit for this
workload, specifically:

- **Binary opacity.** A `.sqlite` file is not `cat`-able. Field support loses
  the "just open the file and read it" workflow that plain JSON gives for
  free — a real regression for a device that ships to end users, not just
  developers.
- **Migration effort for no runtime win.** Every current write/read site
  (roughly 14 call sites across `config.ts`, `auth.procedure.ts`,
  `remote-relays.ts`, `dns.ts`, `gsm-operators-cache.ts`, plus their Zod
  validation and test doubles) would need to move from
  `loadJsonConfig`/`writeFileAtomicSync` to SQL statements, with no
  corresponding gain: there's no query CeraUI needs to run that a `SELECT`
  would make faster than "parse the one JSON file that's already in memory."
- **No actual query-performance win for this workload.** The files are
  small enough, and always read/written whole, that SQLite's indexing and
  query planner have nothing to optimize here — they're solving a problem
  (efficient partial reads/writes over a large dataset) that doesn't exist
  in this codebase's shape.

If a future requirement genuinely needs per-key transactional writes, a much
larger config surface, or concurrent-writer safety across multiple processes,
`bun:sqlite` is the natural next stop — but that is a decision for whoever
hits that requirement, made against a concrete need, not a preemptive
migration today.

## See also

- `apps/backend/src/helpers/config-loader.ts` — `writeFileAtomicSync`,
  `loadJsonConfig`, `loadCacheFile`.
- `apps/backend/src/helpers/config-schemas.ts` — Zod schemas for every file in
  the placement map above.
- `apps/backend/src/helpers/boot-cleanup.ts` — the T7 orphan sweep.
- `docs/CONVENTIONS.md` — CeraUI-local conventions (this doc doesn't restate
  them).
