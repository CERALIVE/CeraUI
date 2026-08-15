import { describe, expect, it } from "bun:test";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_LOCALES, collectLeaves } from "../scripts/generate-fixtures.js";
import { assertInjectiveModuleIds, toSafeModuleId } from "../scripts/message-format.js";
import type { Locales } from "../src/i18n-types.js";
import { loadedLocales } from "../src/i18n-util.js";
import { loadAllLocales } from "../src/i18n-util.sync.js";

// ---------------------------------------------------------------------------
// CONVERSION GATE — completeness and safety of the converted catalog.
//
// Companion to the reverse-render gate (which proves the VALUES are byte-exact).
// This file proves the KEY SET is exact and that paraglide can carry it at all:
// every bundle id is mapped through paraglide's lossy `toSafeModuleId`, and two
// keys colliding there would make one message silently overwrite the other with
// no warning from the compiler.
// ---------------------------------------------------------------------------

loadAllLocales();

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function dictionaryKeys(locale: Locales): string[] {
	const dict = loadedLocales[locale] as unknown as Record<string, unknown>;
	return collectLeaves(dict).map((leaf) => leaf.key);
}

function catalogKeys(locale: Locales): string[] {
	const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, "messages", `${locale}.json`), "utf8")) as Record<
		string,
		unknown
	>;
	return Object.keys(file).filter((key) => key !== "$schema");
}

const BASE_KEYS = dictionaryKeys("en");

describe("converted inlang catalog", () => {
	it("passes the safe-module-id injectivity pre-flight", () => {
		expect(assertInjectiveModuleIds(BASE_KEYS).size).toBe(BASE_KEYS.length);
	});

	it("carries the full catalog (an empty or truncated conversion FAILS)", () => {
		expect(BASE_KEYS.length).toBeGreaterThan(1000);
	});

	for (const locale of ALL_LOCALES) {
		it(`${locale}: catalog key set equals the dictionary key set, verbatim`, () => {
			expect(catalogKeys(locale).sort()).toEqual(dictionaryKeys(locale).sort());
		});
	}

	it("declares the inlang schema in every catalog", () => {
		for (const locale of ALL_LOCALES) {
			const file = JSON.parse(readFileSync(join(PACKAGE_ROOT, "messages", `${locale}.json`), "utf8")) as {
				$schema?: string;
			};
			expect(file.$schema).toBe("https://inlang.com/schema/inlang-message-format");
		}
	});

	it("compiles messages into per-message modules named by our own safe-module-id mirror", () => {
		// Proves the local `toSafeModuleId` mirror still matches paraglide's real
		// one — the injectivity pre-flight is only as trustworthy as this mirror.
		const emitted = readdirSync(join(PACKAGE_ROOT, "src", "paraglide", "messages"))
			.filter((name) => name.endsWith(".js") && name !== "_index.js")
			.sort();
		expect(emitted).toEqual(BASE_KEYS.map((key) => `${toSafeModuleId(key)}.js`).sort());
	});

	it("pins outputStructure: message-modules in the compile invocation", () => {
		const script = readFileSync(join(PACKAGE_ROOT, "scripts", "compile-messages.ts"), "utf8");
		expect(script).toContain('outputStructure: "message-modules"');
	});
});
