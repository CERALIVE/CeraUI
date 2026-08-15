import { describe, expect, it } from "bun:test";

import {
	BASE_LOCALE,
	directionFor,
	isSupportedLocale,
	LOCALES,
	resolveInitialLocale,
	RTL_LANGUAGES,
} from "../src/locale-lifecycle.js";

describe("locale constants", () => {
	it("ships the ten catalog locales", () => {
		expect(LOCALES.map((entry) => entry.code).sort()).toEqual(
			["ar", "de", "en", "es", "fr", "hi", "ja", "ko", "pt-BR", "zh"].sort(),
		);
	});

	it("keeps the pre-migration RTL list as the direction source", () => {
		expect([...RTL_LANGUAGES]).toEqual(["ar", "he", "fa", "ur"]);
	});

	it("resolves text direction from that list", () => {
		expect(directionFor("ar")).toBe("rtl");
		expect(directionFor("he")).toBe("rtl");
		expect(directionFor("en")).toBe("ltr");
		expect(directionFor("ja")).toBe("ltr");
	});
});

describe("startup locale priority", () => {
	it("prefers a saved preference over the browser", () => {
		const resolved = resolveInitialLocale("ja", "de-DE");
		expect(resolved).toEqual({ locale: "ja", source: "saved" });
	});

	it("falls back to the browser locale when nothing is saved", () => {
		const resolved = resolveInitialLocale(undefined, "de-DE");
		expect(resolved).toEqual({ locale: "de", source: "navigator" });
	});

	it("matches a region-tagged locale whole before its base subtag", () => {
		expect(resolveInitialLocale(undefined, "pt-BR").locale).toBe("pt-BR");
		expect(resolveInitialLocale(undefined, "pt-PT").locale).toBe(BASE_LOCALE);
	});

	it("falls back to en when neither input names a shipped locale", () => {
		const resolved = resolveInitialLocale(undefined, "sv-SE");
		expect(resolved).toEqual({ locale: "en", source: "base" });
	});

	it("REPORTS an unsupported saved locale instead of silently dropping it", () => {
		const resolved = resolveInitialLocale("xx", "de-DE");
		expect(resolved.locale).toBe("de");
		expect(resolved.rejectedSaved).toBe("xx");
	});

	it("still reports the rejected saved locale when it falls all the way to en", () => {
		const resolved = resolveInitialLocale("xx", undefined);
		expect(resolved).toEqual({
			locale: "en",
			source: "base",
			rejectedSaved: "xx",
		});
	});

	it("treats an empty saved value as absent, not as a rejection", () => {
		expect(resolveInitialLocale("", "fr").rejectedSaved).toBeUndefined();
	});
});

describe("isSupportedLocale", () => {
	it("accepts every shipped code and rejects everything else", () => {
		for (const entry of LOCALES) {
			expect(isSupportedLocale(entry.code)).toBe(true);
		}
		expect(isSupportedLocale("he")).toBe(false);
		expect(isSupportedLocale(undefined)).toBe(false);
	});
});
