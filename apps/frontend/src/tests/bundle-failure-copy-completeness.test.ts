/**
 * The locale-parity gate cannot see a key missing from every catalog, and
 * `resolveMessageKey` would render it as the dotted key, so every sentence the
 * dialog's stage table names is rendered through the real facade per locale.
 */

import { resolveMessageKey, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { BUNDLE_FAILURE_COPY_KEYS } from "$lib/device-logs/sharing";

import { CATALOGS } from "./helpers/catalog";

const KEYS = [...new Set(Object.values(BUNDLE_FAILURE_COPY_KEYS))];
const LOCALES = Object.keys(CATALOGS);

function rendered(locale: string): string[] {
	setLocale(locale);
	return KEYS.map((key) => resolveMessageKey(key));
}

afterEach(() => {
	setLocale("en");
});

describe("every refused-bundle stage renders its own translated sentence", () => {
	it.each(LOCALES)(
		"%s renders each sentence, distinct and free of machine text",
		(locale) => {
			const texts = rendered(locale);
			for (const [index, text] of texts.entries()) {
				expect(text, `${locale}:${KEYS[index]}`).not.toBe(KEYS[index]);
				expect(text).not.toMatch(/[{}]|READ_FAILED|journal_read|systemLogs\./);
			}
			expect(new Set(texts).size).toBe(KEYS.length);
		},
	);

	it("each sentence differs from English in every other locale", () => {
		const english = rendered("en");
		for (const locale of LOCALES.filter((locale) => locale !== "en")) {
			const texts = rendered(locale);
			for (const [index, text] of texts.entries())
				expect(text, `${locale}:${KEYS[index]}`).not.toBe(english[index]);
		}
	});

	it("the Spanish copy addresses the operator with tú, never usted or vosotros", () => {
		for (const text of rendered("es"))
			expect(text.toLowerCase()).not.toMatch(
				/\busted(es)?\b|\bvosotros\b|\bvuestr/,
			);
	});
});
