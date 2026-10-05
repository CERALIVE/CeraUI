<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FEDERATION LIB BUILD (Task 39) [EXISTS]

`vite.federation.config.ts` is a SEPARATE Vite lib-mode build (not the SPA `vite.config.ts`)
that emits the Encoder/Audio/Server config dialogs as standalone ES-module bundles for the
version-federation hosting/signing contract (root `AGENTS.md` → version-federation). It runs
via `bun run build:federation` from the CeraUI root (delegates to the frontend
`build:federation` script).

- **Entries**: `src/lib/federation/{encoder-entry,audio-entry,server-entry}.ts` →
  `dist/federation/<ceraui-version>/{encoder,audio,server}.js` (`formats: ["es"]`,
  per-entry `fileName`). Each wrapper exports `federationAbiVersion` and
  `mountDialog`, owns the bundled Svelte mount/unmount lifecycle, and receives
  the typed host adapter. Shared graph code is split into sibling chunks
  co-located at the same versioned path.
- **`<ceraui-version>`** is read at build time from the workspace-root `package.json` `version`
(CalVer, `2026.9.4` at time of writing) — the single source of truth, matching the platform's
  `ceraui-version` claim.
- **The catalog is STATIC here, not lazy.** Each entry still calls
  `registerFederationMessages()` (`@ceraui/i18n/eager`) at module scope and
  `applyFederationLocale(options.locale)` at mount. Federation alone compiles
  Paraglide with `outputStructure: "locale-modules"` into
  `node_modules/.cache/federation-i18n`; `vite.federation-i18n.ts` routes the
  generated barrels' direct message imports AND the runtime shim to that output.
  All keys and ten locales remain bundled, with no externals or new catalog
  chunks. The SPA keeps its direct imports, message-module compiler output and
  lazy namespaces unchanged. Never route only messages: a second locale runtime
  would ignore the host's locale. The final hosted artifacts use full Rolldown
  output minification rather than ES-library whitespace preservation.
- **Size and parity gates:** after building both outputs, run
  `bun scripts/ci/bundle-report.mjs` from the root. All existing ceilings remain
  unchanged; `sources-view-model` is the existing Audio/Encoder shared projection,
  now explicitly baselined. The federation harness also renders every locale
  module against the frozen catalog fixtures (`federation-catalog.test.ts`).
- **Isolation**: this build NEVER touches the SPA `dist/public` output, runs no
  PWA/service-worker plugin, and emits no `index.html`. The SPA `vite.config.ts` is unmodified.
- **CI ordering caveat**: the backend `build` script does `rm -rf ../../dist/`, so
  `build:federation` MUST run AFTER `bun run build` (the full SPA/backend build) — never before,
  or its output is wiped.

