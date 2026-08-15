import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Locales } from "../src/i18n-types.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";
import {
	ALL_LOCALES,
	PLURAL_COUNTS,
	type RenderedValue,
	renderLocale,
} from "../scripts/generate-fixtures.js";

// ---------------------------------------------------------------------------
// FROZEN RENDERED-STRING ORACLE — comparison gate.
//
// `tests/fixtures/<locale>.rendered.json` was captured from the CURRENT runtime
// (custom Svelte-5 adapter resolver + the typesafe-i18n node oracle, which the
// generator proves agree key-for-key) with deterministic params. Those files are
// APPEND-ONLY from here on: they are the oracle the Paraglide migration must
// byte-match, so a change to any dictionary string that is not accompanied by a
// deliberate, separately-reviewed fixture update FAILS here.
//
// This test derives its expectation from the DICTIONARIES, not from a hardcoded
// table — mutate one `en` string and the corresponding assertion goes red.
//
// It SURVIVES the migration by swapping `renderLocale` (the legacy render path)
// for the paraglide render, leaving the fixtures untouched.
// ---------------------------------------------------------------------------

loadAllLocales();

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(locale: Locales): Record<string, RenderedValue> {
	return JSON.parse(readFileSync(join(FIXTURES_DIR, `${locale}.rendered.json`), "utf8")) as Record<
		string,
		RenderedValue
	>;
}

describe("frozen rendered oracle", () => {
	it("covers exactly the 10 shipped locales", () => {
		expect([...ALL_LOCALES].sort()).toEqual(
			["ar", "de", "en", "es", "fr", "hi", "ja", "ko", "pt-BR", "zh"].sort() as Locales[],
		);
	});

	it("renders plural keys at every Arabic CLDR bucket", () => {
		expect([...PLURAL_COUNTS]).toEqual([0, 1, 2, 5, 11, 100]);
	});

	for (const locale of ALL_LOCALES) {
		describe(locale, () => {
			const fixture = readFixture(locale);
			const live = renderLocale(locale).rendered;

			it("key set matches the dictionary exactly (no added, no removed keys)", () => {
				expect(Object.keys(live).sort()).toEqual(Object.keys(fixture).sort());
			});

			it("every rendered value byte-matches the frozen fixture", () => {
				// One assertion over the whole map: a mismatch names the exact key.
				expect(live).toEqual(fixture);
			});

			it("carries the full >1000-key catalog (an empty extraction FAILS)", () => {
				expect(Object.keys(fixture).length).toBeGreaterThan(1000);
			});
		});
	}
});
