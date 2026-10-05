<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## ROLE IN THE GROUP

Device control plane. Svelte 5 PWA (frontend) + Bun/TypeScript WebSocket-RPC backend. Drives `cerastream` (active engine) and the `srtla` sender (`srtla_send`) at runtime. Produces the `ceraui` .deb for ARM64 and AMD64 device images.

**Single engine.** `@ceralive/cerastream` is the ONLY streaming engine, consumed
as a public-npm registry dep. The legacy ceracoder engine and its sibling `link:`
dependency are fully retired (legacy `engine` values persisted in device
setup.json are coerced to `"cerastream"` at parse time with a warning).

The backend resolves both streaming deps as public-npm registry packages — no sibling checkout, no vendored tarball:

```
"@ceralive/cerastream":  "2026.9.11"   (public npm, @ceralive scope)
```

It is a published npm package (`@ceralive` scope on npmjs.org) consumed as a normal registry dep, not a `link:` path and not a vendored `.tgz`. No sibling checkout of the `srtla` receiver or sender repositories is needed for `CeraUI` to install or build.

The **sender binding is no longer a registry dep at all**: it was absorbed into
this monorepo as the private workspace package `packages/srtla-send`
(`@ceraui/srtla-send`, consumed by the backend as `workspace:*`). It is never
published. The `srtla_send` BINARY remains an external artifact — only its
TypeScript helper layer moved here.

