import { describe, expect, it } from "bun:test";

import type { Locales } from "../src/i18n-types.js";
import { loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";

// ---------------------------------------------------------------------------
// PERMANENT locale-parity gate (todo 18, capability-first-live-experience).
//
// typesafe-i18n's generated `Translation` type already forces every non-EN
// locale's object literal to satisfy the FULL en shape at compile time (each
// locale file ends `} satisfies Translation`, and `Translation` requires every
// key en has — no `Partial`). This is a RUNTIME twin of that compile-time
// guarantee: it walks the LOADED dictionaries (the ones the app actually
// serves) and asserts exact key-set equality, so a drift is caught by `bun
// test` alone — no `svelte-check`/full tsc pass required, and it survives any
// future relaxation of the generated type.
//
// It also pins the two structural facts from the todo-18 sweep:
//   - every key added by todos 6, 10, 11, 12, 13 exists in all 10 locales
//     (covered implicitly by the whole-dictionary parity below, and cross-
//     checked explicitly per touched namespace);
//   - the `live.presets.*` object REMOVED by todo 9 stays removed everywhere
//     (a locale that reintroduces it would fail the whole-dictionary parity
//     check the moment it drifts from en).
// ---------------------------------------------------------------------------

loadAllLocales();

type Dict = Record<string, unknown>;

const ALL_LOCALES: Locales[] = [
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

const EN = loadedLocales.en as unknown as Dict;

/** Depth-first walk collecting every LEAF key as a dotted path, sorted. */
function collectKeyPaths(dict: Dict, prefix = ""): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(dict)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object" && !Array.isArray(v)) {
			out.push(...collectKeyPaths(v as Dict, path));
		} else {
			out.push(path);
		}
	}
	return out.sort();
}

/** Navigate a dotted path on a loaded dictionary; `undefined` if absent. */
function at(dict: Dict, path: string): unknown {
	return path.split(".").reduce<unknown>((cur, seg) => {
		if (cur && typeof cur === "object" && seg in (cur as Dict)) {
			return (cur as Dict)[seg];
		}
		return undefined;
	}, dict);
}

const EN_KEYS = collectKeyPaths(EN);

describe("locale-parity gate: walker sanity", () => {
	it("collects a non-trivial key set from en (empty extraction FAILS)", () => {
		expect(EN_KEYS.length).toBeGreaterThan(500);
	});
});

describe("locale-parity gate: whole-dictionary key-set equality (all 10 locales)", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale}: exact same key set as en (no missing, no orphan keys)`, () => {
			const keys = collectKeyPaths(loadedLocales[locale] as unknown as Dict);
			const missing = EN_KEYS.filter((k) => !keys.includes(k));
			const extra = keys.filter((k) => !EN_KEYS.includes(k));
			expect({ missing, extra }).toEqual({ missing: [], extra: [] });
		});
	}
});

// The exact namespaces todos 6/9-13 touched (task-18 spec, verbatim list).
const TOUCHED_NAMESPACE_PREFIXES = [
	"live.source.",
	"audio.sources.",
	"live.encoder.",
	"live.comingSoon.",
	"live.networkIngest.",
	"live.education.reason.",
] as const;

describe("locale-parity gate: touched-namespace key-set equality (todos 6, 10-13)", () => {
	for (const prefix of TOUCHED_NAMESPACE_PREFIXES) {
		const enKeysInNamespace = EN_KEYS.filter((k) => k.startsWith(prefix));

		it(`en carries keys under "${prefix}" (namespace sanity)`, () => {
			expect(enKeysInNamespace.length).toBeGreaterThan(0);
		});

		for (const locale of ALL_LOCALES) {
			it(`${locale}: "${prefix}*" matches en exactly`, () => {
				const localeKeys = collectKeyPaths(
					loadedLocales[locale] as unknown as Dict,
				).filter((k) => k.startsWith(prefix));
				expect(localeKeys).toEqual(enKeysInNamespace);
			});
		}
	}
});

// Todo 9 removed the `live.presets.{heading,advanced,applying,applied,failed}`
// object from every locale. `live.streamTuning.presets` ("Profile presets", a
// plain STRING, not an object) is a DIFFERENT, still-live key — this gate must
// not confuse the two (see notepad "Todo 9").
describe("locale-parity gate: todo-9 removed keys stay absent (no orphans)", () => {
	const REMOVED_PRESET_LEAVES = [
		"live.presets.heading",
		"live.presets.advanced",
		"live.presets.applying",
		"live.presets.applied",
		"live.presets.failed",
	] as const;

	it("en confirms live.presets is not an object namespace", () => {
		expect(at(EN, "live.presets")).toBeUndefined();
	});

	for (const locale of [...ALL_LOCALES, "en" as Locales]) {
		it(`${locale}: none of the removed live.presets.* leaves are present`, () => {
			const dict = loadedLocales[locale] as unknown as Dict;
			for (const leaf of REMOVED_PRESET_LEAVES) {
				expect(at(dict, leaf)).toBeUndefined();
			}
		});
	}
});
