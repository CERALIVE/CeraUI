/**
 * THE TWO SIM-BOND STRINGS ARE TRANSLATED, NOT JUST PRESENT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY EXISTING GATE STAYED GREEN
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts the ten catalogs
 * carry the SAME key set. `network.view.noSimBond` and `network.view.noSimLink`
 * shipped in all ten — with the IDENTICAL English value in every one, which is
 * perfectly in parity. Todo 35 caught it only in an RTL screenshot, where
 * "No SIM — cannot bond" sat in Latin script twice inside an otherwise fully
 * Arabic surface.
 *
 * This is the exact mirror of the trap `usb-mode-copy-completeness.test.ts`
 * closes — "a key missing from all ten catalogs is perfectly in parity" — in the
 * opposite direction, and it needs its own detector because a presence check
 * cannot see it and a distinctness-within-a-locale check cannot either.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THESE TWO KEYS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Both are on this effort's own surfaces and both are operator-facing:
 * `noSimLink` labels `NoSimBadge`, the unified "No SIM" tag, and `noSimBond` is
 * the bond toggle's disabled REASON — which the shipped kiosk touchscreen
 * cannot hover to reveal, so it is rendered on screen. The keys are DERIVED
 * rather than re-typed: the reason key comes out of `bondDisabledReasonKey`
 * itself, and the badge key is read from the component that renders it, so a
 * rename that orphaned either one fails here instead of quietly leaving this
 * gate pointed at dead copy.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bondDisabledReasonKey } from "../main/network/cellular-row";
import { CATALOGS } from "./helpers/catalog";

/** The live key for the bond refusal, from the rule that returns it. */
const BOND_KEY = bondDisabledReasonKey(
	{ no_sim: true } as never,
	"mm-managed",
	"no-sim",
	false,
);

const LINK_KEY = "network.view.noSimLink";

/** The already-reviewed sibling `noSimLink` must agree with, per locale. */
const STATE_KEY = "network.cellular.state.noSim";

const NON_ENGLISH = Object.keys(CATALOGS).filter((locale) => locale !== "en");

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/**
 * Pure so the falsifiability proof can hand it a damaged clone rather than
 * editing a catalog on disk — a gate nobody can cheaply prove red is a gate
 * nobody trusts.
 */
function untranslatedKeys(
	catalog: unknown,
	english: unknown,
	keys: readonly string[],
): string[] {
	return keys.filter((key) => lookup(catalog, key) === lookup(english, key));
}

describe("both keys are the ones the app actually renders", () => {
	it("the bond reason comes from `bondDisabledReasonKey`, not a literal", () => {
		expect(BOND_KEY).toBe("network.view.noSimBond");
	});

	it("the badge key is the one `NoSimBadge` renders", () => {
		// Without this the constant above could outlive the component and this
		// whole gate would assert against copy nothing reaches.
		const source = readFileSync(
			path.resolve(
				import.meta.dirname,
				"../lib/components/custom/NoSimBadge.svelte",
			),
			"utf8",
		);
		expect(source).toContain(LINK_KEY);
	});
});

describe("every locale carries both strings", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		for (const key of [BOND_KEY, LINK_KEY]) {
			expect(typeof lookup(CATALOGS[locale], key)).toBe("string");
			expect(
				(lookup(CATALOGS[locale], key) as string).trim().length,
			).toBeGreaterThan(0);
		}
	});
});

describe("nothing here is the English string left untranslated", () => {
	it.each(NON_ENGLISH)("%s translates both", (locale) => {
		expect(
			untranslatedKeys(CATALOGS[locale], CATALOGS.en, [BOND_KEY, LINK_KEY]),
		).toEqual([]);
	});

	it.each(NON_ENGLISH)("%s writes the badge in its own script", (locale) => {
		// `noSimLink` has an honest source: it is the SAME fact
		// `network.cellular.state.noSim` already states, reviewed in every
		// catalog. Pinning them equal keeps the unified tag from drifting into two
		// spellings of one word within a single locale.
		expect(lookup(CATALOGS[locale], LINK_KEY)).toBe(
			lookup(CATALOGS[locale], STATE_KEY),
		);
	});

	it.each(Object.keys(CATALOGS))(
		"%s — the reason says MORE than the badge",
		(locale) => {
			// The badge names the condition; the reason must also say what it costs,
			// because it is a disabled control's only on-screen explanation.
			const badge = lookup(CATALOGS[locale], LINK_KEY) as string;
			const reason = lookup(CATALOGS[locale], BOND_KEY) as string;
			expect(reason).not.toBe(badge);
			expect(reason.length).toBeGreaterThan(badge.length);
		},
	);
});

describe("the check is falsifiable — it FAILS on a re-pasted English value", () => {
	it.each(NON_ENGLISH)("%s — a copied bond reason is reported", (locale) => {
		const damaged = structuredClone(CATALOGS[locale]);
		damaged.network.view.noSimBond = CATALOGS.en.network.view.noSimBond;
		expect(
			untranslatedKeys(damaged, CATALOGS.en, [BOND_KEY, LINK_KEY]),
		).toEqual([BOND_KEY]);
	});

	it("a copied badge is reported too", () => {
		const damaged = structuredClone(CATALOGS.ja);
		damaged.network.view.noSimLink = CATALOGS.en.network.view.noSimLink;
		expect(
			untranslatedKeys(damaged, CATALOGS.en, [BOND_KEY, LINK_KEY]),
		).toEqual([LINK_KEY]);
	});
});
