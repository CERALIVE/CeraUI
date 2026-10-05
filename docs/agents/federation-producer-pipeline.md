<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FEDERATION PRODUCER PIPELINE [EXISTS]

CeraUI is the **producer** of the version-federation dialog bundles consumed by
`ceralive-platform`'s web dashboard. The full contract lives in root
[`AGENTS.md`](https://github.com/CERALIVE/CeraUI/blob/main/AGENTS.md) → "Version-federation hosting/signing contract". This
section documents the build, sign, and upload steps that CeraUI owns.

### What gets built

Three Vite lib-mode ES-module bundles — one per config dialog:

| Bundle | Entry point |
|--------|-------------|
| `encoder.js` | `apps/frontend/src/lib/federation/encoder-entry.ts` |
| `audio.js` | `apps/frontend/src/lib/federation/audio-entry.ts` |
| `server.js` | `apps/frontend/src/lib/federation/server-entry.ts` |

Each entry exports `federationAbiVersion = 1` and
`mountDialog(target, { host, config, locale })`. `locale` is ADDITIVE and OPTIONAL,
so the ABI stays 1: a bundle carries its OWN copy of the Paraglide runtime, whose
active locale is a module-level binding the host cannot otherwise reach, so a host
that omits it gets the base locale exactly as before. Each entry also calls
`registerFederationMessages()` (`lib/federation/messages.ts`) at module scope —
the SPA resolves its message catalog from lazily-imported per-namespace chunks,
whereas federation registers the catalog statically via `@ceraui/i18n/eager`.
Federation uses an isolated Paraglide `locale-modules` output and full output
minification; its message imports and locale-runtime shim resolve together through
`vite.federation-i18n.ts`. All keys/locales remain inside the signed static graph,
and the SPA's direct imports and lazy message-module output are unchanged.
`bun scripts/ci/bundle-report.mjs` checks both built outputs without widened
ceilings; the built federation harness also checks full-catalog fixture parity.
The wrapper uses its bundled Svelte
runtime to mount and unmount the dialog, so the host never mounts a component
compiled against a different Svelte runtime. `host` is the typed adapter in
`host-contract.ts`; all three dialogs treat a resolved `{ success: false }` host
write as a visible save failure. Audio and Server retain their device-local RPC
fallback, while Encoder reports asynchronous hosted write refusal through the
same localized failure toast.

### Build step: `bun run build:federation`

Runs Vite in lib mode with a dedicated config
(`apps/frontend/vite.federation.config.ts`). Output lands in:

```
dist/federation/<ceraui-version>/
  encoder.js
  audio.js
  server.js
  <shared chunks>.js
  frontend.css
  federation-build.json
```

The version is read from `package.json` at build time. The output directory is
gitignored and never committed.

### Sign step: `bun run sign:federation`

Runs `scripts/sign-federation.ts`. The Vite build manifest supplies the static
import graph. For every emitted `.js` and `.css` asset:

1. Computes a `sha384-` SRI hash and writes `<file>.sri`.
2. GPG-signs the asset and writes `<file>.sig`.
3. Writes `manifest.json` with every entry, chunk, stylesheet, kind, import edge,
   SRI hash, and CeraUI version.
4. Ed25519-signs the exact manifest bytes as `manifest.json.sig`.

The GPG key is the same CeraLive release key used for `.deb` signing (managed in
`cert-work/`). The Ed25519 key used for PASETO tokens is NOT used here.

### CI publish job: `publish-federation` (in `publish-release.yml`)

Runs in the normal `publish-release.yml` path after the release/package gate
confirms that `package.json` matches the calculated release version and passes
frozen install, lint/typecheck, and unit tests. Releases run only from the
default branch, reject a pre-existing tag/release, and pin and verify
the release tag against the workflow dispatch SHA. The federation job independently
re-verifies the version match before building; for v2026.7.0 it publishes
`ui-bundle/2026.7.0/`. Steps:

1. `bun run build:federation` — produces `dist/federation/<version>/`
2. `bun run sign:federation` — produces `.sri` + `.sig` + `manifest.json`
3. Uploads every signed JS/CSS asset and sidecar plus the signed manifest to R2
   at `ui-bundle/<ceraui-version>/` with pinned content types.
4. `publish-federation-immutable.sh` uses conditional `PutObject` writes and a
   digest of the signed payload set. An identical retry preserves existing
   objects (including earlier valid signature bytes), a changed payload fails
   before any write, and a failed fresh publish removes only objects created by
   that attempt.

`create-release` remains downstream of `publish-federation`, so a public GitHub
release is created only after the complete immutable R2 version is present. If
release creation fails afterward, a same-version retry is idempotent and can
reuse the already-published bytes.

The `apt-worker` serves these files at
`https://apt.ceralive.tv/ui-bundle/<ceraui-version>/<file>`. See
[`../apt-worker/AGENTS.md`](https://github.com/CERALIVE/CeraUI/blob/main/apt-worker/AGENTS.md) for the serving contract.

### Support window

Bundles are served for 6 months after their release date. Devices running a CeraUI
version older than 6 months receive a read-only gate in the platform dashboard. The
platform checks `ceraui-version` at session start; out-of-window devices get
`{ gated: true, reason: "ceraui_version_unsupported" }` from `/api/device/session`.

### Where to look

| Task | Location |
|------|----------|
| Vite federation build config | `apps/frontend/vite.federation.config.ts` |
| ABI and host adapter | `apps/frontend/src/lib/federation/` |
| Sign + SRI script | `scripts/sign-federation.ts` |
| CI publish workflow | `.github/workflows/publish-release.yml` (`publish-federation` job) |
| Bundle output (gitignored) | `dist/federation/<version>/` |
| ABI harness (mounts the BUILT bundles) | `apps/frontend/tests/federation/federation-abi.test.ts` via `bun run test:federation-abi` |
| Full hosting/signing contract | root `AGENTS.md` → "Version-federation hosting/signing contract" |
| Serving route (apt-worker) | [`../apt-worker/AGENTS.md`](https://github.com/CERALIVE/CeraUI/blob/main/apt-worker/AGENTS.md) |

