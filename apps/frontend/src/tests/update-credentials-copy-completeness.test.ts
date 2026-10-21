/**
 * @vitest-environment jsdom
 */

/**
 * EVERY UPDATE-CREDENTIALS ROW STRING EXISTS, TRANSLATED, IN ALL TEN LOCALES.
 *
 * The row resolves its keys with `resolveMessageKey`, which renders an unknown
 * key as the dotted key itself, and the locale-parity gate cannot see a key that
 * is missing from EVERY catalog. So the required list is taken from the helper's
 * own key tables (`CREDENTIAL_EXPIRY_STATE_KEYS` is total over the wire enum by
 * its `Record` type), and each locale must carry its own sentence with the same
 * placeholders.
 *
 * The "in about N days" phrase interpolates an `Intl` day count rather than
 * using catalog plural variants: the plural-parity gate requires every plural
 * message to be in the frozen rendered oracle, which nothing may write. The
 * render test below proves the phrase reads with the locale's own plural.
 */

import { resolveMessageKey, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, describe, expect, it } from "vitest";

import {
	CREDENTIAL_EXPIRY_COPY_KEYS,
	CREDENTIAL_EXPIRY_STATE_KEYS,
	CREDENTIAL_EXPIRY_TITLE_KEY,
	credentialRemainingCopy,
} from "$lib/updates/credential-expiry";

import { CATALOGS } from "./helpers/catalog";

const REQUIRED_KEYS: readonly string[] = [
	CREDENTIAL_EXPIRY_TITLE_KEY,
	...Object.values(CREDENTIAL_EXPIRY_STATE_KEYS),
	...Object.values(CREDENTIAL_EXPIRY_COPY_KEYS),
];

/** The one placeholder each key must keep in every locale (none for the rest). */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
	[CREDENTIAL_EXPIRY_COPY_KEYS.expiresOn]: "{date}",
	[CREDENTIAL_EXPIRY_COPY_KEYS.expiredOn]: "{date}",
	[CREDENTIAL_EXPIRY_COPY_KEYS.inAbout]: "{duration}",
};

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

function missingCopyKeys(catalog: unknown, keys: readonly string[]): string[] {
	return keys.filter((key) => typeof lookup(catalog, key) !== "string");
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

afterEach(() => {
	setLocale("en");
});

describe("the required list covers the whole row", () => {
	it("names a title, four states and five sentences, all distinct", () => {
		expect(Object.keys(CREDENTIAL_EXPIRY_STATE_KEYS).sort()).toEqual([
			"expired",
			"expiring",
			"unavailable",
			"valid",
		]);
		expect(new Set(REQUIRED_KEYS).size).toBe(10);
	});
});

describe("every locale carries every row string", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});

	it.each(Object.keys(CATALOGS))(
		"%s keeps exactly the placeholders",
		(locale) => {
			for (const key of REQUIRED_KEYS) {
				const text = String(lookup(CATALOGS[locale], key));
				const placeholders = text.match(/\{[^}]*\}/g) ?? [];
				const expected = PLACEHOLDERS[key];
				expect(placeholders, `${locale}:${key}`).toEqual(
					expected === undefined ? [] : [expected],
				);
			}
		},
	);
});

describe("the check is falsifiable", () => {
	it.each(Object.keys(CATALOGS))(
		"%s — a removed state label is reported",
		(locale) => {
			const key = CREDENTIAL_EXPIRY_STATE_KEYS.expired;
			expect(
				missingCopyKeys(withoutKey(CATALOGS[locale], key), REQUIRED_KEYS),
			).toEqual([key]);
		},
	);
});

describe("the copy is TRANSLATED, not the English value copy-pasted", () => {
	it.each(REQUIRED_KEYS)("%s differs from en in every other locale", (key) => {
		const english = lookup(CATALOGS.en, key);
		expect(typeof english).toBe("string");
		const duplicates = Object.entries(CATALOGS)
			.filter(([locale]) => locale !== "en")
			.filter(([, catalog]) => lookup(catalog, key) === english)
			.map(([locale]) => locale);
		expect(duplicates).toEqual([]);
	});

	it("the four state labels never collapse into one word in any locale", () => {
		for (const locale of Object.keys(CATALOGS)) {
			const labels = Object.values(CREDENTIAL_EXPIRY_STATE_KEYS).map((key) =>
				lookup(CATALOGS[locale], key),
			);
			expect(new Set(labels).size, locale).toBe(4);
		}
	});

	it("the Spanish copy addresses the operator with tú, never usted or vosotros", () => {
		for (const key of REQUIRED_KEYS) {
			const text = String(lookup(CATALOGS.es, key)).toLowerCase();
			expect(text, key).not.toMatch(/\busted(es)?\b|\bvosotros\b|\bvuestr/);
		}
	});
});

describe("the row renders through the real facade in every locale", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		setLocale(locale);
		const one = credentialRemainingCopy(1, locale);
		const many = credentialRemainingCopy(12, locale);
		const lessThanDay = credentialRemainingCopy(0, locale);
		const rendered = [
			resolveMessageKey(CREDENTIAL_EXPIRY_TITLE_KEY),
			...Object.values(CREDENTIAL_EXPIRY_STATE_KEYS).map((key) =>
				resolveMessageKey(key),
			),
			resolveMessageKey(CREDENTIAL_EXPIRY_COPY_KEYS.expiresOn, { date: "<D>" }),
			resolveMessageKey(CREDENTIAL_EXPIRY_COPY_KEYS.expiredOn, { date: "<D>" }),
			resolveMessageKey(CREDENTIAL_EXPIRY_COPY_KEYS.unreadable),
			resolveMessageKey(one?.key ?? "", one?.params),
			resolveMessageKey(many?.key ?? "", many?.params),
			resolveMessageKey(lessThanDay?.key ?? "", lessThanDay?.params),
		];
		for (const text of rendered) {
			expect(text).not.toContain("settings.updates.");
			expect(text).not.toMatch(/[{}]/);
			expect(text).not.toMatch(/-\d/);
		}
		expect(rendered[5]).toContain("<D>");
		expect(rendered[6]).toContain("<D>");
		// The day count arrives with the locale's own number and plural form.
		expect(rendered[8]).toContain(String(one?.params?.duration));
		expect(rendered[9]).toContain(String(many?.params?.duration));
		expect(rendered[8]).not.toBe(rendered[9]);
	});

	it("English reads naturally in singular and plural", () => {
		const one = credentialRemainingCopy(1, "en");
		const many = credentialRemainingCopy(12, "en");
		expect(resolveMessageKey(one?.key ?? "", one?.params)).toBe(
			"in about 1 day",
		);
		expect(resolveMessageKey(many?.key ?? "", many?.params)).toBe(
			"in about 12 days",
		);
	});
});
