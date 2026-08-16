import { describe, expect, it } from "bun:test";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertInjectiveModuleIds, toSafeModuleId } from "../scripts/module-id.js";
import { ALL_LOCALES, catalogKeys, readCatalogFile } from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// CATALOG CARRIABILITY GATE — can paraglide carry this key set at all?
//
// Companion to the reverse-render gate (which proves the VALUES are byte-exact).
// This file proves the KEY SET survives the trip through paraglide's lossy
// `toSafeModuleId`: two keys colliding there would make one message silently
// overwrite the other with no warning from the compiler.
//
// Before the cutover this gate also diffed the catalogs against the legacy
// TypeScript dictionaries. Those are gone (plan todo 24) and the catalogs ARE
// the source of truth now, so that half would compare the catalog to itself.
// Cross-locale key-set equality is asserted by `locale-parity-gate.test.ts`.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BASE_KEYS = catalogKeys("en");

describe("inlang catalog", () => {
	it("passes the safe-module-id injectivity pre-flight", () => {
		expect(assertInjectiveModuleIds(BASE_KEYS).size).toBe(BASE_KEYS.length);
	});

	it("carries the full catalog (an empty or truncated catalog FAILS)", () => {
		expect(BASE_KEYS.length).toBeGreaterThan(1000);
	});

	it("declares the inlang schema in every catalog", () => {
		for (const locale of ALL_LOCALES) {
			expect(readCatalogFile(locale).$schema).toBe("https://inlang.com/schema/inlang-message-format");
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
