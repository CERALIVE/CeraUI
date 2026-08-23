/**
 * EVERY REFUSAL CLASS READS DIFFERENTLY, IN ALL TEN LOCALES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PARITY GATE CANNOT CATCH THIS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts the ten catalogs
 * carry the SAME key set, which is exactly the wrong shape for this defect: a
 * key missing from every locale is perfectly in parity. This is the fourth gate
 * written to close that hole (after the capability-module, USB-mode and lock
 * ones), and it closes it the same way — by DERIVING the required list from the
 * code rather than re-typing a snapshot of it.
 *
 * Every surface that renders one of these keys resolves it DYNAMICALLY through
 * `resolveMessageKey`, which renders an unknown key as the dotted key itself. So
 * a class with no copy does not fail loudly; it puts
 * `network.modem.refusal.deviceBusy` on screen in front of an operator.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DISTINCTNESS IS THE POINT, NOT JUST PRESENCE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The taxonomy's whole claim is that two tokens share a class only when they
 * share a REMEDY. A locale that translated two classes to the same sentence
 * would pass a presence check and quietly undo that claim, so every class's
 * sentence is compared against its siblings WITHIN each locale — and the pair
 * the effort explicitly forbids collapsing (`auth-failed` versus
 * `unsupported-profile`) is asserted by name on top of the sweep.
 */

import { describe, expect, it } from "vitest";

import { REFUSAL_CLASSES, refusalCopyKey } from "$lib/modem/refusal-taxonomy";
import { CATALOGS } from "./helpers/catalog";

/** Derived, never re-typed — a twentieth class lands here on its own. */
const REQUIRED_KEYS: readonly string[] = REFUSAL_CLASSES.map(refusalCopyKey);

/**
 * Pure so the falsifiability proof below can hand it a damaged clone rather than
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

function sentence(locale: string, key: string): string {
	return lookup(CATALOGS[locale], key) as string;
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

describe("the required list is DERIVED from the taxonomy, not re-typed", () => {
	it("names one key per class, all distinct", () => {
		expect(REQUIRED_KEYS).toHaveLength(REFUSAL_CLASSES.length);
		expect(new Set(REQUIRED_KEYS).size).toBe(REFUSAL_CLASSES.length);
	});

	it("reuses the lock section's own three credential sentences", () => {
		// Todo 22 already wrote distinguishable ten-locale copy for these, and
		// they reach the taxonomy only from the dongle credential path — so this
		// is the right wording, not merely a reusable one. Minting a second
		// sentence per fact is how two surfaces come to disagree.
		expect(refusalCopyKey("auth-failed")).toBe(
			"network.routerCellular.lock.cause.authFailed",
		);
		expect(refusalCopyKey("unsupported-profile")).toBe(
			"network.routerCellular.lock.cause.unsupportedProfile",
		);
		expect(refusalCopyKey("locked-out")).toBe(
			"network.routerCellular.lock.cause.lockedOut",
		);
	});
});

describe("every locale carries copy for every refusal class", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});
});

describe("the classes are DISTINGUISHABLE in every locale", () => {
	it.each(Object.keys(CATALOGS))("%s — one class, one sentence", (locale) => {
		const sentences = REQUIRED_KEYS.map((key) => sentence(locale, key));
		expect(new Set(sentences).size).toBe(REQUIRED_KEYS.length);
		for (const text of sentences) {
			expect(text.trim().length).toBeGreaterThan(0);
		}
	});

	it.each(Object.keys(CATALOGS))(
		"%s — a rejected password never reads as an unperformable login",
		(locale) => {
			expect(sentence(locale, refusalCopyKey("auth-failed"))).not.toBe(
				sentence(locale, refusalCopyKey("unsupported-profile")),
			);
		},
	);

	it.each(Object.keys(CATALOGS))(
		"%s — an unknown outcome never reads as a definite failure",
		(locale) => {
			// `timed-out-unknown-outcome` is the third arm: neither applied nor
			// refused. Reading it as either is the one thing it exists to prevent.
			const unknown = sentence(
				locale,
				refusalCopyKey("timed-out-unknown-outcome"),
			);
			expect(unknown).not.toBe(
				sentence(locale, refusalCopyKey("write-failed")),
			);
			expect(unknown).not.toBe(sentence(locale, refusalCopyKey("read-failed")));
			expect(unknown).not.toBe(sentence(locale, refusalCopyKey("unreachable")));
		},
	);
});

describe("nothing here is the English string left untranslated", () => {
	it.each(Object.keys(CATALOGS).filter((locale) => locale !== "en"))(
		"%s translates every class",
		(locale) => {
			for (const key of REQUIRED_KEYS) {
				expect(sentence(locale, key)).not.toBe(sentence("en", key));
			}
		},
	);
});

describe("the check is falsifiable — it FAILS on a removed key", () => {
	it.each(Object.keys(CATALOGS))("%s reports the gap", (locale) => {
		const key = refusalCopyKey("device-busy");
		const damaged = withoutKey(CATALOGS[locale], key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});

	it("reports a removed lock-owned key too", () => {
		// The three reused keys live in another namespace, so they need their own
		// proof that this gate really reaches them.
		const key = refusalCopyKey("locked-out");
		const damaged = withoutKey(CATALOGS.en, key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});
});
