<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FEDERATION SIGNING (Task 40) [EXISTS]

`scripts/sign-federation.ts` (CeraUI root, run via `bun run sign:federation`) is the post-build
step that signs the `build:federation` output. Run it AFTER `build:federation`
(`bun run build:federation && bun run sign:federation`). For every emitted `.js` and `.css` asset in
`dist/federation/<ceraui-version>/` it emits the artifacts the version-federation contract
(root `AGENTS.md` → version-federation) requires, then writes + signs the manifest the cloud
consumes.

- **Per asset** (entries, shared JavaScript chunks, and `frontend.css`):
  `<file>.sri` (the `sha384-…` Subresource-Integrity hash, base64) +
  `<file>.sig` (a **GPG** detached signature).
- **`manifest.json`**: the EXACT shape `FederationManifestSchema` enforces —
  `{ ceraUiVersion, files: [{ filename, integrity, kind, imports }] }`. Do NOT change this shape; the cloud
  consumer (`ceralive-platform apps/api/lib/federation/manifest-verify.ts`) parses it.
- **`manifest.json.sig`**: a base64 **Ed25519** detached signature over the EXACT manifest
  bytes — **NOT GPG**. The cloud verifies it with `verifyAndParseManifest`
  (`verify(null, …)`, PEM SPKI public key) BEFORE trusting any SRI hash inside the manifest.
- **Two mechanisms, by design** (federation-security-design.md §3–4): bundles use GPG because
  apt-worker already GPG-verifies them at the R2 upload boundary (Task 41); the manifest uses
  raw Ed25519 because the cloud trust gate (Task 42) is dependency-free `node:crypto` — a GPG
  manifest signature could not be verified there.
- **Keys (fail-closed; never auto-generated)**: `GPG_SIGNING_KEY` (base64 ASCII-armored private
  key → imported into a throwaway GNUPGHOME) **or** a pre-imported keyring; optional
  `GPG_SIGNING_KEY_ID` (default = first secret key, no hardcoded id) + `GPG_SIGNING_KEY_PASSPHRASE`.
  `FEDERATION_MANIFEST_PRIVATE_KEY` (Ed25519, PEM PKCS8 or base64 of the PEM) signs the manifest;
  optional `FEDERATION_MANIFEST_PUBLIC_KEY` (PEM SPKI) is cross-checked at verify time. No private
  key is ever committed.
- **Self-verifying**: after signing the script GPG-verifies every bundle, recomputes each SRI
  against the manifest + `.sri` file, and Ed25519-verifies `manifest.json.sig`. `--verify-only`
  re-runs just the verification pass against existing artifacts (CI gate seam).

