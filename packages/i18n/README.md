# @ceraui/i18n

CeraUI's translation catalogs and runtime. Ten locales, full RTL support.

**Paraglide is the sole i18n runtime.** The legacy generator, its Svelte 5
adapter, its plural resolver, and the TypeScript locale dictionaries are gone —
`messages/*.json` are now the canonical, hand-editable translation source (see
[Catalogs](#catalogs--the-operator-workflow)).

---

## Export map

| Import path | What it is |
|---|---|
| `@ceraui/i18n` | Locale constants — `LOCALES`, `RTL_LANGUAGES`, `BASE_LOCALE`, `directionFor`, `isSupportedLocale`, `resolveInitialLocale`. |
| `@ceraui/i18n/formatters` | Standalone `Intl` formatters (`formatBytes`, `formatBitrate`, …). No i18n runtime dependency at all — safe to import anywhere, backend included. |
| `@ceraui/i18n/svelte` | The Paraglide runes store and the `m` message facade. The ONE module frontend call sites import. |
| `@ceraui/i18n/eager` | `registerAllNamespaces()` — the whole catalog from static imports. For a build that cannot fetch a sibling chunk (the federation bundles) and for test harnesses. **Never import it from app code**: it re-fuses the catalog into the entry chunk. |

There is no `/node` subpath and no legacy adapter subpath — both retired with the
generator.

---

## Rendering a message

```ts
import { m } from "@ceraui/i18n/svelte";

m["live.setup.title"]();                    // "Stream setup"
m["live.setup.linksReady"]({ count: 2 });   // "2 links ready"
m["live.setup.title"](undefined, { locale: "ar" });  // render in an explicit locale
```

Keys are the **verbatim dotted keys** from the catalog — bracket access, not
property access, and never renamed. Calls are synchronous, and reading any
message inside a Svelte template subscribes that template to the active locale,
so a locale switch re-renders with no store subscription and no `await`.

When the key is only known at runtime (a backend-emitted `labelKey`):

```ts
import { resolveMessageKey } from "@ceraui/i18n/svelte";

resolveMessageKey(source.labelKey, { count });  // unknown key -> the key itself
```

An unknown key is returned **as itself**, never thrown and never rendered empty.

---

## Switching locale

```ts
import { initLocale, setLocale, getLocale } from "@ceraui/i18n/svelte";

initLocale({ saved: persistedLocale?.code });  // startup
setLocale("ar");                                // operator switch
getLocale();                                    // reactive read
```

- **Startup priority** is saved preference → `navigator.language` → `en`. A saved
  value naming no shipped locale falls back with a `console.warn` rather than
  looking like a first run.
- **`setLocale` owns the DOM.** Paraglide calls its own
  `setLocale(next, { reload: false })` a "narrow escape hatch": it updates the
  runtime locale and nothing else — no re-render, no `<html lang>`, no
  `<html dir>`. This store does all three. `<html dir="rtl" lang="ar">` is a
  contract the e2e locale-parity spec asserts directly.
- **Direction comes from `RTL_LANGUAGES`**, not Paraglide's `getTextDirection()`.
  The two agree for `ar` today, but our list also carries languages CeraUI has
  not shipped yet, and swapping the source silently is not a free change.
- **Persistence lives in the app**, not here: `apps/frontend/src/lib/stores/locale.svelte.ts`
  (`$persist`, key `"locale"`). A package under `packages/` may not reach into an
  app, so `initLocale` takes the saved code as an argument.

---

## Generated code

```bash
bun run --filter @ceraui/i18n generate:i18n   # compile + generate, one command
```

It runs as the first step of the frontend `check`, `test`, `build`, and
`build:federation` chains, so a clean worktree never fails on missing modules.

Two directories are generated and **gitignored — never hand-edit, never commit**:

| Path | Produced by | Contents |
|---|---|---|
| `src/paraglide/` | `scripts/compile-messages.ts` | Paraglide's compiled runtime, one module per message (`outputStructure: "message-modules"`). |
| `generated/` | `scripts/generate-registry.ts` | Per-namespace barrels, the dotted-key → module map, the loader config, and the registry backing `m`. |

### Why the registry exists

Paraglide's umbrella `paraglide/messages.js` re-exports **every** message
eagerly, so importing it pulls the whole catalog into whatever chunk touches i18n
and makes lazy loading impossible by construction. Nothing outside the generated
barrels may import it, and a test gate fails the build if anything does.

The registry is also what makes `m["a.b.c"]` work at all: Paraglide's own exports
resolve bracket access against nothing unless every per-message module has
already been imported.

### Namespaces and lazy loading

A message's **namespace** is its first dotted segment (`live.setup.title` → `live`).

**Every namespace is lazy.** `EAGER_NAMESPACES` (`scripts/generate-registry.ts`) is
empty, so each namespace becomes its own chunk. The app resolves them in two
phases, owned by `apps/frontend/src/lib/i18n/namespace-activation.ts`:

```ts
await ensureBootNamespaces();   // main.ts, before mount(App)
```

The boot set is every namespace **first paint can read** — the auth gate, layout
chrome, nav, HUD, toasts, PWA/offline pages, shared dialog chrome, the shell stores
that render copy of their own, and the DEFAULT `live` destination's own view. That
await is what keeps first paint atomic: no view observes a half-populated registry,
so no string can flash as its own dotted key.

Everything a single non-default destination owns is resolved at that destination's
activation point instead, the same way the config dialogs load on first open:

```ts
await ensureNamespaces(["advanced", "wifiSelector"]);   // before the view renders
await ensureNamespace("devtools");                       // one namespace
```

`NavigationRenderer` does this for each destination and holds the view behind the
existing transition spinner until it resolves; already-loaded namespaces resolve
SYNCHRONOUSLY, so a navigation never pays a promise tick for nothing.

**`ensureAllNamespaces()` is not the boot path** — it remains for harnesses and
full-catalog consumers. Awaiting it before mount serialises first paint behind all
31 namespaces, which is what this split removed.

**No call site changes** in either configuration — components keep the same
synchronous `m["ns.key"]()` call, proven end to end by
`apps/frontend/src/tests/i18n-lazy-namespace.test.ts`.

Under Vite 8 / rolldown this is the **only** lever that splits the i18n bundle: a
`manualChunks` name is advisory, and anything statically reachable from the entry
is fused into one initial chunk regardless of how it is named. A compiled Paraglide
message inlines all ten locales, so the all-eager catalog was one ~400 KB gzip blob
in the entry chunk; splitting it took the entry chunk below its own pre-migration
size and cut the emitted total too (per-namespace chunks compress better than one
fused megachunk).

The dev-only `devtools` namespace is additionally emptied in PRODUCTION builds
(`devOnlyI18nNamespacePlugin`, `apps/frontend/vite.i18n.ts`): its only consumers sit
behind `import.meta.env.DEV`, so Rollup prunes them and the 132 keys × 10 locales
were unreachable payload.

---

## Catalogs — the operator workflow

Translations live in `messages/<locale>.json`, keyed by the verbatim dotted key:

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "live.setup.title": "Stream setup",
  "advanced.sshPassword": "Password for {sshUser}"
}
```

A message with plural variants is an **array whose `[0]` is the variant object**
(`declarations` / `selectors` / `match`) — that is the shape the inlang
message-format plugin reads.

### Add a key

1. Add it to `messages/en.json` (`en` is the base locale; a key absent there does
   not exist).
2. Add the same key to the other nine files. The locale-parity gate fails on a
   key set that differs between locales.
3. `bun run --filter @ceraui/i18n generate:i18n`
4. Use it: `m["your.new.key"]()`.

### Add a locale

1. Add the code to `locales` in `project.inlang/settings.json`.
2. Add it to `LOCALES` in `src/locale-lifecycle.ts` (name + flag). If it is
   right-to-left, add it to `RTL_LANGUAGES` too.
3. Create `messages/<locale>.json` with the full key set.
4. `bun run --filter @ceraui/i18n generate:i18n`

### Catalog source of truth

**`messages/<locale>.json` IS the source of truth. Edit it by hand.** Nothing
generates it, and nothing else holds a second copy of a translated string — the
TypeScript locale dictionaries it was converted from, and the converter that read
them, are both deleted.

The only never-hand-edited i18n artifacts are the two build outputs Paraglide and
the registry generator write, `src/paraglide/` and `generated/`. Both are
gitignored and both are rebuilt by `generate:i18n`, which runs ahead of every
`check` / `test` / `build` / `build:federation`.

`tests/fixtures/*.rendered.json` is a third category again: the IMMUTABLE oracle
frozen from the pre-migration implementation. It is not generated (the generator
that captured it retired with the runtime it rendered through) and it is not
hand-editable copy either — a deliberate translation change updates it in its own
separately-reviewed PR, together with the catalog string it re-freezes.

---

## Tests

```bash
bun run --filter @ceraui/i18n test
```

That script runs `generate:i18n` first, so the suite is runnable from a clean
checkout — several gates render through the generated registry.

| File | Proves |
|---|---|
| `locale-parity-gate.test.ts` | The key set is identical across all ten locales, and every entry has a renderable shape. |
| `plural-parity-gate.test.ts` | Plural rendering matches the frozen oracle, and every variant set covers exactly its locale's CLDR categories with the catch-all last. |
| `svelte-adapter-plural.test.ts` | The store facade (`m`) renders every plural key byte-identically to the frozen oracle; retired legacy grammar stays absent from the catalogs. |
| `server-plural.test.ts` | `live.server.bondedAcross` renders the exact singular/plural English copy. |
| `translation-quality.test.ts` | The keys added by todos 6/10-13 are real per-locale translations with no interpolation residue. |
| `backend-labelkey-contract.test.ts` | Every dotted key the backend can emit as data resolves in the `en` catalog. |
| `paraglide-catalog-gate.test.ts` | The catalog carries every key, with no safe-module-id collisions, and paraglide emitted exactly one module per key. |
| `paraglide-reverse-render-gate.test.ts` | Every compiled message renders byte-identically to the frozen oracle. |
| `locale-lifecycle.test.ts` | Startup priority, RTL direction, unsupported-locale fallback. |
| `message-registry.test.ts` | The namespace map matches the emitted modules; `resolveMessageKey`'s fallback semantics. |

"Old render === new render" is proven against ONE immutable fixture set. Its OLD
side — `rendered-oracle-gate.test.ts`, which re-rendered through the pre-migration
runtime — retired with that runtime; what it asserted is preserved in the frozen
fixtures themselves, which `plural-parity-gate` and `paraglide-reverse-render-gate`
still diff every compiled message against. Shared readers for the catalogs and the
fixtures live in `tests/helpers/catalog.ts` and import no message runtime.

Frontend-side, `apps/frontend/src/tests/` adds the locale-store DOM contract, the
umbrella-import gate, and the lazy-namespace proof. Copy-asserting frontend tests
read the catalogs through `apps/frontend/src/tests/helpers/catalog.ts`, which
re-nests the flat dotted keys so path-style assertions stay unchanged.
