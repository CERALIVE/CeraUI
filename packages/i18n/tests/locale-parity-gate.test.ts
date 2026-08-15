import { describe, expect, it } from "bun:test";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import {
	ALL_LOCALES,
	catalogKeys,
	NON_BASE_LOCALES,
	readCatalog,
} from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// PERMANENT locale-parity gate (todo 18, capability-first-live-experience;
// repointed at the inlang catalogs by plan todo 23).
//
// The legacy generated `Translation` type used to force every non-EN dictionary
// to satisfy the full `en` shape at compile time, and this gate was the RUNTIME
// twin of that guarantee. The catalogs carry no such type — `messages/*.json` is
// plain data — so after the migration this gate is not a twin of anything: it is
// the ONLY thing standing between a hand-edited catalog and a locale that
// silently ships a missing (or orphaned) key. It walks `messages/<locale>.json`,
// the file the app actually compiles and serves, and asserts exact key-set
// equality across all ten locales.
//
// It also pins the two structural facts from the todo-18 sweep:
//   - every key added by todos 6, 10, 11, 12, 13 exists in all 10 locales
//     (covered implicitly by the whole-catalog parity below, and cross-checked
//     explicitly per touched namespace);
//   - the `live.presets.*` object REMOVED by todo 9 stays removed everywhere.
// ---------------------------------------------------------------------------

const EN = readCatalog("en");
const EN_KEYS = catalogKeys("en");

/** A dotted key resolves to its catalog entry; `undefined` if absent. */
function at(locale: LocaleCode, key: string): unknown {
	return readCatalog(locale)[key];
}

describe("locale-parity gate: walker sanity", () => {
	it("collects a non-trivial key set from en (empty extraction FAILS)", () => {
		expect(EN_KEYS.length).toBeGreaterThan(500);
	});
});

describe("locale-parity gate: whole-catalog key-set equality (all 10 locales)", () => {
	for (const locale of NON_BASE_LOCALES) {
		it(`${locale}: exact same key set as en (no missing, no orphan keys)`, () => {
			const keys = catalogKeys(locale);
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

		for (const locale of NON_BASE_LOCALES) {
			it(`${locale}: "${prefix}*" matches en exactly`, () => {
				const localeKeys = catalogKeys(locale).filter((k) =>
					k.startsWith(prefix),
				);
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

	it("en confirms live.presets is not a live namespace", () => {
		expect(EN_KEYS.filter((k) => k.startsWith("live.presets."))).toEqual([]);
		expect(at("en", "live.presets")).toBeUndefined();
	});

	for (const locale of ALL_LOCALES) {
		it(`${locale}: none of the removed live.presets.* leaves are present`, () => {
			for (const leaf of REMOVED_PRESET_LEAVES) {
				expect(at(locale, leaf)).toBeUndefined();
			}
		});
	}
});

// The catalogs are the app's own source of truth now, so an entry that is
// neither a pattern string nor a variant array would compile into something the
// registry cannot call. Legacy parity never had to check this — the dictionaries
// were typed — so it is ADDED here rather than carried over.
describe("locale-parity gate: every catalog entry has a renderable shape", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale}: every entry is a pattern string or a one-element variant array`, () => {
			const malformed = Object.entries(readCatalog(locale))
				.filter(([, value]) => {
					if (typeof value === "string") return false;
					return !(
						Array.isArray(value) &&
						value.length === 1 &&
						typeof value[0] === "object"
					);
				})
				.map(([key]) => key);
			expect(malformed).toEqual([]);
		});
	}
});
