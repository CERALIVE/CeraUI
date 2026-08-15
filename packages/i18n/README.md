# @ceraui/i18n

CeraUI's translation catalogs and runtime. Ten locales, full RTL support.

The package is mid-migration: **Paraglide** is the runtime the frontend is moving
onto, and the legacy **typesafe-i18n** adapter still ships beside it until the
call-site codemod and generator retirement land. Both read the same strings.

---

## Export map

| Import path | What it is |
|---|---|
| `@ceraui/i18n` | Locale constants — `LOCALES`, `RTL_LANGUAGES`, `BASE_LOCALE`, `directionFor`, `isSupportedLocale`, `resolveInitialLocale`. Plus the legacy typesafe-i18n surface, which retires with the generator. |
| `@ceraui/i18n/formatters` | Standalone `Intl` formatters (`formatBytes`, `formatBitrate`, …). **Unchanged by the migration** — no i18n runtime dependency, safe to import anywhere. |
| `@ceraui/i18n/svelte` | The Paraglide runes store and the `m` message facade. The ONE module frontend call sites import. |
| `@ceraui/i18n/i18n-svelte5` | The legacy typesafe-i18n Svelte 5 adapter (`LL`, `locale`, `setLocale`). Deliberately still reachable; every import of it is removed by the call-site codemod. |

There is no `/node` subpath. Nothing imported it, so it was retired; the one
symbol still wanted by tests, `loadLocale`, is re-exported from the root.

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
Every namespace ships **eager** today: registered at module init, so first paint
has no dictionary fetch and no flicker.

Flipping one to lazy is a config change in `LAZY_NAMESPACES`
(`scripts/generate-registry.ts`) plus an `ensureNamespace()` call at the
destination or dialog that owns it:

```ts
await ensureNamespace("devtools");   // before the view renders
```

**No call site changes.** Components keep the same synchronous `m["ns.key"]()`
call in both configurations — proven end to end by
`apps/frontend/src/tests/i18n-lazy-namespace.test.ts`, which builds the same
fixture twice and asserts the lazy namespace's messages leave the initial chunk.

Under Vite 8 / rolldown this is the **only** lever that splits the i18n bundle: a
`manualChunks` name is advisory, and anything statically reachable from the entry
is fused into one initial chunk regardless of how it is named.

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

`messages/*.json` are still **generated** from the legacy TypeScript dictionaries
in `src/<locale>/index.ts` by `scripts/convert-catalog.ts`, and a byte-parity gate
holds the two in lockstep. Until the legacy dictionaries are removed, edit
**those**; after that the JSON catalogs become the canonical, hand-editable
source.

---

## Tests

```bash
bun test packages/i18n
```

| File | Proves |
|---|---|
| `locale-parity-gate.test.ts` | The key set is identical across all ten locales. |
| `plural-parity-gate.test.ts` | Plural rendering matches the frozen oracle. |
| `paraglide-catalog-gate.test.ts` | The converted catalog carries every key, with no module-id collisions. |
| `paraglide-reverse-render-gate.test.ts` | Every converted message renders byte-identically to the legacy runtime. |
| `locale-lifecycle.test.ts` | Startup priority, RTL direction, unsupported-locale fallback. |
| `message-registry.test.ts` | The namespace map matches the emitted modules; `resolveMessageKey`'s fallback semantics. |

Frontend-side, `apps/frontend/src/tests/` adds the locale-store DOM contract, the
umbrella-import gate, and the lazy-namespace proof.
