# Device Access & Credentials

**Status:** `[EXISTS]`

This is the single reference for how an operator (or a support engineer) gets
into a CeraLive device: the LAN/web-UI password, the SSH password, what
happens the first time a device boots, what happens across an OTA update, and
what a production image ships with by default. It also resolves — as a
board-verified fact, not a guess — the long-standing ambiguity between the
three `config.json` paths that show up across this repo's docs
(`/opt/ceralive`, `/data/ceralive`, `/etc/ceralive`).

No real password, hash, or token appears anywhere in this document — every
example below is a pattern or a redacted placeholder.

## 1. Config path resolution — the one fact that must be board-verified

Three different "`config.json` lives here" claims exist across this
workspace's docs, and it is easy to read them as contradictory. They are not —
they describe three different files at three different points in the
pipeline, and only one of them is the live, runtime, device-state file this
whole document is about.

| Path | What it actually is | Read/written at runtime? |
|------|----------------------|---------------------------|
| `/data/ceralive/config.json` | The real, persistent device-state file — lives on the `/data` partition, the ONE partition RAUC's A/B slot updates never touch (`image-building-pipeline/docs/partition-contract.md` §6). | **Yes** — this is the file. |
| `/opt/ceralive/config.json` | The path the backend process actually opens. `apps/backend/src/modules/config.ts` calls `loadJsonConfig("config.json", …)` — a **bare relative filename**, no `path.join`, no `/opt`/`/data`/`/etc` literal anywhere in `helpers/config-loader.ts`. The resolved path is therefore whatever the process's **current working directory** is. systemd pins that CWD with `WorkingDirectory=/opt/ceralive/` in `deployment/ceralive.service`. | **Yes — same file as above.** `/opt/ceralive` is a **bind mount** of `/data/ceralive` (`postinst-lib.sh::setup_data_persistence`), so on a booted device `/opt/ceralive/config.json` and `/data/ceralive/config.json` are the identical inode — not a copy, not a symlink target, the same file reachable through two mount points. |
| `/etc/ceralive/config.json` | A **packaging-time artifact only** — the `.deb`'s copy of `dist/config.json` (`build-debian-package.sh`), staged into `/etc/ceralive/` at install time as a template/reference. | **No.** Nothing in the running backend ever opens `/etc/ceralive/config.json`. It is not read at boot, not read at any RPC call, not written by `saveConfig()`. It exists purely as packaging output and is never consulted once the device is running. |

**Resolution order, stated once, correctly:**

1. The backend's own code resolves `config.json` relative to its process
   working directory — nothing else. There is no environment-variable
   override, no fallback search path.
2. systemd fixes that working directory to `/opt/ceralive/` for every boot.
3. `/opt/ceralive` is not itself a directory with real content for
   `config.json` — it is bind-mounted onto `/data/ceralive`, so the file the
   backend opens and the file that survives an A/B OTA slot swap are,
   mechanically, the same file.
4. `/etc/ceralive/config.json` is a dead end for this question. It is a build
   artifact, not device state, and confusing it with the live file is the
   single most common source of "I edited config.json and nothing changed" —
   the edit almost always landed on the wrong one of the three paths above.

### Board verification

