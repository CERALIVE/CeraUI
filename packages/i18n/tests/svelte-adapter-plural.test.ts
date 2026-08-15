import { describe, expect, it } from "bun:test";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import {
	ALL_LOCALES,
	isComplex,
	PLURAL_COUNTS,
	readCatalog,
	readOracleParams,
	readRenderedOracle,
	variantsOf,
} from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// STORE-FACING PLURAL PARITY (plan todo 23; replaces the legacy adapter gate).
//
// The legacy Svelte 5 adapter rendered every string through the pure
// `interpolate()` resolver, so this file proved that resolver byte-matched the
// typesafe-i18n node runtime. Both are deleted at plan todo 24. What SURVIVES is
// the claim that mattered: the string an operator sees for a plural key is
// byte-identical to what the old implementation produced.
//
// So the render path here is the NEW store's own — `generated/registry.js`, the
// module `@ceraui/i18n/svelte` re-exports as `m` — and the oracle is the FROZEN
// old-implementation capture (plan todo 19). Every assertion is an exact string,
// including the shipped Arabic `linksReadyCount` defect (`{count}  للتجميع`,
// double space: a 2-branch source key whose absent `zero`/`two` branches render
// empty). Reproducing a defect byte-for-byte is the point — a copy fix is a
// separate, separately-reviewed translation PR that updates the fixtures.
//
// WHAT REPLACED THE SYNTHETIC-TEMPLATE CASES. The legacy file also drove 17
// hand-written templates through the resolver to cover typesafe-i18n grammar the
// dictionaries did not use: the `{{s}}` suffix shorthand, keyed `{{k:a|b}}`,
// 3-branch `zero|one|other`, and `??` value injection. Those forms have NO
// representation in the converted catalog — not by omission, but by construction:
// the converter REJECTS each of them by name (`scripts/message-format.ts`
// `assertSupportedPlural`), and the todo-19 grammar inventory found zero
// occurrences of any of them across all ten locales. There is therefore no
// converted message to render them through, and reimplementing the resolver here
// to keep the old assertions alive would test a deleted implementation.
//
// The equivalent protection post-cutover is an INVENTORY LOCK: the catalogs are
// hand-editable JSON from todo 24 on, so each retired form is asserted ABSENT by
// name from every locale. A hand edit that reintroduces one fails here instead of
// silently reaching an operator as literal `{{s}}`.
// ---------------------------------------------------------------------------

const GENERATED = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"generated",
);

const { m } = (await import(join(GENERATED, "registry.js"))) as {
	m: Record<
		string,
		((inputs?: Record<string, unknown>, options?: { locale: string }) => string)
	>;
};

/** The three keys the todo-19 grammar inventory found carry plural syntax. */
const PLURAL_KEYS = [
	"live.server.bondedAcross",
	"live.setup.linksReady",
	"live.ingest.linksReadyCount",
] as const;

function renderPlural(locale: LocaleCode, key: string, count: number): string {
	const spec = readOracleParams(locale).keys[key];
	const inputs =
		spec?.plural === true
			? Object.fromEntries(spec.countParams.map((name) => [name, count]))
			: (spec?.params ?? {});
	const render = m[key];
	if (render === undefined) throw new Error(`registry has no message ${key}`);
	return render(inputs, { locale });
}

/**
 * ja/ko/zh carry no plural syntax on these keys, so their frozen entry is a
 * single string rather than a per-count map — and it must render identically at
 * every count. That regression case was in the legacy gate and is kept here.
 */
function frozenRender(
	locale: LocaleCode,
	key: string,
	count: number,
): string | undefined {
	const entry = readRenderedOracle(locale)[key];
	return typeof entry === "string" ? entry : entry?.[String(count)];
}

/** Every rendered pattern of a catalog, plural branches expanded. */
function allPatterns(locale: LocaleCode): Array<{ key: string; pattern: string }> {
	return Object.entries(readCatalog(locale)).flatMap(([key, value]) =>
		(isComplex(value) ? Object.values(variantsOf(value).match) : [value]).map(
			(pattern) => ({ key, pattern }),
		),
	);
}

describe("store plural parity (m[key] === frozen old-implementation oracle)", () => {
	for (const key of PLURAL_KEYS) {
		for (const locale of ALL_LOCALES) {
			for (const count of PLURAL_COUNTS) {
				const category = new Intl.PluralRules(locale).select(count);
				it(`${locale} · ${key} · count=${count} (${category})`, () => {
					const expected = frozenRender(locale, key, count);
					expect(expected).toBeString();
					expect(renderPlural(locale, key, count)).toBe(expected as string);
				});
			}
		}
	}
});

