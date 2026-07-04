import { describe, expect, it } from "bun:test";

import type { Locales } from "../src/i18n-types.js";
import { i18nObject, loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";
import { interpolate } from "../src/plural-resolver.js";

// ---------------------------------------------------------------------------
// PERMANENT plural-parity gate (todo 3).
//
// Statically walks EVERY locale dictionary (all 10), extracts EVERY string that
// carries typesafe-i18n plural syntax (`{{...}}`), and for each asserts the
// BROWSER path (`interpolate`, the pure resolver the Svelte 5 runes adapter
// delegates to) renders byte-for-byte identically to the NODE oracle
// (`i18nObject`) at counts {0, 1, 2, 5, 11, 100}.
//
// The counts are chosen to hit every Arabic plural bucket:
//   0 -> zero · 1 -> one · 2 -> two · 5 -> few · 11 -> many · 100 -> other.
//
// A second assertion validates every plural part's ARITY: typesafe-i18n only
// defines 1-part (`{{s}}` shorthand), 2-part (one|other), 3-part
// (zero|one|other), and 6-part (zero|one|two|few|many|other) forms. A 4- or
// 5-part plural is malformed for EVERY locale (pure parity alone can't catch it
// because both paths mis-handle it identically), so the arity check is what
// rejects a `{{a|b|c|d}}`-class bug.
//
// This is the permanent gate that prevents the plural bug class from recurring
// as new locale strings are added.
// ---------------------------------------------------------------------------

// Load all dictionaries synchronously at module scope so the walker below can
// enumerate real keys at test-COLLECTION time (dynamic `it()` generation).
loadAllLocales();

type Dict = Record<string, unknown>;

const ALL_LOCALES: Locales[] = [
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
];

// {0,1,2,5,11,100} => ar {zero, one, two, few, many, other}.
const COUNTS = [0, 1, 2, 5, 11, 100] as const;

// The only legal typesafe-i18n plural aritys: 1 (`{{s}}`), 2 (one|other),
// 3 (zero|one|other), 6 (zero|one|two|few|many|other).
const VALID_PART_COUNTS = new Set([1, 2, 3, 6]);

interface PluralString {
	path: string[];
	template: string;
}

// Depth-first walk collecting every leaf string that contains `{{` (a plural
// expression). Brand `{{deviceName}}`-style placeholders are resolved to real
// brand names at module load (`branding.ts::brandTranslation`), so they never
// reach this walker — only genuine plural syntax remains in the loaded dict.
function collectPluralStrings(
	dict: Dict,
	path: string[] = [],
	out: PluralString[] = [],
): PluralString[] {
	for (const [k, v] of Object.entries(dict)) {
		const next = [...path, k];
		if (typeof v === "string") {
			if (v.includes("{{")) out.push({ path: next, template: v });
		} else if (v && typeof v === "object") {
			collectPluralStrings(v as Dict, next, out);
		}
	}
	return out;
}

// Navigate the `i18nObject(locale)` proxy to `path` and call the leaf with
// `params` — the NODE oracle for a real dictionary key.
function oracleAt(
	proxy: unknown,
	path: string[],
	params: Record<string, unknown>,
): string {
	let cur: unknown = proxy;
	for (const seg of path) cur = (cur as Dict)[seg];
	return (cur as (p: Record<string, unknown>) => string)(params);
}

// Build a params object that routes `count` to WHATEVER key the plural resolves
// to: every `{arg}` token key, every explicit `{{key:...}}` key, and the
// positional-index "0" fallback. Passing identical params to both paths keeps
// the comparison honest regardless of the inferred key.
function buildParams(template: string, count: number): Record<string, number> {
	const params: Record<string, number> = { "0": count };
	for (const m of template.matchAll(/\{(\w+)(?::\w+)?\}/g)) {
		const key = m[1];
		if (key) params[key] = count;
	}
	for (const m of template.matchAll(/\{\{\s*(\w+)\s*:/g)) {
		const key = m[1];
		if (key) params[key] = count;
	}
	return params;
}

// Balanced-brace split (the exact regex typesafe-i18n uses). A `{{...}}` group
// is captured whole; its inner content starts with `{`.
const REGEX_BRACKETS_SPLIT = /(\{(?:[^{}]+|\{(?:[^{}]+)*\})*\})/g;
const REGEX_BRACKETS_WHOLE = /^\{(?:[^{}]+|\{(?:[^{}]+)*\})*\}$/;

// Return the branch-arity of every `{{...}}` plural part in `template`,
// mirroring `parsePluralPart`'s key/values split (values = segment after the
// first `:` when a key is present, else the whole content).
function pluralPartArities(template: string): number[] {
	const arities: number[] = [];
	for (const raw of template.split(REGEX_BRACKETS_SPLIT)) {
		if (!raw || !REGEX_BRACKETS_WHOLE.test(raw)) continue;
		const content = raw.slice(1, -1);
		if (!content.startsWith("{")) continue; // `{arg}` token, not a plural part
		const inner = content.slice(1, -1);
		const segments = inner.split(":");
		const values = segments[1] ? segments[1] : segments[0];
		arities.push((values ?? "").split("|").length);
	}
	return arities;
}

describe("plural-parity gate: walker sanity", () => {
	it("finds >0 plural strings in the en dictionary (empty extraction FAILS)", () => {
		const found = collectPluralStrings(loadedLocales.en as unknown as Dict);
		expect(found.length).toBeGreaterThan(0);
	});

	it("rejects a malformed 4-part plural (arity gate has teeth)", () => {
		expect(pluralPartArities("x {{a|b|c|d}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(false);
		expect(pluralPartArities("x {{a|b|c|d|e}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(false);
		// The four legal forms all pass.
		expect(pluralPartArities("{{s}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(true);
		expect(pluralPartArities("{{a|b}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(true);
		expect(pluralPartArities("{{a|b|c}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(true);
		expect(pluralPartArities("{{a|b|c|d|e|f}}").every((n) => VALID_PART_COUNTS.has(n))).toBe(true);
	});
});

for (const locale of ALL_LOCALES) {
	const plurals = collectPluralStrings(loadedLocales[locale] as unknown as Dict);

	describe(`plural-parity gate: ${locale} (${plurals.length} plural string(s))`, () => {
		// ja/ko/zh carry no plural syntax — they still run through the walker and
		// pass trivially (the locale IS included in the gate).
		if (plurals.length === 0) {
			it("has no plural syntax — trivially passes the gate", () => {
				expect(plurals).toEqual([]);
			});
			return;
		}

		it("every plural part has a legal typesafe-i18n arity (1|2|3|6)", () => {
			const malformed = plurals.flatMap(({ path, template }) =>
				pluralPartArities(template)
					.filter((n) => !VALID_PART_COUNTS.has(n))
					.map((partCount) => ({ key: path.join("."), partCount, template })),
			);
			expect(malformed).toEqual([]);
		});

		for (const { path, template } of plurals) {
			for (const count of COUNTS) {
				it(`${path.join(".")} · count=${count} · interpolate === i18nObject`, () => {
					const params = buildParams(template, count);
					const oracle = oracleAt(i18nObject(locale), path, params);
					expect(interpolate(template, params, locale)).toBe(oracle);
				});
			}
		}
	});
}
