import { describe, expect, it } from "bun:test";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import {
	ALL_LOCALES,
	type ComplexMessage,
	isComplex,
	PLURAL_COUNTS,
	pluralKeys,
	readCatalog,
	readOracleParams,
	readRenderedOracle,
	variantsOf,
} from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// PERMANENT plural-parity gate (todo 3; repointed onto the FROZEN oracle by
// plan todo 23).
//
// It used to render each dictionary string through BOTH live legacy paths (the
// browser resolver and the node runtime) and assert they agreed. Once the legacy
// runtime retires there is no second live path to agree with — so the oracle it
// agreed with was FROZEN first (plan todo 19, `tests/fixtures/<locale>.rendered
// .json`, captured from the old implementation with both paths cross-checked
// key-for-key). This gate now renders through the NEW runtime — the generated
// message registry backing `m`, i.e. the exact module every call site reaches
// via `@ceraui/i18n/svelte` — and asserts byte equality with that frozen file.
//
// Both sides of "old render === new render" are therefore still proven, by two
// tests against ONE immutable fixture set:
//   - OLD  -> fixture: `rendered-oracle-gate.test.ts` renders the legacy runtime
//             live and diffs it against these files (it retires with that
//             runtime, at plan todo 24);
//   - NEW  -> fixture: this file, plus `paraglide-reverse-render-gate.test.ts`
//             for the whole catalog.
//
// The counts {0, 1, 2, 5, 11, 100} are the frozen set and hit every Arabic
// plural bucket: 0 zero, 1 one, 2 two, 5 few, 11 many, 100 other.
//
// The second structural assertion replaces the old branch-ARITY check. The
// legacy format encoded plural branches positionally (`{{a|b}}`), so a 4- or
// 5-branch group was malformed for every locale and pure parity could not catch
// it — both paths mis-handled it identically. The converted format is
// category-KEYED instead, so the equivalent defect is a variant set that does
// not cover exactly the locale's own CLDR categories, or whose `*` catch-all is
// not last (paraglide returns from the first matching variant in FILE ORDER, so
// a leading catch-all shadows every category above it).
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

/** The categories `Intl.PluralRules` can actually select for this locale. */
function cldrCategories(locale: LocaleCode): string[] {
	return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories];
}

interface VariantDefect {
	key: string;
	problem: string;
	got: string[];
}

/**
 * A variant set is legal when its match keys are exactly one per CLDR category
 * of the locale, plus a trailing `*` catch-all, all on the declared selector.
 */
function variantDefects(
	key: string,
	variants: ComplexMessage,
	locale: LocaleCode,
): VariantDefect[] {
	const defects: VariantDefect[] = [];
	const matchKeys = Object.keys(variants.match);
	const selector = variants.selectors[0];

	if (selector === undefined) {
		return [{ key, problem: "no selector declared", got: matchKeys }];
	}

	const expected = [
		...cldrCategories(locale).map((category) => `${selector}=${category}`),
		`${selector}=*`,
	];
	const missing = expected.filter((entry) => !matchKeys.includes(entry));
	const extra = matchKeys.filter((entry) => !expected.includes(entry));

	if (missing.length > 0) {
		defects.push({ key, problem: `missing variants: ${missing.join()}`, got: matchKeys });
	}
	if (extra.length > 0) {
		defects.push({ key, problem: `unexpected variants: ${extra.join()}`, got: matchKeys });
	}
	if (matchKeys.at(-1) !== `${selector}=*`) {
		defects.push({ key, problem: "catch-all is not last", got: matchKeys });
	}
	return defects;
}

