# Plural & interpolation grammar inventory

**Status:** frozen 2026-08-14 against `packages/i18n/src/<locale>/index.ts` at
commit `2b9051b8` (branch `chore/deps-orpc2-ts7spike-2026-08`).
**Purpose:** this is the CONVERSION SPEC for the typesafe-i18n → Paraglide
(inlang message-format) catalog converter. Every grammar form the 10 shipped
dictionaries actually use is enumerated below with cited `file:line` examples and
counts, together with the forms the runtime SUPPORTS but no dictionary uses.

The converter is only required to handle §1–§3 (present forms). §4 lists what it
may safely refuse to parse — but it must FAIL LOUDLY on encountering any of them
rather than silently mis-convert, because a future dictionary edit could
introduce one.

Companion artifact: `packages/i18n/tests/fixtures/<locale>.rendered.json` — the
frozen rendered output of every key × locale, which the converted catalog must
byte-match. Parameters used for that render are in
`packages/i18n/tests/fixtures/params/<locale>.params.json`.

---

## 0. Catalog shape (all 10 locales)

| Fact | Value |
|---|---|
| Locales | `en` (base), `ar`, `de`, `es`, `fr`, `hi`, `ja`, `ko`, `pt-BR`, `zh` |
| Leaf keys | **1472 per locale, identical key set in all 10** |
| Non-string leaves | **none** — every leaf is a plain string (no arrays, no numbers, no functions) |
| Keys carrying plural syntax | 3 in each of `en`/`ar`/`de`/`es`/`fr`/`hi`/`pt-BR`; **0** in `ja`/`ko`/`zh` |
| Keys carrying interpolation params | 67 (`en`) |
| Formatters (`{value\|formatter}`) | **none** — the generated `Formatters` type is `{}` (`src/formatters.ts:1-19`) |

The three plural-bearing keys are the SAME three in every locale that has any:

- `live.server.bondedAcross`
- `live.setup.linksReady`
- `live.ingest.linksReadyCount`

---

## 1. Plural forms PRESENT in the dictionaries

The runtime is `src/plural-resolver.ts` (`resolvePlurals` / `interpolate`), a
byte-exact mirror of `typesafe-i18n` 5.27.1's `parsePluralPart` + `getPlural` +
`applyArguments`. Branch selection is `Intl.PluralRules(locale).select(count)`,
with typesafe-i18n's special rule that a PRESENT `zero` branch wins for `0`.

### 1a. Unkeyed 2-branch — `{{one|other}}`

**Arity 2 ⇒ `{ o: <first>, r: <second> }`** (`plural-resolver.ts:84-85`). The
plural key is INHERITED from the preceding `{param}` token (`lastAccessor`,
`plural-resolver.ts:171-191`) — in every case below that is `count`.

| Locale | Key | file:line | Template |
|---|---|---|---|
| en | `live.server.bondedAcross` | `src/en/index.ts:346` | `Bonded across {count:number} {{link\|links}}` |
| en | `live.setup.linksReady` | `src/en/index.ts:432` | `{count:number} {{link\|links}} ready` |
| en | `live.ingest.linksReadyCount` | `src/en/index.ts:473` | `{count:number} {{link\|links}} ready to bond` |
| de | `live.server.bondedAcross` | `src/de/index.ts:357` | `Gebündelt über {count} {{Verbindung\|Verbindungen}}` |
| de | `live.setup.linksReady` | `src/de/index.ts:448` | `{count} {{Verbindung\|Verbindungen}} bereit` |
| de | `live.ingest.linksReadyCount` | `src/de/index.ts:489` | `{count} {{Link\|Links}} bereit zum Bündeln` |
| es | `live.server.bondedAcross` | `src/es/index.ts:357` | `Combinado en {count} {{enlace\|enlaces}}` |
| es | `live.setup.linksReady` | `src/es/index.ts:448` | `{count} {{enlace\|enlaces}} listos` |
| es | `live.ingest.linksReadyCount` | `src/es/index.ts:489` | `{count} {{enlace listo\|enlaces listos}} para agrupar` |
| fr | `live.server.bondedAcross` | `src/fr/index.ts:1233` | `Agrégé sur {count} {{lien\|liens}}` |
| fr | `live.setup.linksReady` | `src/fr/index.ts:1323` | `{count} {{lien\|liens}} prêts` |
| fr | `live.ingest.linksReadyCount` | `src/fr/index.ts:1364` | `{count} {{lien prêt\|liens prêts}} à agréger` |
| hi | `live.server.bondedAcross` | `src/hi/index.ts:1036` | `{count} {{लिंक\|लिंक}} पर बॉन्डेड` |
| hi | `live.setup.linksReady` | `src/hi/index.ts:1121` | `{count} {{लिंक\|लिंक}} तैयार` |
| hi | `live.ingest.linksReadyCount` | `src/hi/index.ts:1162` | `बॉन्डिंग के लिए {count} {{लिंक\|लिंक}} तैयार` |
| pt-BR | `live.server.bondedAcross` | `src/pt-BR/index.ts:1211` | `Agregado em {count} {{link\|links}}` |
| pt-BR | `live.setup.linksReady` | `src/pt-BR/index.ts:1301` | `{count} {{link\|links}} prontos` |
| pt-BR | `live.ingest.linksReadyCount` | `src/pt-BR/index.ts:1342` | `{count} {{link pronto\|links prontos}} para agrupar` |
| ar | `live.ingest.linksReadyCount` | `src/ar/index.ts:1301` | `{count} {{رابط جاهز\|روابط جاهزة}} للتجميع` |

