/**
 * Shared readers for the POST-MIGRATION sources of truth.
 *
 * Every gate in this directory used to read the legacy TypeScript dictionaries
 * through the typesafe-i18n runtime. Those retire (plan todo 24), so the gates
 * are repointed at the two things that outlive them:
 *
 *   - `messages/<locale>.json` — the inlang catalogs, keyed by the VERBATIM
 *     dotted key, which become the canonical hand-editable translation source at
 *     the cutover;
 *   - `tests/fixtures/<locale>.rendered.json` — the IMMUTABLE rendered oracle
 *     frozen from the OLD implementation (plan todo 19). Comparing the new
 *     paraglide renders against it is what makes "old render === new render" a
 *     provable claim after the old renderer is gone.
 *
 * Nothing here imports the legacy runtime, so these helpers survive todo 24.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocaleCode } from "../../src/locale-lifecycle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");
const FIXTURES_DIR = join(PACKAGE_ROOT, "tests", "fixtures");

/** The ten shipped locales, base locale first. */
export const ALL_LOCALES: readonly LocaleCode[] = [
	"en",
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"ja",
	"ko",
	"pt-BR",
	"zh",
] as const;

/** Every locale except the base one. */
export const NON_BASE_LOCALES: readonly LocaleCode[] = ALL_LOCALES.filter(
	(locale) => locale !== "en",
);

/**
 * The counts the frozen oracle was captured at — the set that reaches every
 * Arabic CLDR bucket (0 zero, 1 one, 2 two, 5 few, 11 many, 100 other).
 */
export const PLURAL_COUNTS = [0, 1, 2, 5, 11, 100] as const;

/** An inlang message-format v2 variant object (the `[0]` of a complex message). */
export interface ComplexMessage {
	declarations: string[];
	selectors: string[];
	match: Record<string, string>;
}

/** A catalog entry: a plain pattern, or a one-element array holding the variants. */
export type CatalogValue = string | [ComplexMessage];

/** A frozen oracle entry: a rendered string, or count -> rendered string. */
export type RenderedValue = string | Record<string, string>;

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The raw `messages/<locale>.json`, `$schema` included. */
export function readCatalogFile(
	locale: LocaleCode,
): Record<string, CatalogValue | string> {
	return readJson(join(PACKAGE_ROOT, "messages", `${locale}.json`));
}

/** The catalog as messages only — `$schema` stripped. */
export function readCatalog(locale: LocaleCode): Record<string, CatalogValue> {
	const file = readCatalogFile(locale);
	const out: Record<string, CatalogValue> = {};
	for (const [key, value] of Object.entries(file)) {
		if (key !== "$schema") out[key] = value as CatalogValue;
	}
	return out;
}

/** Every message key of a catalog, sorted. */
export function catalogKeys(locale: LocaleCode): string[] {
	return Object.keys(readCatalog(locale)).sort();
}

/** The frozen rendered oracle for a locale (todo 19; immutable). */
export function readRenderedOracle(
	locale: LocaleCode,
): Record<string, RenderedValue> {
	return readJson(join(FIXTURES_DIR, `${locale}.rendered.json`));
}

/** True when the entry carries plural variants rather than a plain pattern. */
export function isComplex(value: CatalogValue): value is [ComplexMessage] {
	return Array.isArray(value);
}

/** The variant object of a complex entry. */
export function variantsOf(value: [ComplexMessage]): ComplexMessage {
	const [first] = value;
	return first;
}

/** The params the frozen oracle was captured with, for one locale (todo 19). */
export interface LocaleParams {
	counts: number[];
	keys: Record<
		string,
		{
			params?: Record<string, unknown>;
			plural?: boolean;
			countParams: string[];
		}
	>;
}

export function readOracleParams(locale: LocaleCode): LocaleParams {
	return readJson(join(FIXTURES_DIR, "params", `${locale}.params.json`));
}

/** Keys whose entry carries plural variants, sorted. */
export function pluralKeys(locale: LocaleCode): string[] {
	return Object.entries(readCatalog(locale))
		.filter(([, value]) => isComplex(value))
		.map(([key]) => key)
		.sort();
}
