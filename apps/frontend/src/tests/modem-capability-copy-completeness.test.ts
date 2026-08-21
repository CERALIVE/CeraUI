/**
 * EVERY CAPABILITY MODULE HAS SETTINGS COPY, IN ALL TEN LOCALES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PARITY GATE CANNOT CATCH THIS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts the ten catalogs
 * carry the SAME key set, which is exactly the wrong shape for this defect: a
 * key missing from every locale is perfectly in parity. This is the same hole
 * `usb-mode-copy-completeness.test.ts` was written to close, and the same
 * mechanism closes it.
 *
 * It matters here because `ModemCapabilitiesDialog` resolves its per-module
 * label and description DYNAMICALLY (`resolveMessageKey`), which renders an
 * unknown key as the dotted key itself. `CAPABILITY_MODULES` is a seven-member
 * wire enum and only four are implemented today, so the day an eighth module
 * lands — or the day one of the three unimplemented ones is switched on — a row
 * would silently print `settings.modemCapabilities.module.esim` at an operator.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REQUIRED LIST IS DERIVED FROM THE WIRE ENUM, NEVER RE-TYPED
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Copy is required for ALL SEVEN modules, not just the implemented four. The
 * dialog hides an unimplemented module today (DESIGN.md CT-1), so a re-typed
 * list would track the implemented set and go stale on exactly the change that
 * needs it — a module becoming implemented is precisely when its copy must
 * already exist.
 */

import { CAPABILITY_MODULES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { CATALOGS } from "./helpers/catalog";

/** The dialog's non-module copy — the surface a module row sits inside. */
const SURFACE_KEYS: readonly string[] = [
	"settings.index.modemCapabilities",
	"settings.index.modemCapabilitiesDesc",
	"settings.modemCapabilities.title",
	"settings.modemCapabilities.description",
	"settings.modemCapabilities.explanation",
	"settings.modemCapabilities.honesty",
	"settings.modemCapabilities.empty",
	"settings.modemCapabilities.refused",
	"settings.modemCapabilities.loadFailed",
	"settings.modemCapabilities.saveFailed",
];

const REQUIRED_KEYS: readonly string[] = [
	...SURFACE_KEYS,
	...CAPABILITY_MODULES.map(
		(module) => `settings.modemCapabilities.module.${module}`,
	),
	...CAPABILITY_MODULES.map(
		(module) => `settings.modemCapabilities.moduleDesc.${module}`,
	),
];

/**
 * Pure so the falsifiability proof below can hand it a damaged clone instead of
 * editing a catalog on disk — a gate nobody can cheaply prove red is a gate
 * nobody trusts.
 */
function missingCopyKeys(catalog: unknown, keys: readonly string[]): string[] {
	return keys.filter((key) => typeof lookup(catalog, key) !== "string");
}

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

function withoutKey(catalog: unknown, key: string): unknown {
	const clone = structuredClone(catalog) as Record<string, unknown>;
	const segments = key.split(".");
	let cursor: Record<string, unknown> = clone;
	for (const segment of segments.slice(0, -1)) {
		cursor = cursor[segment] as Record<string, unknown>;
	}
	delete cursor[segments.at(-1) as string];
	return clone;
}

describe("the required list is derived, and covers the UNIMPLEMENTED modules too", () => {
	it("asks for a label and a description per module, plus the surface copy", () => {
		expect(CAPABILITY_MODULES.length).toBe(7);
		expect(new Set(REQUIRED_KEYS).size).toBe(SURFACE_KEYS.length + 7 * 2);
	});

	it("names the three modules this build does NOT implement", () => {
		// Spelled out because these are the ones a derived list that quietly
		// started tracking `implemented` would drop — and they are the exact
		// modules whose first render would print a raw key.
		for (const module of ["sms", "esim", "fcc-auto-unlock"]) {
			expect(REQUIRED_KEYS).toContain(
				`settings.modemCapabilities.module.${module}`,
			);
			expect(REQUIRED_KEYS).toContain(
				`settings.modemCapabilities.moduleDesc.${module}`,
			);
		}
	});
});

describe("every locale carries copy for every capability module", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});
});

describe("the check is falsifiable — it FAILS on a removed key", () => {
	it.each(Object.keys(CATALOGS))(
		"%s — a removed module label is reported",
		(locale) => {
			const key = "settings.modemCapabilities.module.gps";
			const damaged = withoutKey(CATALOGS[locale], key);
			expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
		},
	);

	it("a removed surface key is reported too", () => {
		const key = "settings.modemCapabilities.honesty";
		const damaged = withoutKey(CATALOGS.en, key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});
});

describe("the copy never states a capability the gate cannot grant", () => {
	it("the honesty line survives in every locale and is not the English one", () => {
		const rendered = Object.entries(CATALOGS).map(
			([locale, catalog]) =>
				[
					locale,
					lookup(catalog, "settings.modemCapabilities.honesty"),
				] as const,
		);
		for (const [, value] of rendered) {
			expect(typeof value).toBe("string");
			expect((value as string).length).toBeGreaterThan(0);
		}
		// A locale that merely copied `en` would defeat the point of the note.
		const english = lookup(CATALOGS.en, "settings.modemCapabilities.honesty");
		const duplicates = rendered.filter(
			([locale, value]) => locale !== "en" && value === english,
		);
		expect(duplicates).toEqual([]);
	});
});