**Count: 19 occurrences across 7 locales.** Branches may contain SPACES
(`enlace listo`, `lien prêt`, `link pronto`, `رابط جاهز`) — a converter that
tokenizes on word boundaries instead of on `|` will corrupt those.

### 1b. Unkeyed 6-branch — `{{zero|one|two|few|many|other}}`

**Arity 6 ⇒ `{ z, o, t, f, m, r }`** (`plural-resolver.ts:89`). Present in
Arabic only.

| Locale | Key | file:line | Template |
|---|---|---|---|
| ar | `live.server.bondedAcross` | `src/ar/index.ts:1175` | `مجمّع عبر {count} {{روابط\|رابط\|رابطين\|روابط\|رابطًا\|رابط}}` |
| ar | `live.setup.linksReady` | `src/ar/index.ts:1260` | `{count} {{روابط\|رابط\|رابطان\|روابط\|رابطًا\|رابط}} جاهزة` |

**Count: 2 occurrences, 1 locale.** Both exercise the zero-precedence rule in
§2c: their `zero` branch is non-empty, so `count === 0` selects it.

### 1c. Branch de-duplication is NOT collapsible

Arabic's 6-branch forms repeat the same word in several branches
(`روابط` appears at zero, few; `رابط` at one, other). The optimizer in
`parsePluralPart` (`plural-resolver.ts:92-101`) trims each branch and drops
EMPTY branches and the literal `"0"`, but never de-duplicates — so all six
positions must be emitted as six inlang variants even where two are textually
identical.

---

## 2. Runtime rules a converter MUST reproduce

### 2a. The plural key is INHERITED, never declared

Every plural in this catalog is UNKEYED. `parseRawText`'s rule
(`plural-resolver.ts:171-199`): the key is the LAST `{param}` token seen before
the `{{…}}` group; failing that, the FIRST param key in the whole template;
failing that, the positional index `"0"`. In all 21 occurrences the resolved key
is `count`, because `{count}` always precedes the group — including in
`hi.live.ingest.linksReadyCount` where prose precedes the param.

**Conversion:** emit inlang variants selecting on the variable `count`.

### 2b. TYPES LIVE ONLY IN `en` — every other locale is untyped

This is the single most important conversion hazard in the catalog.

| Locale | `{x:number}` | `{x:string}` | untyped `{x}` |
|---|---|---|---|
| `en` | 42 | 42 | **0** |
| `ar` / `de` / `hi` / `ja` / `ko` / `zh` | 0 | 0 | **86** |
| `es` / `fr` | 0 | 0 | **84** |
| `pt-BR` | 0 | 0 | **86** |

typesafe-i18n derives the param TYPE from the BASE locale only. A converter that
reads each locale's file in isolation will emit untyped inlang variables for 9 of
10 locales. **The type for a given dotted key must be sourced from `en` and
applied to every locale.** Cited pairs:

