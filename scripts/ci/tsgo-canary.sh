#!/usr/bin/env bash
# NON-BLOCKING canary: can svelte-check typecheck this app through the native
# Go compiler (tsgo) yet?
#
# The workspace stays on TypeScript 6 because svelte-check 4.x refuses to start
# on TS 7 (bin/ts-version-check.js; peer range "^5.0.0 || ^6.0.0"). Its own
# error text prescribes the side-by-side install this script performs:
#   npm install --save-dev typescript@~6 @typescript/native@npm:typescript@7
# `@typescript/native` is an npm ALIAS onto the real typescript@7 package — NOT
# the `@typescript/native-preview` nightly channel. Use plain `--tsgo`; the
# `--tsgo-experimental-api` mode has a Bun-specific failure
# (sveltejs/language-tools#3095) that would misattribute this canary's verdict.
#
# `--no-save` keeps package.json and bun.lock untouched, so the required gates
# that run `bun install --frozen-lockfile` are unaffected. No npx (Bun-only
# repo); no bare `bun tsc` (oven-sh/bun#37152).
#
# The canary uses tsconfig.tsgo.json rather than tsconfig.app.json: tsgo writes
# a real tsconfig for the checked project and rejects `composite: true` next to
# svelte-check's own `incremental: false`, which would stop the run before any
# type is checked.
set -euo pipefail

cd "$(dirname "$0")/../.."

# `packages/i18n/generated/` is gitignored codegen (`@ceraui/i18n/eager`,
# `generated/registry.js`), so a fresh checkout has none of it and svelte-check
# reports 8 unresolved-module/implicit-any errors that say nothing about tsgo.
# Every required gate generates it first (`check`/`test`/`build` all chain
# `generate:i18n`); the canary has to as well or its signal is pure noise.
bun run --filter @ceraui/i18n generate:i18n

bun add --no-save --cwd apps/frontend "@typescript/native@npm:typescript@7"

cd apps/frontend
exec bun run --bun svelte-check --tsconfig ./tsconfig.tsgo.json --tsgo
