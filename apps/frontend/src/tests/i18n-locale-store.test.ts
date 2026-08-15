/**
 * @vitest-environment jsdom
 */

import {
	directionFor,
	getLocale,
	initLocale,
	m,
	resolveMessageKey,
	setLocale,
} from "@ceraui/i18n/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The `<html lang>` / `<html dir>` pair is a CONTRACT, not a nicety: the e2e
// locale-parity spec asserts `<html dir="rtl" lang="ar">` directly. Paraglide's
// `setLocale(next, { reload: false })` writes neither, so these tests are what
// prove the store still does.

describe("locale store — startup priority", () => {
	beforeEach(() => {
		document.documentElement.lang = "";
		document.documentElement.dir = "";
		setLocale("en");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("prefers the saved preference over the browser locale", () => {
		expect(initLocale({ saved: "ja", navigatorLanguage: "de-DE" })).toBe("ja");
		expect(getLocale()).toBe("ja");
	});

	it("falls back to the browser locale when nothing is saved", () => {
		expect(initLocale({ navigatorLanguage: "de-DE" })).toBe("de");
	});

	it("falls back to en when neither input names a shipped locale", () => {
		expect(initLocale({ navigatorLanguage: "sv-SE" })).toBe("en");
	});

	it("warns about an unsupported saved locale instead of failing silently", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(initLocale({ saved: "xx", navigatorLanguage: "sv-SE" })).toBe("en");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("xx");
	});

	it("applies the resolved locale to the document at startup", () => {
		initLocale({ saved: "ar" });
		expect(document.documentElement.lang).toBe("ar");
		expect(document.documentElement.dir).toBe("rtl");
	});
});

describe("locale store — setLocale", () => {
	beforeEach(() => {
		setLocale("en");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("switches the rendered locale synchronously", () => {
		expect(m["live.setup.title"]?.()).toBe("Stream setup");
		setLocale("ar");
		expect(getLocale()).toBe("ar");
		expect(m["live.setup.title"]?.()).toBe("إعداد البث");
	});

	it("syncs <html lang> and <html dir> on every switch, both directions", () => {
		setLocale("ar");
		expect(document.documentElement.lang).toBe("ar");
		expect(document.documentElement.dir).toBe("rtl");

		setLocale("ja");
		expect(document.documentElement.lang).toBe("ja");
		expect(document.documentElement.dir).toBe("ltr");
	});

	it("falls back to en with a warning for an unknown locale", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(setLocale("xx")).toBe("en");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(document.documentElement.dir).toBe("ltr");
	});

	it("keeps the RTL list as the direction source, not a paraglide helper", () => {
		expect(directionFor("ar")).toBe("rtl");
		expect(directionFor("he")).toBe("rtl");
		expect(directionFor("en")).toBe("ltr");
	});
});

describe("locale store — resolveMessageKey", () => {
	beforeEach(() => {
		setLocale("en");
	});

	it("renders a known key", () => {
		expect(resolveMessageKey("live.setup.title")).toBe("Stream setup");
	});

	it("returns an unknown key as itself", () => {
		expect(resolveMessageKey("no.such.key")).toBe("no.such.key");
	});

	it("passes params through", () => {
		expect(resolveMessageKey("live.setup.linksReady", { count: 2 })).toBe(
			"2 links ready",
		);
	});

	it("follows the active locale", () => {
		setLocale("ar");
		expect(resolveMessageKey("live.setup.title")).toBe("إعداد البث");
	});
});
