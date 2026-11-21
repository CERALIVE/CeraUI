/**
 * The locale-parity gate cannot see a key missing from every catalog, and
 * `resolveMessageKey` would render it as the dotted key, so the required keys
 * come from the dialog's own stage table.
 */

import { logBundleFailureReasonSchema } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { BUNDLE_FAILURE_COPY_KEYS } from "$lib/device-logs/sharing";

import { CATALOGS } from "./helpers/catalog";

const KEYS = [...new Set(Object.values(BUNDLE_FAILURE_COPY_KEYS))];

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

describe("the copy table covers the closed stage vocabulary", () => {
	it("names every stage, sharing a sentence only where the remedy is the same", () => {
		expect(Object.keys(BUNDLE_FAILURE_COPY_KEYS).sort()).toEqual(
			[...logBundleFailureReasonSchema.options].sort(),
		);
		expect(BUNDLE_FAILURE_COPY_KEYS.internal).toBe(
			"systemLogs.sharing.bundleFailed",
		);
		expect(BUNDLE_FAILURE_COPY_KEYS.deadline).toBe(
			BUNDLE_FAILURE_COPY_KEYS.abort,
		);
		expect(KEYS).toHaveLength(6);
	});
});

describe("every locale carries a distinct, translated sentence per stage", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		const texts = KEYS.map((key) => lookup(CATALOGS[locale], key));
		for (const [index, text] of texts.entries()) {
			expect(typeof text, `${locale}:${KEYS[index]}`).toBe("string");
			expect(String(text)).not.toMatch(/[{}]|READ_FAILED|journal_read|_/);
		}
		expect(new Set(texts).size).toBe(KEYS.length);
	});

	it.each(KEYS)("%s differs from en in every other locale", (key) => {
		const english = lookup(CATALOGS.en, key);
		const duplicates = Object.entries(CATALOGS)
			.filter(([locale]) => locale !== "en")
			.filter(([, catalog]) => lookup(catalog, key) === english)
			.map(([locale]) => locale);
		expect(duplicates).toEqual([]);
	});

	it("the Spanish copy addresses the operator with tú, never usted or vosotros", () => {
		for (const key of KEYS) {
			const text = String(lookup(CATALOGS.es, key)).toLowerCase();
			expect(text, key).not.toMatch(/\busted(es)?\b|\bvosotros\b|\bvuestr/);
		}
	});
});