- `src/en/index.ts:346` `{count:number}` vs `src/de/index.ts:357` `{count}` — same key.
- `src/en/index.ts:896` `{attempt:number}/{maxAttempts:number}` — two number params in ONE string; order matters.

### 2c. Zero-precedence

`getPlural` (`plural-resolver.ts:110-113`): when a `zero` branch is PRESENT and
the value loosely equals `0` (`== 0`, matching both `0` and `"0"`), the `zero`
branch is selected regardless of what `Intl.PluralRules` says. Exercised by the
two Arabic 6-branch forms (§1b). Frozen values:
`ar.live.server.bondedAcross["0"] === "مجمّع عبر 0 روابط"`.

### 2d. `few`/`many` fall through to `other`; absent branches render EMPTY

`plural-resolver.ts:122-123` — `few` and `many` coalesce to `r` when absent.
Every OTHER category does not: `zero`, `one`, `two` return `undefined` when their
branch is absent, and `renderPluralPart` coalesces that to `""`
(`plural-resolver.ts:143`).

**This produces a real, currently-shipping Arabic defect that the converter MUST
REPRODUCE BYTE-FOR-BYTE.** `ar.live.ingest.linksReadyCount` is a 2-branch plural
(`{ o, r }` — no `z`, no `t`), but Arabic CLDR maps `0 → zero` and `2 → two`, so
both select an absent branch and render as an empty string:

```
ar.live.ingest.linksReadyCount["0"]  === "0  للتجميع"     (note the double space)
ar.live.ingest.linksReadyCount["2"]  === "2  للتجميع"
ar.live.ingest.linksReadyCount["1"]  === "1 رابط جاهز للتجميع"
ar.live.ingest.linksReadyCount["5"]  === "5 روابط جاهزة للتجميع"
```

A naive CLDR mapping in the converter will "fix" this by giving `zero`/`two` the
`other` text — a rendering CHANGE, which fails the zero-diff parity gate. The
migration's mandate is byte parity; correcting the Arabic copy is a SEPARATE,
separately-reviewed translation PR. Emit variants that reproduce the empty
branches.

### 2e. Fixed count set

The oracle renders every plural key at **{0, 1, 2, 5, 11, 100}** — the set that
hits every Arabic bucket: `0→zero, 1→one, 2→two, 5→few, 11→many, 100→other`.
Reverse-render verification must use the same set (it is recorded as `counts` in
`tests/fixtures/params/<locale>.params.json`).

---

## 3. Interpolation forms PRESENT

### 3a. Named params — the ONLY form used

`{name}` (untyped) and `{name:number}` / `{name:string}` (typed, `en` only).
Substituted by `interpolate`'s second pass (`plural-resolver.ts:221-224`) with
the regex `\{(\w+)(?::\w+)?\}` — AFTER plural resolution. An unknown param name
is left VERBATIM in the output (`value !== undefined ? String(value) : match`),
which is the behaviour §3c depends on.

Types used across the whole catalog: **`number` and `string` only** — no `Date`,
no boolean, no custom type. Example lines:
`src/en/index.ts:149` (`{count:number}`), `src/en/index.ts:1771`
(`{ssid:string}` + `{network:string}` in one string), `src/en/index.ts:898`
(`{nextAttempt:number}/{maxAttempts:number}`).

### 3b. NO positional, formatter, or optional syntax anywhere

Verified across all 10 files, zero occurrences of each:

| Form | Occurrences |
|---|---|
| positional `{0}` / `{1}` | 0 |
| formatter pipe `{value\|formatter}` outside a `{{…}}` group | 0 |
| optional `{x?:type}` | 0 |
| `{{s}}` suffix shorthand (arity 1) | 0 |
| keyed plural `{{key: a\|b}}` | 0 |
| 3-branch `{{zero\|one\|other}}` | 0 |
| `??` value injection | 0 |
| boolean-driven plural | 0 |

(The `{a|b}`-shaped substrings a naive grep finds are all the INNER halves of
`{{a|b}}` plural groups — see §1a.)

### 3c. Two keys where a non-`en` locale declares a param `en` does not

`wifiSelector.dialog.availableNetworks` and `wifiSelector.dialog.connectTo` are
param-free in `en` but carry `{network}` / `{ssid}` in **all 9 other locales**.
Because typesafe-i18n types call sites from `en`, no caller passes those params,
so on a device those locales render the literal `{network}` / `{ssid}`.