/** Legacy `{{one|other}}` syntax must not survive anywhere in a catalog. */
const LEGACY_PLURAL_SYNTAX = /\{\{/;

function legacySyntaxHits(locale: LocaleCode): string[] {
	const hits: string[] = [];
	for (const [key, value] of Object.entries(readCatalog(locale))) {
		const patterns = isComplex(value)
			? Object.values(variantsOf(value).match)
			: [value];
		if (patterns.some((pattern) => LEGACY_PLURAL_SYNTAX.test(pattern))) {
			hits.push(key);
		}
	}
	return hits;
}

describe("plural-parity gate: walker sanity", () => {
	it("finds >0 plural messages in the en catalog (empty extraction FAILS)", () => {
		expect(pluralKeys("en").length).toBeGreaterThan(0);
	});

	it("rejects a malformed variant set (the structural gate has teeth)", () => {
		const legal: ComplexMessage = {
			declarations: ["input count", "local countPlural = count: plural"],
			selectors: ["countPlural"],
			match: { "countPlural=one": "a", "countPlural=other": "b", "countPlural=*": "b" },
		};
		expect(variantDefects("probe", legal, "en")).toEqual([]);

		const missingCategory: ComplexMessage = {
			...legal,
			match: { "countPlural=one": "a", "countPlural=*": "b" },
		};
		expect(variantDefects("probe", missingCategory, "en").length).toBeGreaterThan(0);

		const catchAllFirst: ComplexMessage = {
			...legal,
			match: { "countPlural=*": "b", "countPlural=one": "a", "countPlural=other": "b" },
		};
		expect(variantDefects("probe", catchAllFirst, "en")).toEqual([
			{ key: "probe", problem: "catch-all is not last", got: ["countPlural=*", "countPlural=one", "countPlural=other"] },
		]);

		const arabicSetUnderArabic: ComplexMessage = {
			...legal,
			match: { "countPlural=one": "a", "countPlural=other": "b", "countPlural=*": "b" },
		};
		expect(variantDefects("probe", arabicSetUnderArabic, "ar").length).toBeGreaterThan(0);
	});
});

const baseKeys = pluralKeys("en");
const invariantLocales: readonly LocaleCode[] = ["ja", "ko", "zh"];

it("the frozen counts reach all six Arabic cardinal categories", () => {
	const rules = new Intl.PluralRules("ar");
	expect(PLURAL_COUNTS.map((count) => rules.select(count))).toEqual([
		"zero", "one", "two", "few", "many", "other",
	]);
});

for (const locale of ALL_LOCALES) {
	const keys = pluralKeys(locale);
	const oracle = readRenderedOracle(locale);
	const params = readOracleParams(locale);
	const invariant = invariantLocales.includes(locale);
	const rules = new Intl.PluralRules(locale);

	describe(`plural-parity gate: ${locale} (${keys.length} plural message(s))`, () => {
		it("carries no legacy {{…}} plural syntax in any catalog entry", () => {
			expect(legacySyntaxHits(locale)).toEqual([]);
		});

		it("matches the base plural inventory and the frozen per-count fixtures", () => {
			expect(keys).toEqual(invariant ? [] : baseKeys);
			const frozenKeys = Object.keys(oracle).filter((key) => typeof oracle[key] === "object");
			expect(frozenKeys.sort()).toEqual(keys);
			const frozenParams = Object.keys(params.keys).filter((key) => params.keys[key]?.plural);
			expect(frozenParams.sort()).toEqual(keys);
		});

		it("every plural message covers exactly this locale's CLDR categories, catch-all last", () => {
			const catalog = readCatalog(locale);
			const defects = keys.flatMap((key) => {
				const value = catalog[key];
				if (value === undefined || !isComplex(value)) {
					return [{ key, problem: "not a variant message", got: [] }];
				}
				return variantDefects(key, variantsOf(value), locale);
			});
			expect(defects).toEqual([]);
		});

		for (const key of baseKeys) {
			const frozen = oracle[key];
			const spec = params.keys[key];
			// ja/ko/zh use invariant classifier phrases, frozen with one input set.
			const counts = invariant ? [undefined] : PLURAL_COUNTS;
			for (const count of counts) {
				const sample = count === undefined ? "invariant" : `count=${count} (${rules.select(count)})`;
				it(`${key} · ${sample} · m[key] === frozen oracle`, () => {
					const expected = typeof frozen === "string" ? frozen : frozen?.[String(count)];
					expect(expected).toBeString();
					expect(spec).toBeDefined();
					if (count !== undefined) expect(spec?.countParams.length).toBeGreaterThan(0);
					const inputs = count === undefined ? {} : Object.fromEntries(
						(spec?.countParams ?? []).map((name) => [name, count]),
					);
					const render = m[key];
					expect(render).toBeDefined();
					expect(render?.({ ...spec?.params, ...inputs }, { locale })).toBe(expected);
				});
			}
		}
	});
}