Direct board evidence for the bind-mount claim (captured live on a Radxa Rock
5B+, `192.168.78.131`, this plan's reference device) is already on record from
prior work in this same effort, and is re-cited here rather than re-typed:

- `mount` output showing `/dev/mmcblk0p4 on /opt/ceralive` — i.e. `/opt/ceralive`
  is a real block-device mount, not a symlink or an empty directory.
- `stat -c %i` on both `/opt/ceralive/config.json` and
  `/data/ceralive/config.json` returning the **same inode number** (`130770`)
  — the strongest possible proof two paths name one file, stronger than a
  `sha256sum` match (which two independent files could coincidentally share).
- Repeated `sha256sum` + `stat -c %Y` (mtime) pairs across many separate save
  operations in this plan's board work, all showing the two paths moving in
  lockstep on every write.
- A separate, explicit board note recording `/etc/ceralive/config.json` as
  `dist/config.json` — packaging output, "untouched — device state lives
  elsewhere."

Full transcript and the exact commands: `.omo/notepads/device-platform-wave4/learnings.md`,
entries around lines 496–497 (`/opt/ceralive` bind-mount / same-inode finding),
542 (the sha256+mtime bracketing convention used throughout this plan's board
work), and 7900–7965 (the `/etc/ceralive/config.json` = `dist/config.json`
packaging-artifact finding, with the full `WorkingDirectory=/opt/ceralive/`
excerpt from `deployment/ceralive.service`).

**This session's own re-verification attempt:** per this task's own
acceptance criteria, a fresh live SSH check was attempted against the same
board (`192.168.78.131`) rather than relying solely on the citations above.
The board did not answer during this session — `ping` returned 100% packet
loss on every attempt across roughly 20 minutes of retries (including a full
`arp-scan` of the local `/24`, which listed every other host on the subnet but
not `.131`), and `ssh` therefore never reached a handshake. This matches a
documented pattern for this same board elsewhere in this plan's history
(intermittent unreachability that self-resolves later in a session — see
`learnings.md` lines ~5053, ~5208–5215) rather than a new finding. The facts
above are cited from this plan's own prior, successful board sessions against
this exact device — not invented, not taken from a different board — and the
source-code half of every claim in this document (which paths the code
touches, in what order) was independently re-derived from the current
`apps/backend/src/modules/config.ts` and `helpers/config-loader.ts` during
this task, not merely copied from the notepad. See
`.omo/notepads/device-platform-wave4/decisions.md` for this session's
board-attempt log.

## 2. UI (LAN/web) password lifecycle

The UI password is what an operator types into the login screen at the
device's IP or `<hostname>.local` — it is unrelated to SSH.

### First boot — nothing set yet

The backend never bakes in a default UI password. On login, the adapter
checks whether a password hash exists at all
(`apps/backend/src/rpc/adapter.ts`):

```ts
if (!getPasswordHash()) {
  sendToClient(ws, "status", { set_password: true });
}
```

The frontend's `Auth.svelte` reads `status.set_password` and swaps its login
form into "create a password" mode. Submitting calls
`createPassword(password)` (`lib/stores/auth-status.svelte.ts`), which calls
`rpc.auth.setPassword({ password })` — the exact same RPC the "change
password" flow below uses. There is no separate first-boot-only code path;
first boot is just the state where `setPassword` is allowed without being
authenticated yet (see next section).

### Hashing + storage

`auth.setPassword` (`apps/backend/src/rpc/procedures/auth.procedure.ts`):

```ts
// Allowed if already authenticated, OR if no password is set yet at all.
if (isAuthed || !currentHash) {
  const newHash = Bun.password.hashSync(input.password, {
    algorithm: "bcrypt",
    cost: BCRYPT_ROUNDS, // 10
  });
  setPasswordHash(newHash);
  // ...
  config.password = undefined; // clears any legacy plaintext field
  saveConfig();
}
```

- Hashing is `Bun.password.hashSync` with `algorithm: "bcrypt"`, cost `10`.
- The hash is held in an in-memory module (`rpc/state/password.ts`,
  `setPasswordHash`/`getPasswordHash`) — not directly on the `config` object
  the rest of the backend passes around.
- `saveConfig()` (`modules/config.ts`) is what actually writes it to disk: it
  re-reads the in-memory hash and folds it into the serialized object as
  `password_hash`:

  ```ts
  export function saveConfig() {
    const dataToSave: RuntimeConfig = {
      ...config,
      password_hash: getPasswordHash(),
      ssh_pass_hash: getSshPasswordHash(),
    };
    writeFileAtomicSync(CONFIG_FILE, JSON.stringify(dataToSave));
  }
  ```

- On the read side, `loadConfig()` does the mirror image: it pulls
  `password_hash` out of the freshly-loaded config into the in-memory hash
  store, then **deletes it from the in-memory `config` object** —
  `config.password_hash = undefined`. This is why nothing else in the backend
  (or any RPC response built from `getConfig()`) ever hands the hash back out
  incidentally; it only ever exists in the dedicated password-state module and
  in the on-disk file.
- Login (`rpc.auth.login`) verifies with the matching `Bun.password.verify(input.password, passwordHash, "bcrypt")`.

### Change — `PasswordDialog.svelte`

Settings → LAN password opens `PasswordDialog.svelte`
(`apps/frontend/src/main/dialogs/PasswordDialog.svelte`), which validates a
minimum length of 8 locally and, on save, calls the shared `savePassword()`
helper (`lib/helpers/SystemHelper.ts`) — which is the identical
`rpc.auth.setPassword({ password })` call the first-boot wizard uses. Changing
the password therefore requires an authenticated session (the `isAuthed`
branch above); the `!currentHash` branch is what makes the *first* password
possible without one.

## 3. SSH password retrieval

SSH is a **separate credential** from the UI password, with its own field in
`config.json` (`ssh_pass` — kept as **plaintext**, not just a hash) plus a
mirror of the OS-level shadow hash (`ssh_pass_hash`) used only to detect
drift between the persisted password and what `/etc/shadow` currently holds.

### Retrieval path 1 — the authenticated `config.ssh_pass` snapshot

`config.ssh_pass` is an ordinary field on the runtime config object
(`helpers/config-schemas.ts`):

```ts
password_hash: z.string().optional(),
ssh_pass: z.string().optional(),
ssh_pass_hash: z.string().optional(),
```

Unlike `password_hash`/`ssh_pass_hash`, `ssh_pass` is **not** stripped out of
the in-memory `config` object on load — `loadConfig()` only clears the two
hash fields. That means:

- `config.ssh_pass` rides every `getConfig()` read and every `config`
  broadcast to authenticated clients — including the broadcast
  `mintAndApplySshPassword()` fires right after generating a fresh password
  (`broadcastMsg("config", config)` in `modules/system/ssh.ts`).
- Any authenticated LAN client can therefore read the live plaintext SSH
  password simply by reading the device's current config state — no
  dedicated "reveal SSH password" action is required beyond having an
  authenticated session.

**Security caveat (deliberate, not a bug):** this means the UI password and
the SSH password are **not independent security boundaries** — anyone who can
authenticate to the CeraUI web/LAN interface can read the current SSH
password from the config snapshot. This is intentional product design (an
operator managing the device over the LAN UI needs to be told the SSH
password somehow), but it should be understood before treating the UI
password and SSH password as two separately-scoped secrets. Rotating the UI
password does **not** rotate the SSH password, and vice versa.

### Retrieval path 2 — `system.sshResetPassword` RPC

Settings → SSH → "Reset SSH Password" calls the authenticated
`system.sshResetPassword` RPC
(`apps/backend/src/rpc/procedures/system.procedure.ts`):

```ts
export const sshResetPasswordProcedure = authedProcedure
  .output(z.object({ success: z.boolean(), password: z.string().optional() }))
  .handler(async ({ context }) => {
    const password = await resetSshPassword(context.ws);
    return password === undefined
      ? { success: false }
      : { success: true, password };
  });
```

`resetSshPassword()` → the shared `mintAndApplySshPassword()`
(`modules/system/ssh.ts`) generates a fresh random secret, applies it to the
OS account, persists it, and — critically — **returns the plaintext password
directly in the RPC response**:

```ts
const password = randomBase64(24).replace(/[+/=]/g, "").substring(0, 20);
await deps.applyPassword(ssh_user, password); // stdin-only `passwd`, never argv
config.ssh_pass = password;
sshPasswordHash = await probeSshUserHash(deps.readShadow, ssh_user);
deps.persist(); // saveConfig()
broadcastMsg("config", config);
await deps.refreshStatus();
return password;
```

**Security caveat, restated for this path specifically:** the reset RPC's
response is the ONE moment the password is explicitly, deliberately shown to
the caller — this is correct and expected (the operator needs the new
password to actually log in over SSH). What is worth remembering is that this
is not the *only* way to see it — retrieval path 1 above means the same
secret is readable from any subsequent authenticated `config` read, for as
long as it stays the current password. Neither path logs the password
anywhere; it travels only over the authenticated RPC channel, never to the
device log.

The OS-level `passwd` invocation itself is stdin-only, never argv, to avoid
leaking the secret through `/proc/<pid>/cmdline` or process-listing tools:

```ts
applyPassword: async (user, password) => {
  await runWithStdin("passwd", [user], `${password}\n${password}\n`);
},
```

## 4. First-boot provisioning + OTA reapply behavior

Unlike the UI password (which is purely operator-driven — nothing mints it
until someone submits the first-boot form), SSH gets an **unconditional
boot-time provisioning step**, because SSH is enabled at the systemd level
independently of whether CeraUI has ever generated a credential for it.

Boot wiring order in `apps/backend/src/main.ts` (both fail-soft — neither can
brick boot):

```ts
// 1. Mint an initial ssh_pass if none is persisted yet. Runs unconditionally,
//    independent of ssh.service's active/enabled state, so a credential is
//    ready the instant an operator turns SSH on from the UI.
await guardNonCritical("ssh-password-provision", ensureSshPasswordProvisioned);

// 2. Re-apply the PERSISTED password to the live OS account if the OS-level
//    shadow entry has drifted from it (see OTA behavior below).
await guardNonCritical("ssh-password-sync", ensureSshPasswordSynced);
```

- **`ensureSshPasswordProvisioned()`** — no-op if `config.ssh_pass` is already
  set; otherwise mints one through the exact same `mintAndApplySshPassword()`
  path the operator "Reset" action uses. It never *regenerates* an existing
  credential.
- **`ensureSshPasswordSynced()`** — this is the OTA-specific half, and it
  exists because of a real cross-partition fact: `config.json` (holding
  `ssh_pass`/`ssh_pass_hash`) is `/data`-persisted and survives an A/B RAUC
  slot swap (per §1 above), but `/etc/shadow` is **rootfs-local** — baked
  fresh into each OS image and NOT carried across a slot swap. So immediately
  after an OTA update, the freshly-activated slot's `/etc/shadow` still holds
  whatever the *image build* baked in, while `config.json` still remembers
  the operator's real, previously-set password — a mismatch that would
  otherwise silently lock the operator out of SSH until they clicked "Reset."

  `ensureSshPasswordSynced()` compares the live OS shadow hash against the
  cached `ssh_pass_hash`, and on a mismatch **re-applies the existing
  persisted password** (never mints a new one, never calls `saveConfig()` —
  the credential itself is unchanged, only the OS account needs to catch up):

  ```ts
  const liveHash = await probeSshUserHash(readShadow, ssh_user);
  if (liveHash === sshPasswordHash) return; // same-slot boot: fast no-op
  await applyPassword(ssh_user, password); // RESTORE, not reset
  ```

This mirrors the same "restore, don't regenerate" pattern
`image-building-pipeline`'s `ceralive-ssh-firstboot.sh::ensure_host_keys()`
uses for SSH host keys across an A/B slot swap — both exist because the same
partition split (persistent `/data` vs. rootfs-local `/etc`) applies to both
problems.

**The UI password has no equivalent OTA-reapply step**, because it lives
*only* in `config.json` (bcrypt hash) with no OS-level counterpart to drift —
there is nothing on the rootfs side for it to fall out of sync with.

## 5. Production-image no-default-password model

- **No shipped default password, for either account that matters here.** The
  device image ships the `ceralive` user **password-locked** (`passwd -l`,
  set at image-build time in `customize/users.sh`) — there is no baked-in
  password an operator could look up. `root` is locked the same way.
- **`ssh.service` is not enabled by default on a production image.** SSH
  enablement is gated on `CERALIVE_DEBUG_IMAGE` (image-build flag, not a
  device-runtime setting): a production build (`=0`, the default) actively
  disables `ssh.service`/`ssh.socket` so sshd does not start at boot at all.
  The operator turns SSH on from the CeraUI Settings UI, which is what starts
  `sshd` for the first time on that device.
- **The SSH password is generated on-device, not baked into the image.**
  Because the account ships password-locked and `ssh_pass` starts undefined,
  the *only* way a usable SSH password comes to exist is either
  `ensureSshPasswordProvisioned()`'s unconditional boot mint (§4) or the
  operator's explicit "Reset SSH Password" action (§3) — both go through
  `randomBase64(24)`, i.e. real, per-device cryptographic randomness. There is
  no fixed, predictable, or shared "default" value across the fleet for
  production images.
- **A separate debug-image path exists and is out of scope for the
  production model above.** `CERALIVE_DEBUG_IMAGE=1` builds keep SSH
  enabled-by-default with a build-supplied debug password hash, strictly for
  bench/lab use — never for a fleet artifact. That path, and its full detail,
  is owned by `image-building-pipeline`'s `v2/docs/ssh-hardening.md`.

**Known inconsistency in a sibling doc — intentionally NOT fixed here.**
`image-building-pipeline/v2/docs/ssh-hardening.md` (around lines 108–118)
currently states that turning on SSH from the UI "reveals its
**boot-generated** password" — implying the password is minted at boot in a
way tied to that specific boot/image build. Per the source above, that is not
quite the mechanism: the password is either (a) the *already-persisted*
`config.ssh_pass` from a previous boot (re-synced to the OS by
`ensureSshPasswordSynced()`, not regenerated), or (b) freshly minted by
`ensureSshPasswordProvisioned()` on the very first boot that has never had
one, or (c) freshly minted by an explicit operator "Reset." None of these is
"the" one boot-generated value implied by that phrasing. This inconsistency
is a known, already-ledgered fix — it is owned by the pipeline repo's build
documentation todo, not this doc, and this document does not touch
`ssh-hardening.md`.

## See also

- [`CONFIG_PERSISTENCE.md`](CONFIG_PERSISTENCE.md) — the full placement map
  for every file CeraUI's backend writes at runtime, including the
  `writeFileAtomicSync` crash-atomic guarantee that also covers
  `password_hash`/`ssh_pass`/`ssh_pass_hash` as they ride `config.json`'s
  atomic write.
- `apps/backend/src/modules/config.ts` — `loadConfig()` / `saveConfig()`.
- `apps/backend/src/modules/system/ssh.ts` — the full SSH credential
  lifecycle (`mintAndApplySshPassword`, `resetSshPassword`,
  `ensureSshPasswordProvisioned`, `ensureSshPasswordSynced`).
- `apps/backend/src/rpc/procedures/auth.procedure.ts` — `setPasswordProcedure`,
  `loginProcedure`.
- `apps/backend/src/rpc/procedures/system.procedure.ts` —
  `sshResetPasswordProcedure`.
- `apps/frontend/src/main/Auth.svelte` — first-boot password wizard.
- `apps/frontend/src/main/dialogs/PasswordDialog.svelte` — password change
  dialog.
- `image-building-pipeline/docs/partition-contract.md` §6 — the `/data`
  partition contract (`/data/ceralive/config.json` as the canonical persistent
  path).
- `image-building-pipeline/v2/docs/ssh-hardening.md` — production/debug SSH
  hardening model, default-credentials section (owns the fix for the
  inconsistency noted in §5 above — not modified by this document).
