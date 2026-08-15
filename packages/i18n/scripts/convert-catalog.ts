/**
 * typesafe-i18n dictionaries -> inlang message-format catalogs.
 *
 * There is no official typesafe-i18n importer for Paraglide, so THIS SCRIPT IS
 * THE IMPORTER. It reads the LOADED dictionary modules (post-`brandTranslation`,
 * §5 of `docs/PLURAL-GRAMMAR.md`), flattens them to VERBATIM dotted keys, and
 * emits `messages/<locale>.json`. Conversion rules live in `message-format.ts`.
 *
 * Guarantees, in the order they are enforced:
 *   1. SAFE-MODULE-ID PRE-FLIGHT over the whole key set, BEFORE any compile —
 *      paraglide silently overwrites colliding bundles.
 *   2. Key-set equality across all 10 locales (the base locale defines the set).
 *   3. Every plural converted from the LEGACY resolver's own answers, so the
 *      frozen rendered oracle is reproduced byte-for-byte, defects included.
 * Byte parity is then PROVEN, not assumed, by `tests/reverse-render-gate.test.ts`.
 *
 * Usage:  bun run --filter @ceraui/i18n convert-catalog
 * Idempotent: a second run leaves `git diff` empty.
 *
 * Retires with the TS dictionaries it reads (plan todo 24).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_LOCALES, collectLeaves } from "./generate-fixtures.js";
import { assertInjectiveModuleIds, convertTemplate, type MessageValue, paramNames, paramTypes } from "./message-format.js";
import type { Locales } from "../src/i18n-types.js";
import { loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";

const SCHEMA = "https://inlang.com/schema/inlang-message-format";

type Catalog = Map<string, string>;

/** Dotted key -> template, for one locale. */
function readCatalog(locale: Locales): Catalog {
	const dict = loadedLocales[locale] as unknown as Record<string, unknown> | undefined;
	if (!dict) throw new Error(`locale ${locale} is not loaded`);
	return new Map(collectLeaves(dict).map((leaf) => [leaf.key, leaf.template]));
}

/** The base locale owns the key set; any drift is a hard failure. */
function assertSameKeys(base: Catalog, locale: Locales, catalog: Catalog): void {
	const missing = [...base.keys()].filter((key) => !catalog.has(key));
	const extra = [...catalog.keys()].filter((key) => !base.has(key));
	if (missing.length === 0 && extra.length === 0) return;
	throw new Error(
		`key-set drift in ${locale}: ${missing.length} missing, ${extra.length} extra\n` +
			`  missing: ${missing.slice(0, 5).join(", ")}\n  extra: ${extra.slice(0, 5).join(", ")}`,
	);
}

/**
 * Declared inputs for one key: the BASE-locale param set (§2b — typesafe-i18n
 * types call sites from `en` alone) unioned with this locale's own params (§3c —
 * two keys carry `{network}`/`{ssid}` in all nine non-base locales).
 */
function declaredInputs(baseTemplate: string, localeTemplate: string): string[] {
	const names = paramNames(baseTemplate);
	for (const name of paramNames(localeTemplate)) if (!names.includes(name)) names.push(name);
	return names;
}

function convertLocale(locale: Locales, base: Catalog, catalog: Catalog): Record<string, MessageValue> {
	const messages: Record<string, MessageValue> = {};
	for (const key of [...catalog.keys()].sort()) {
		const template = catalog.get(key) ?? "";
		const baseTemplate = base.get(key) ?? "";
		messages[key] = convertTemplate({
			template,
			locale,
			key,
			declaredInputs: declaredInputs(baseTemplate, template),
		});
	}
	return messages;
}

/** Base-locale types, kept for reporting: they are validated, never rendered. */
function baseTypeSummary(base: Catalog): Map<string, string> {
	const typed = new Map<string, string>();
	for (const [key, template] of base) {
		for (const [name, type] of paramTypes(template)) {
			if (type) typed.set(`${key}.${name}`, type);
		}
	}
	return typed;
}

function main(): void {
	loadAllLocales();
	const baseLocale = ALL_LOCALES[0] as Locales;
	const base = readCatalog(baseLocale);

	const moduleIds = assertInjectiveModuleIds([...base.keys()]);
	process.stdout.write(`injectivity: ${moduleIds.size} keys -> ${moduleIds.size} distinct module ids\n`);
	process.stdout.write(`base types (${baseLocale}): ${baseTypeSummary(base).size} typed params\n`);

	const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "messages");
	mkdirSync(outDir, { recursive: true });

	for (const locale of ALL_LOCALES) {
		const catalog = readCatalog(locale);
		assertSameKeys(base, locale, catalog);
		const messages = convertLocale(locale, base, catalog);
		const file = { $schema: SCHEMA, ...messages };
		writeFileSync(join(outDir, `${locale}.json`), `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		process.stdout.write(`${locale}: ${Object.keys(messages).length} messages\n`);
	}
}

if (import.meta.main) main();
