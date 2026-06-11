# Vendored packages

## `@ceralive/cerastream`

`ceralive-cerastream.tgz` is the packed `@ceralive/cerastream` control-IPC
contract package (the cerastream Rust engine's TypeScript bindings). The
filename is intentionally version-agnostic so the `file:` reference stays stable
across CalVer bumps of the upstream package — only the tarball contents change.

It is consumed as a **plain npm dependency** (`file:` tarball), **not** a sibling
`link:` — unlike `@ceralive/srtla`. This is a deliberate
break from the sibling-link pattern (cerastream ARCHITECTURE §7 / ADR-0002
Decision 13): cerastream ships to CeraUI as a CI-published npm package, so the
backend must build standalone with **no sibling checkout** (Rule D).

Until the package is published to the registry, the built tarball is vendored
here so `pnpm install` / `bun test` resolve it offline and reproducibly. The
global `dist/` gitignore rules out committing an unpacked directory, so the
single `.tgz` artifact is the committable, self-contained form.

Regenerate (from a sibling `cerastream/` checkout) after a bindings change:

```bash
cd cerastream/bindings/typescript && bun install && bun run build
bun pm pack --destination /tmp
cp /tmp/ceralive-cerastream-*.tgz CeraUI/apps/backend/vendor/ceralive-cerastream.tgz
cd CeraUI && pnpm install   # re-extract the refreshed tarball
```
