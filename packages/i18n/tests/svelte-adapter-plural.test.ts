import { beforeAll, describe, expect, it } from "bun:test";

import type { Locales } from "../src/i18n-types.js";
import { i18nObject, i18nString, loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";
import {
	type InterpolationParams,
	interpolate,
} from "../src/plural-resolver.js";

// ---------------------------------------------------------------------------
// The Svelte 5 runes adapter (`i18n-svelte5.svelte.ts`) renders EVERY
// translation string through the pure, rune-free `interpolate()` exported from
// `plural-resolver.ts`. These tests therefore prove the BROWSER path (adapter)
// renders typesafe-i18n plural syntax byte-for-byte identically to the NODE
// path — using the real `i18nObject` / `i18nString` runtime as the oracle.
//
// TDD: written FIRST (fails while the resolver only does param substitution and
// leaves the literal `{{link|links}}` in the output), then made green by the
// resolver implementation.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

// Locales that carry typesafe-i18n plural syntax on the tested keys. ja/ko/zh
// have no `{{...}}` on these keys (regression: they must still byte-match).
const ALL_LOCALES: Locales[] = [
	"en",
	"ar",
	"fr",
	"de",
	"es",
	"pt-BR",
	"hi",
	"ja",
	"ko",
	"zh",
];
const COUNTS = [0, 1, 2, 6] as const;

beforeAll(() => {
	loadAllLocales();
});

// Depth-first search for the first path whose final segment === `key` and whose
// value is a string. `bondedAcross` / `linksReadyCount` are unique leaf keys.
function findPath(
	dict: Dict,
	key: string,
	path: string[] = [],
): string[] | undefined {
	for (const [k, v] of Object.entries(dict)) {
		const next = [...path, k];
		if (k === key && typeof v === "string") return next;
		if (v && typeof v === "object") {
			const found = findPath(v as Dict, key, next);
			if (found) return found;
		}
	}
	return undefined;
}

function rawAt(dict: Dict, path: string[]): string {
	let cur: unknown = dict;
	for (const seg of path) cur = (cur as Dict)[seg];
	return cur as string;
}

function oracleAt(
	proxy: unknown,
	path: string[],
	params: Record<string, unknown>,
): string {
	let cur: unknown = proxy;
	for (const seg of path) cur = (cur as Dict)[seg];
	return (cur as (p: Record<string, unknown>) => string)(params);
}

type StringOracle = (text: string, params: Record<string, unknown>) => string;

describe("svelte adapter plural parity (interpolate === i18nObject)", () => {
	for (const key of ["bondedAcross", "linksReadyCount"] as const) {
		for (const locale of ALL_LOCALES) {
			for (const count of COUNTS) {
				it(`${locale} · ${key} · count=${count}`, () => {
					const dict = loadedLocales[locale] as unknown as Dict;
					const path = findPath(dict, key);
					expect(path).toBeDefined();
					if (!path) return;

					const template = rawAt(dict, path);
					const oracle = oracleAt(i18nObject(locale), path, { count });

					expect(interpolate(template, { count }, locale)).toBe(oracle);
				});
			}
		}
	}
});

describe("plural semantics parity (interpolate === i18nString oracle)", () => {
	const cases: Array<{
		name: string;
		template: string;
		params: InterpolationParams;
		locale: Locales;
	}> = [
		// (a) unkeyed plural inherits the PREVIOUS param's key (lastAccessor) —
		// parser oracle `'{ nr: number } {{ Project | Projects }}'` -> key `nr`.
		{
			name: "(a) lastAccessor: {nr:number} then {{Project|Projects}} (plural)",
			template: "{nr:number} {{ Project | Projects }}",
			params: { nr: 2 },
			locale: "en",
		},
		{
			name: "(a) lastAccessor: {nr:number} then {{Project|Projects}} (singular)",
			template: "{nr:number} {{ Project | Projects }}",
			params: { nr: 1 },
			locale: "en",
		},
		// plural BEFORE any param -> falls back to the FIRST key seen anywhere.
		{
			name: "(a) plural before first param falls back to first key",
			template: "{{item|items}} for {nr:number}",
			params: { nr: 3 },
			locale: "en",
		},
		// (b) keyed plural {{key:a|b}} overrides lastAccessor.
		{
			name: "(b) keyed plural {{count:apple|apples}} (plural)",
			template: "{{count:apple|apples}}",
			params: { count: 3 },
			locale: "en",
		},
		{
			name: "(b) keyed plural {{count:apple|apples}} (singular)",
			template: "{{count:apple|apples}}",
			params: { count: 1 },
			locale: "en",
		},
		// (c) 3-part zero|one|other + the 0 -> `zero` special rule.
		{
			name: "(c) 3-part zero-special (count=0)",
			template: "{count:number} {{no cats|one cat|?? cats}}",
			params: { count: 0 },
			locale: "en",
		},
		{
			name: "(c) 3-part one (count=1)",
			template: "{count:number} {{no cats|one cat|?? cats}}",
			params: { count: 1 },
			locale: "en",
		},
		{
			name: "(c) 3-part other (count=5)",
			template: "{count:number} {{no cats|one cat|?? cats}}",
			params: { count: 5 },
			locale: "en",
		},
		// (c) 6-part (zero|one|two|few|many|other) via Intl.PluralRules('ar').
		{
			name: "(c) 6-part ar zero (count=0)",
			template: "{count} {{zero|one|two|few|many|other}}",
			params: { count: 0 },
			locale: "ar",
		},
		{
			name: "(c) 6-part ar two (count=2)",
			template: "{count} {{zero|one|two|few|many|other}}",
			params: { count: 2 },
			locale: "ar",
		},
		{
			name: "(c) 6-part ar few (count=6)",
			template: "{count} {{zero|one|two|few|many|other}}",
			params: { count: 6 },
			locale: "ar",
		},
		{
			name: "(c) 6-part ar many (count=11)",
			template: "{count} {{zero|one|two|few|many|other}}",
			params: { count: 11 },
			locale: "ar",
		},
		// (d) {{s}} suffix shorthand (empty singular).
		{
			name: "(d) {{s}} shorthand (singular)",
			template: "{count:number} item{{s}}",
			params: { count: 1 },
			locale: "en",
		},
		{
			name: "(d) {{s}} shorthand (plural)",
			template: "{count:number} item{{s}}",
			params: { count: 2 },
			locale: "en",
		},
		{
			name: "(d) {{s}} shorthand (zero -> plural in en)",
			template: "{count:number} item{{s}}",
			params: { count: 0 },
			locale: "en",
		},
		// (e) `??` value injection INSIDE the chosen branch (rest is literal).
		{
			name: "(e) ?? value injection (plural branch)",
			template: "{count:number} {{a banana|?? bananas}}",
			params: { count: 5 },
			locale: "en",
		},
		{
			name: "(e) ?? value injection (singular branch, no ??)",
			template: "{count:number} {{a banana|?? bananas}}",
			params: { count: 1 },
			locale: "en",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			const oracle = i18nString(c.locale) as unknown as StringOracle;
			expect(interpolate(c.template, c.params, c.locale)).toBe(
				oracle(c.template, c.params),
			);
		});
	}
});

describe("regression: strings without plural syntax render unchanged", () => {
	it("plain string is byte-identical", () => {
		const s = "Bonded links ready to bond";
		expect(interpolate(s, {}, "en")).toBe(s);
	});

	it("no params leaves plain text untouched", () => {
		expect(interpolate("Links ready", {}, "en")).toBe("Links ready");
	});

	it("param-only string substitutes and matches the oracle", () => {
		const template = "RTT trend for {iface:string}";
		const params = { iface: "wlan0" };
		const oracle = i18nString("en") as unknown as StringOracle;

		expect(interpolate(template, params, "en")).toBe("RTT trend for wlan0");
		expect(interpolate(template, params, "en")).toBe(oracle(template, params));
	});
});