describe("Arabic six-way selection reaches every CLDR bucket", () => {
	const AR_SIX_WAY = {
		"live.server.bondedAcross": {
			zero: "مجمّع عبر 0 روابط",
			one: "مجمّع عبر 1 رابط",
			two: "مجمّع عبر 2 رابطين",
			few: "مجمّع عبر 5 روابط",
			many: "مجمّع عبر 11 رابطًا",
			other: "مجمّع عبر 100 رابط",
		},
		"live.setup.linksReady": {
			zero: "0 روابط جاهزة",
			one: "1 رابط جاهزة",
			two: "2 رابطان جاهزة",
			few: "5 روابط جاهزة",
			many: "11 رابطًا جاهزة",
			other: "100 رابط جاهزة",
		},
		// The SHIPPED defect, frozen: `zero` and `two` select branches the source
		// key never declared, so they render empty and leave a double space.
		"live.ingest.linksReadyCount": {
			zero: "0  للتجميع",
			one: "1 رابط جاهز للتجميع",
			two: "2  للتجميع",
			few: "5 روابط جاهزة للتجميع",
			many: "11 روابط جاهزة للتجميع",
			other: "100 روابط جاهزة للتجميع",
		},
	} as const;

	const COUNT_FOR_CATEGORY = { zero: 0, one: 1, two: 2, few: 5, many: 11, other: 100 } as const;

	for (const [key, byCategory] of Object.entries(AR_SIX_WAY)) {
		for (const [category, expected] of Object.entries(byCategory)) {
			it(`ar · ${key} · ${category}`, () => {
				const count = COUNT_FOR_CATEGORY[category as keyof typeof COUNT_FOR_CATEGORY];
				expect(renderPlural("ar", key, count)).toBe(expected);
				expect(frozenRender("ar", key, count)).toBe(expected);
			});
		}
	}
});

describe("English zero/one/other selection", () => {
	const EN_EXPECTED = {
		"live.server.bondedAcross": { 0: "Bonded across 0 links", 1: "Bonded across 1 link", 100: "Bonded across 100 links" },
		"live.setup.linksReady": { 0: "0 links ready", 1: "1 link ready", 100: "100 links ready" },
		"live.ingest.linksReadyCount": { 0: "0 links ready to bond", 1: "1 link ready to bond", 100: "100 links ready to bond" },
	} as const;

	for (const [key, byCount] of Object.entries(EN_EXPECTED)) {
		for (const [count, expected] of Object.entries(byCount)) {
			it(`en · ${key} · count=${count}`, () => {
				expect(renderPlural("en", key, Number(count))).toBe(expected);
			});
		}
	}
});

// Grammar the legacy runtime supported, the converter refuses, and the catalogs
// have never contained. Each is asserted absent BY NAME so a hand edit that
// reintroduces one fails here rather than in front of an operator.
describe("retired legacy grammar stays absent from every catalog", () => {
	const RETIRED_FORMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
		{ name: "{{s}} suffix shorthand", pattern: /\{\{\s*s\s*\}\}/ },
		{ name: "keyed plural {{key:a|b}}", pattern: /\{\{[^{}]*:[^{}]*\|[^{}]*\}\}/ },
		{ name: "positional {0} parameter", pattern: /\{\d+\}/ },
		{ name: "formatter pipe {x|fmt}", pattern: /\{\w+\|[^{}]*\}/ },
		{ name: "optional param {x?:t}", pattern: /\{\w+\?:/ },
		{ name: "any {{…}} plural group", pattern: /\{\{/ },
	];

	for (const locale of ALL_LOCALES) {
		for (const { name, pattern } of RETIRED_FORMS) {
			it(`${locale}: no ${name}`, () => {
				const hits = allPatterns(locale)
					.filter(({ pattern: text }) => pattern.test(text))
					.map(({ key }) => key);
				expect([...new Set(hits)]).toEqual([]);
			});
		}
	}

	it("`??` value injection is absent from every catalog", () => {
		const hits = ALL_LOCALES.flatMap((locale) =>
			allPatterns(locale)
				.filter(({ pattern }) => pattern.includes("??"))
				.map(({ key }) => `${locale}:${key}`),
		);
		expect(hits).toEqual([]);
	});

	it("exactly three keys carry plural variants, in every locale that has any", () => {
		for (const locale of ALL_LOCALES) {
			const keys = Object.entries(readCatalog(locale))
				.filter(([, value]) => isComplex(value))
				.map(([key]) => key)
				.sort();
			const expected = ["ja", "ko", "zh"].includes(locale)
				? []
				: [...PLURAL_KEYS].sort();
			expect(keys).toEqual(expected);
		}
	});
});

describe("regression: messages without plural syntax render unchanged", () => {
	it("a plain string renders byte-identically to the frozen oracle", () => {
		const render = m["live.setup.title"];
		expect(render?.()).toBe("Stream setup");
		expect(render?.()).toBe(readRenderedOracle("en")["live.setup.title"]);
	});

	it("a message with no inputs is untouched by an empty input object", () => {
		expect(m["live.setup.title"]?.({})).toBe("Stream setup");
	});

	it("a param-only message substitutes and matches the frozen oracle", () => {
		const oracle = readRenderedOracle("en")["advanced.sshPassword"];
		const params = readOracleParams("en").keys["advanced.sshPassword"]?.params;
		expect(m["advanced.sshPassword"]?.(params)).toBe(oracle);
	});
});
