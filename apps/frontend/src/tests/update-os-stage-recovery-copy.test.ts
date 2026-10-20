/**
 * @vitest-environment jsdom
 */

/**
 * The three OS-staging recovery notices are raised by the backend with a
 * version parameter only and rendered through `resolveMessageKey`, which shows
 * an unknown key as the dotted key itself. So every locale must render each one
 * as real prose that names the version, the three must read differently (they
 * ask for three different operator actions), and no machine reason may leak.
 */

import { resolveMessageKey, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { CATALOGS } from "./helpers/catalog";

const KEYS = [
	"notifications.updateSystemStageRetry",
	"notifications.updateSystemStageOperator",
	"notifications.updateSystemStageUnresolved",
] as const;
const VERSION = "2026.10.40";
const MACHINE_TOKENS = [
	"{",
	"rauc",
	"os_",
	"_failed",
	"unproven",
	".service",
	"/",
	"systemctl",
	"journalctl",
];

afterEach(() => {
	setLocale("en");
});

function catalogEntry(locale: string, key: string): unknown {
	let cursor: unknown = CATALOGS[locale];
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

// Rendering falls back to the base locale, so presence is asserted on the
// catalog itself: a missing translation must not pass as English.
describe("every catalog carries its own OS staging recovery copy", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		for (const key of KEYS) {
			const entry = catalogEntry(locale, key);
			expect(typeof entry).toBe("string");
			expect(String(entry)).toContain("{version}");
		}
	});
});

describe("OS staging recovery notices render in every locale", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		setLocale(locale);
		const rendered = KEYS.map((key) =>
			resolveMessageKey(key, { version: VERSION }),
		);
		for (const [index, text] of rendered.entries()) {
			expect(text).not.toBe(KEYS[index]);
			expect(text).toContain(VERSION);
			for (const token of MACHINE_TOKENS)
				expect(text.toLowerCase()).not.toContain(token);
		}
		expect(new Set(rendered).size).toBe(KEYS.length);
	});
});
