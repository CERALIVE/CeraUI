<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## IMPORT PATHS

```typescript
import { m, setLocale, getLocale } from '@ceraui/i18n/svelte';    // frontend — the facade
import { formatBytes } from '@ceraui/i18n/formatters';             // anywhere
import { LOCALES, RTL_LANGUAGES } from '@ceraui/i18n';             // locale constants
import { registerAllNamespaces } from '@ceraui/i18n/eager';        // standalone builds ONLY
```

`m` is keyed on the **verbatim dotted key**: `m["live.setup.title"]()`. There is no
`/node` subpath and no legacy adapter subpath.

`/eager` is the fourth entry and is NOT for the app. Every namespace is lazy (see
below), and the SPA resolves them in two phases — `ensureBootNamespaces()` before
mount, then `ensureNamespace()`/`ensureNamespaces()` at each destination's
activation point (`apps/frontend/src/lib/i18n/namespace-activation.ts`).
`/eager` registers the whole catalog from STATIC imports instead,
for a build that cannot fetch a sibling chunk: the federation dialog bundles (one
hosted module, strict CSP, signed manifest pinning an exact chunk graph) and the
test harnesses — `packages/i18n/tests/setup.ts` here, and
`apps/frontend/vitest.components.setup.ts` there.

**The frontend now has TWO setup files, and only one of them touches this
package.** `apps/frontend/vitest.storage.setup.ts` installs a fresh `Storage` per
file and is loaded by BOTH Vitest projects; `apps/frontend/vitest.components.setup.ts`
is loaded by the jsdom `components` project alone and is the ONLY one of the pair
that imports `/eager`. So a test in the rune-free `pure` project runs with an
unregistered catalog by construction — the import-graph classifier
(`scripts/ci/vitest-classify.mjs` at the CeraUI root) already routes anything reaching
Svelte or the DOM into `components`, so a spec that renders copy belongs there.
`apps/frontend/vitest.federation.config.ts` loads both, storage first.

Importing `/eager` from app code re-fuses the ten-locale catalog into the entry
chunk — a measured ~400 KB gzip regression.

`registerAllNamespaces()` is idempotent per eager-module/registry instance. The
three federation entries may initialize the same static graph, so only the first
successful call writes the catalog. The memo is module-local, not process-global:
a fresh isolated registry must still be populated. A failed registration is not
memoized. `tests/eager-registration.test.ts` pins all three properties.

