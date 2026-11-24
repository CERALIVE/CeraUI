/**
 * The router-dongle settings notes are TRANSLATED, not just present.
 *
 * The locale parity gate only proves all ten catalogs carry the same keys; an
 * English value pasted into another catalog is perfectly in parity. This is the
 * `no-sim-copy.test.ts` detector for the three evidence-keyed notes, whose keys
 * come out of `routerSettingsNoteKey` itself so a rename cannot orphan the gate.
 */
import type { Modem } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { routerSettingsNoteKey } from "../main/network/cellular-row";
import { CATALOGS } from "./helpers/catalog";

const ADMIN = { admin_url: "http://192.168.8.1" };

const KEYS = [
	{ ...ADMIN, reachable: true, controls: { mobile_data: true } },
	{ ...ADMIN, reachable: true },
	undefined,
].map((router_admin) =>
	routerSettingsNoteKey({
		device_class: "router-ethernet",
		router_admin,
	} as Modem),
);

const NON_ENGLISH = Object.keys(CATALOGS).filter((locale) => locale !== "en");

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

function untranslatedKeys(catalog: unknown, english: unknown): string[] {
	return KEYS.filter((key) => lookup(catalog, key) === lookup(english, key));
}

describe("the three notes the row renders", () => {
	it("are three distinct keys", () => {
		expect(new Set(KEYS).size).toBe(3);
	});

	it.each(Object.keys(CATALOGS))("%s carries every one", (locale) => {
		for (const key of KEYS) {
			expect(typeof lookup(CATALOGS[locale], key), key).toBe("string");
		}
	});

	it.each(NON_ENGLISH)("%s translates every one", (locale) => {
		expect(untranslatedKeys(CATALOGS[locale], CATALOGS.en)).toEqual([]);
	});

	it("reports an English value pasted into another catalog", () => {
		const damaged = structuredClone(CATALOGS.es);
		damaged.network.cellular.routerSettings.unknown =
			CATALOGS.en.network.cellular.routerSettings.unknown;
		expect(untranslatedKeys(damaged, CATALOGS.en)).toEqual([
			"network.cellular.routerSettings.unknown",
		]);
	});
});
