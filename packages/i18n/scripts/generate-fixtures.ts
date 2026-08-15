/**
 * FROZEN RENDERED-STRING ORACLE — generator.
 *
 * Renders EVERY leaf key of EVERY locale through the CURRENT runtime and writes
 * one immutable JSON fixture per locale (`tests/fixtures/<locale>.rendered.json`).
 * Those fixtures are the oracle the Paraglide migration must byte-match: after
 * the migration, the converted catalog is rendered with the SAME deterministic
 * params and diffed against these files. Zero differences, no allowlist.
 *
 * THE RENDER PATH IS THE REAL ONE, not a reimplementation:
 *   - `interpolate()` (src/plural-resolver.ts) is the exact function the Svelte 5
 *     runes adapter's `interpolateString()` delegates to — i.e. the BROWSER path
 *     every operator-visible string travels.
 *   - `i18nObject()` (typesafe-i18n runtime, via the generated i18n-util) is the
 *     NODE oracle the existing plural-parity gate compares against.
 * Both are rendered for every key; a divergence FAILS the generator loudly
 * rather than silently freezing one of two disagreeing answers.
 *
 * DETERMINISTIC PARAMS (see `docs/PLURAL-GRAMMAR.md`):
 *   - a key carrying plural syntax (`{{…}}`) is rendered once per count in
 *     {0, 1, 2, 5, 11, 100} — the set that hits every Arabic CLDR bucket
 *     (zero/one/two/few/many/other) — with the count routed to every param key
 *     the template names plus the positional-index fallback "0";
 *   - every other typed param gets a fixed value derived from its NAME and its
 *     position, so two params of the same type in one string can never be
 *     swapped without the fixture changing.
 *
 * Usage:  bun run --filter @ceraui/i18n fixtures
 *         (or: bun packages/i18n/scripts/generate-fixtures.ts)
 *
 * The generator is IDEMPOTENT: running it twice leaves `git diff` empty.
 *
 * RETIREMENT: this generator retires together with the typesafe-i18n runtime it
 * renders through (plan todo 24). The fixtures it produced, and the test that
 * compares against them, stay. Nothing that outlives it may write
 * `*.rendered.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locales } from "../src/i18n-types.js";
import { i18nObject, loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";
import { interpolate } from "../src/plural-resolver.js";

export const ALL_LOCALES: readonly Locales[] = [
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

/** {0,1,2,5,11,100} => ar {zero, one, two, few, many, other}. */
export const PLURAL_COUNTS = [0, 1, 2, 5, 11, 100] as const;

/**
 * Fixed numeric values handed to `:number` params, by their ORDER of first
 * appearance in the template. Distinct values so a converter that swaps two
 * number params in one string produces a different fixture.
 */
const NUMBER_VALUES = [42, 7, 3, 11, 100, 1] as const;

/** Every `{name}` / `{name:type}` token, ordered, de-duplicated. */
const PARAM_TOKEN = /\{(\w+)(?::(\w+))?\}/g;

