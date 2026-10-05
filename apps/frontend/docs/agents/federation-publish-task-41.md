<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FEDERATION PUBLISH (Task 41) [EXISTS]

The `publish-federation` job in `.github/workflows/publish-release.yml` is the release-triggered
CI job that uploads the signed bundles to R2. Pipeline (each step gates the next):
`bun run build:federation` → `bun run sign:federation` (sign + self-verify) →
`bun run sign:federation -- --verify-only` (independent re-verify before any write) →
`publish-federation-immutable.sh` conditional writes to
`s3://$R2_BUCKET/ui-bundle/<ceraui-version>/`.

- **Fail-closed**: `sign-federation.ts` errors when a signing key is absent, so a missing GPG /
  Ed25519 secret blocks publish — bundles are never uploaded unsigned/unverified.
- **Version**: `<ceraui-version>` is read from `package.json` (`bun -p`) — the same source
  `build:federation` + `sign-federation.ts` use, so the R2 path matches `dist/federation/<version>`
  and the manifest's `ceraUiVersion`.
- **Immutable + idempotent**: each R2 write uses `If-None-Match: *` and carries a
  release digest derived from the signed payload set. Existing objects are
  accepted only for that same digest; non-signature bytes are compared directly.
  A changed payload fails before writes, partial writes resume safely, and a
  failed fresh attempt rolls back only keys it created. `create-release` depends
  on this job, so public release creation cannot precede the complete R2 version.
- **Content-types pinned per file** (must match the apt-worker route, see `apt-worker/AGENTS.md`):
  `.js` → `application/javascript`, `.css` → `text/css`, `.sri` → `text/plain`,
  `.sig`/`manifest.json.sig` → `application/octet-stream`, `manifest.json` →
  `application/json`. The `*.js` glob includes the
  code-split shared chunks (rpc, subscriptions, input) — they must upload alongside the dialog
  bundles so dynamic `import()` resolves under the platform CSP.
- **Secrets**: `FEDERATION_GPG_SIGNING_KEY` (+ optional `_ID`/`_PASSPHRASE`),
  `FEDERATION_MANIFEST_PRIVATE_KEY` (+ optional `FEDERATION_MANIFEST_PUBLIC_KEY`),
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET`. The job runs with
  `permissions: contents: read`; the workflow's `cancel-in-progress: false` applies (never cancel
  a mid-publish run).

