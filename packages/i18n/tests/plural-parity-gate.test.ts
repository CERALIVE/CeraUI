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

/** The inputs the frozen oracle used for one plural key at one count. */
function pluralInputs(
	locale: LocaleCode,
	key: string,
	count: number,
): Record<string, number> {
	const spec = readOracleParams(locale).keys[key];
	if (spec?.plural !== true) {
		throw new Error(`frozen oracle has no plural spec for ${locale}:${key}`);
	}
	return Object.fromEntries(spec.countParams.map((name) => [name, count]));
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

for (const locale of ALL_LOCALES) {
	const keys = pluralKeys(locale);

	describe(`plural-parity gate: ${locale} (${keys.length} plural message(s))`, () => {
		it("carries no legacy {{…}} plural syntax in any catalog entry", () => {
			expect(legacySyntaxHits(locale)).toEqual([]);
		});

		it("the frozen oracle carries a per-count render for every plural message", () => {
			const oracle = readRenderedOracle(locale);
			const notFrozen = keys.filter((key) => typeof oracle[key] !== "object");
			expect(notFrozen).toEqual([]);
		});

		// ja/ko/zh carry no plural syntax — they still run through the walker and
		// pass trivially (the locale IS included in the gate).
		if (keys.length === 0) {
			it("has no plural syntax — trivially passes the gate", () => {
				expect(keys).toEqual([]);
			});
			return;
		}

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

		for (const key of keys) {
			for (const count of PLURAL_COUNTS) {
				const category = new Intl.PluralRules(locale).select(count);
				it(`${key} · count=${count} (${category}) · m[key] === frozen oracle`, () => {
					const frozen = readRenderedOracle(locale)[key];
					expect(typeof frozen).toBe("object");
					const expected = (frozen as Record<string, string>)[String(count)];
					const render = m[key];
					expect(render).toBeDefined();
					expect(render?.(pluralInputs(locale, key, count), { locale })).toBe(
						expected,
					);
				});
			}
		}
	});
}