/** Every explicit `{{key: …}}` plural key. */
const PLURAL_KEY_TOKEN = /\{\{\s*(\w+)\s*:/g;

type Dict = Record<string, unknown>;
type ParamValue = string | number;

export interface RenderedLeaf {
	/** Dotted key, verbatim — never renamed. */
	key: string;
	/** Path segments, for navigating the `i18nObject` proxy. */
	path: string[];
	template: string;
	plural: boolean;
}

/** Depth-first walk collecting every leaf STRING with its dotted key. */
export function collectLeaves(dict: Dict, path: string[] = [], out: RenderedLeaf[] = []): RenderedLeaf[] {
	for (const [k, v] of Object.entries(dict)) {
		const next = [...path, k];
		if (typeof v === "string") {
			out.push({ key: next.join("."), path: next, template: v, plural: v.includes("{{") });
			continue;
		}
		if (v && typeof v === "object" && !Array.isArray(v)) {
			collectLeaves(v as Dict, next, out);
			continue;
		}
		throw new Error(`non-string, non-object leaf at ${next.join(".")} (${typeof v})`);
	}
	return out;
}

/**
 * Params for a NON-plural template: one fixed value per named param, derived
 * from the param's name (strings) or its ordinal (numbers).
 */
export function buildScalarParams(template: string): Record<string, ParamValue> {
	const params: Record<string, ParamValue> = {};
	let numberOrdinal = 0;
	for (const match of template.matchAll(PARAM_TOKEN)) {
		const name = match[1];
		if (!name || name in params) continue;
		if (match[2] === "number") {
			params[name] = NUMBER_VALUES[numberOrdinal % NUMBER_VALUES.length] ?? 0;
			numberOrdinal += 1;
			continue;
		}
		params[name] = `<${name}>`;
	}
	return params;
}

/**
 * Params for a PLURAL template at `count`: the count is routed to EVERY key the
 * plural could resolve to — each `{arg}` token key, each explicit `{{key:…}}`
 * key, and the positional-index fallback "0" — so the comparison is honest
 * regardless of which key `parseRawText` infers. Same rule the existing
 * plural-parity gate uses.
 */
export function buildPluralParams(template: string, count: number): Record<string, number> {
	const params: Record<string, number> = { "0": count };
	for (const match of template.matchAll(PARAM_TOKEN)) {
		const name = match[1];
		if (name) params[name] = count;
	}
	for (const match of template.matchAll(PLURAL_KEY_TOKEN)) {
		const name = match[1];
		if (name) params[name] = count;
	}
	return params;
}

/** The param keys a plural template routes its count into (for `params/<locale>.params.json`). */
function pluralCountParamKeys(template: string): string[] {
	return Object.keys(buildPluralParams(template, 0)).sort();
}

/** Navigate the `i18nObject(locale)` proxy to `path` and call the leaf. */
function renderViaNodeOracle(proxy: unknown, path: string[], params: Record<string, ParamValue>): string {
	let cur: unknown = proxy;
	for (const seg of path) cur = (cur as Dict)[seg];
	return (cur as (p: Record<string, ParamValue>) => string)(params);
}

/**
 * Render one leaf through BOTH runtime paths and return the agreed value.
 * A disagreement is a hard error — the two paths are the thing the existing
 * parity gate exists to keep identical, and an oracle frozen over a divergence
 * would be meaningless.
 */
function renderAgreed(
	locale: Locales,
	proxy: unknown,
	leaf: RenderedLeaf,
	params: Record<string, ParamValue>,
): string {
	const browser = interpolate(leaf.template, params, locale);
	const node = renderViaNodeOracle(proxy, leaf.path, params);
	if (browser !== node) {
		throw new Error(
			`render path divergence at ${locale}:${leaf.key}\n  browser (interpolate): ${JSON.stringify(browser)}\n  node    (i18nObject) : ${JSON.stringify(node)}`,
		);
	}
	return browser;
}

export type RenderedValue = string | Record<string, string>;

/** Render every leaf of one locale. Pure: no filesystem access. */
export function renderLocale(locale: Locales): {
	rendered: Record<string, RenderedValue>;
	params: LocaleParams;
} {
	const dict = loadedLocales[locale] as unknown as Dict | undefined;
	if (!dict) throw new Error(`locale ${locale} is not loaded`);
	const proxy = i18nObject(locale);
	const leaves = collectLeaves(dict);

	const rendered: Record<string, RenderedValue> = {};
	const keyParams: LocaleParams["keys"] = {};

	for (const leaf of leaves) {
		if (leaf.plural) {
			const byCount: Record<string, string> = {};
			for (const count of PLURAL_COUNTS) {
				byCount[String(count)] = renderAgreed(locale, proxy, leaf, buildPluralParams(leaf.template, count));
			}
			rendered[leaf.key] = byCount;
			keyParams[leaf.key] = { plural: true, countParams: pluralCountParamKeys(leaf.template) };
			continue;
		}
		const params = buildScalarParams(leaf.template);
		rendered[leaf.key] = renderAgreed(locale, proxy, leaf, params);
		if (Object.keys(params).length > 0) keyParams[leaf.key] = { plural: false, params };
	}

	return { rendered, params: { counts: [...PLURAL_COUNTS], keys: keyParams } };
}

export interface LocaleParams {
	counts: number[];
	keys: Record<
		string,
		{ plural: true; countParams: string[] } | { plural: false; params: Record<string, ParamValue> }
	>;
}

/** Stable, sorted-key JSON so the generator is byte-idempotent. */
function stableJson(value: unknown): string {
	return `${JSON.stringify(value, sortedReplacer, "\t")}\n`;
}

function sortedReplacer(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(value as Dict).sort()) sorted[k] = (value as Dict)[k];
	return sorted;
}

function main(): void {
	loadAllLocales();

	const here = dirname(fileURLToPath(import.meta.url));
	const fixturesDir = join(here, "..", "tests", "fixtures");
	const paramsDir = join(fixturesDir, "params");
	mkdirSync(paramsDir, { recursive: true });

	let total = 0;
	for (const locale of ALL_LOCALES) {
		const { rendered, params } = renderLocale(locale);
		writeFileSync(join(fixturesDir, `${locale}.rendered.json`), stableJson(rendered), "utf8");
		writeFileSync(join(paramsDir, `${locale}.params.json`), stableJson(params), "utf8");
		total += Object.keys(rendered).length;
		process.stdout.write(`${locale}: ${Object.keys(rendered).length} keys\n`);
	}
	process.stdout.write(`wrote ${ALL_LOCALES.length} fixtures, ${total} rendered keys total\n`);
}

if (import.meta.main) main();