The frozen oracle deliberately renders each locale with ITS OWN template's
params (so the fixture shows `<network>` rather than the literal), because the
oracle's contract is "same key + same params ⇒ same output" and that choice is
strictly more discriminating: it proves the param survives conversion. The
underlying copy defect is **out of scope** for the migration — fix it in a
translation PR, not here.

---

## 4. Forms the RUNTIME supports but NO dictionary uses

`plural-resolver.ts:19-29` documents these; none appear in the catalog today. A
converter should FAIL LOUDLY (naming key + locale) rather than silently drop or
mis-convert one, so that a dictionary edit landing between now and the cutover
cannot slip through:

| Form | Resolver reference |
|---|---|
| `{{s}}` suffix shorthand (arity 1 ⇒ `{ r }`) | `plural-resolver.ts:82-83` |
| keyed plural `{{key: a\|b}}` (explicit key overrides `lastAccessor`) | `plural-resolver.ts:69-75` |
| 3-branch `{{zero\|one\|other}}` (arity 3 ⇒ `{ z, o, r }`) | `plural-resolver.ts:86-87` |
| `??` value injection inside the chosen branch | `plural-resolver.ts:39`, `143` |
| boolean-driven selection (`true → one`, `false → other`) | `plural-resolver.ts:137-141` |
| literal `"0"` branch dropped by the optimizer | `plural-resolver.ts:96-99` |
| arity 4 or 5 (MALFORMED for every locale) | rejected by `tests/plural-parity-gate.test.ts:55` |

---

## 5. Brand placeholders are NOT plural syntax

`src/branding.ts:37-47` `brandTranslation()` rewrites `{{deviceName}}`,
`{{deviceNameLower}}`, `{{siteName}}`, `{{cloudService}}`, `{{logName}}`,
`{{organizationName}}` **at module load**, before any runtime sees the string.
They share the `{{…}}` delimiter with plurals but are a different mechanism
entirely, and they are resolved by the time `interpolate` runs.

Occurrences (raw source): **`en` only — 6 sites**, wrapped in explicit
`brandTranslation(...)` calls:

| file:line | Raw | Rendered (frozen) |
|---|---|---|
| `src/en/index.ts:1720` | `brandTranslation("{{deviceName}}")` | `CeraLive` |
| `src/en/index.ts:1914` | `brandTranslation("{{logName}}")` | `CeraLive Log` |
| `src/en/index.ts:1923` | `…download the {{logName}}?…` | `…download the CeraLive Log?…` |
| `src/en/index.ts:1928` | `brandTranslation("Download {{logName}}")` | `Download CeraLive Log` |
| `src/en/index.ts:1978` | `…manage your {{deviceName}} device.` | `…manage your CeraLive device.` |
| `src/en/index.ts:1984` | `brandTranslation("{{deviceName}} device is powered on")` | `CeraLive device is powered on` |

The 9 non-`en` dictionaries contain **zero** `brandTranslation(` calls and zero
brand placeholders — brand names are already inlined in their copy.

**Converter rule:** convert from the LOADED dictionary module (post-`brandTranslation`
strings), not from the raw source text. Reading the source text and treating
`{{deviceName}}` as a 1-branch plural would emit `deviceName` as a variant, which
neither renders the brand name nor matches the frozen oracle. If the converter
must parse source, apply `brandTranslation()` first.

---

## 6. Converter acceptance checklist (todo 20)

1. Key set per locale equals the TS dictionary key set, verbatim dotted keys — 1472 keys × 10.
2. Param types sourced from `en` (§2b) and applied to every locale.
3. All 21 plural occurrences converted to inlang variants selecting on `count` (§2a).
4. Arabic 6-branch → six variants including a `zero` variant (§1b, §2c).
5. Arabic 2-branch `linksReadyCount` reproduces EMPTY `zero`/`two` renders (§2d) — no CLDR "fix".
6. Branch text preserved verbatim including internal spaces (§1a).
7. Any §4 form encountered ⇒ hard failure naming key + locale.
8. Reverse render at counts {0,1,2,5,11,100} and with `params/<locale>.params.json`
   ⇒ **byte-identical to `tests/fixtures/<locale>.rendered.json`, zero diffs, no allowlist.**
