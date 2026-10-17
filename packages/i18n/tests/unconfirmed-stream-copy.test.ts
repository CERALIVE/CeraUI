import { describe, expect, it } from "bun:test";

import { ALL_LOCALES, catalogKeys, readCatalog } from "./helpers/catalog.js";

// The Live view's unconfirmed-stream band. Every key must exist in all ten
// catalogs as a real, placeholder-free string, and the Latin-script locales must
// not be an English copy.
const KEYS = [
	"live.unconfirmedStream.title",
	"live.unconfirmedStream.body",
	"live.unconfirmedStream.stopFailed",
	"live.unconfirmedStream.stopNotConfirmed",
] as const;

const PLACEHOLDER_RE = /\{[^}]*\}/g;

describe("unconfirmed-stream band copy", () => {
	it("covers exactly ten catalogs", () => {
		expect(ALL_LOCALES.length).toBe(10);
	});

	it("adds the same four keys, in the same file order, to every catalog", () => {
		const fileOrder = (locale: (typeof ALL_LOCALES)[number]) =>
			Object.keys(readCatalog(locale)).filter((k) => k.startsWith("live.unconfirmedStream."));
		for (const locale of ALL_LOCALES) {
			expect(fileOrder(locale)).toEqual([...KEYS]);
		}
	});

	it("leaves every catalog with the same key set as en", () => {
		const en = catalogKeys("en");
		for (const locale of ALL_LOCALES) {
			expect(catalogKeys(locale)).toEqual(en);
		}
	});

	for (const locale of ALL_LOCALES) {
		for (const key of KEYS) {
			it(`${locale} ${key}: non-empty string with the same placeholders as en`, () => {
				const value = readCatalog(locale)[key];
				expect(typeof value).toBe("string");
				expect((value as string).trim().length).toBeGreaterThan(0);
				const en = readCatalog("en")[key] as string;
				expect((value as string).match(PLACEHOLDER_RE) ?? []).toEqual(
					en.match(PLACEHOLDER_RE) ?? [],
				);
			});
		}
	}

	for (const locale of ["es", "pt-BR", "fr", "de"] as const) {
		it(`${locale} is translated, not copied from en`, () => {
			for (const key of KEYS) {
				expect(readCatalog(locale)[key]).not.toBe(readCatalog("en")[key]);
			}
		});
	}

	it("es speaks to the operator as tú (neutral Latin-American Spanish)", () => {
		const es = readCatalog("es");
		expect(es["live.unconfirmedStream.body"]).toContain("Detén la transmisión");
		expect(es["live.unconfirmedStream.stopFailed"]).toContain("Intenta");
		expect(es["live.unconfirmedStream.stopNotConfirmed"]).toContain("Puedes");
		for (const key of KEYS) {
			expect(es[key] as string).not.toMatch(/\b(vosotros|podéis|intentad|detened|usted)\b/i);
		}
	});

	it("never claims the stream is or is not live", () => {
		const en = readCatalog("en");
		expect(en["live.unconfirmedStream.title"]).toBe("Stream state not confirmed");
		expect(en["live.unconfirmedStream.body"]).toContain("can't confirm whether a stream is still running");
		for (const key of KEYS) {
			expect(en[key] as string).not.toMatch(
				/\b(the stream (is|isn't|is not) (live|running)|the stream has stopped|no stream is running)\b/i,
			);
		}
	});
});
