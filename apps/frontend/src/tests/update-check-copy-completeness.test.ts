/**
 * EVERY UPDATE-CHECK FAILURE REASON HAS COPY, IN ALL TEN LOCALES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PARITY GATE CANNOT CATCH THIS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts the ten catalogs
 * carry the SAME key set, which is exactly the wrong shape for this defect: a
 * key missing from every locale is perfectly in parity. Same mechanism as
 * `modem-capability-copy-completeness.test.ts` and `usb-mode-copy-completeness`.
 *
 * It matters here because `UPDATE_CHECK_FAILURE_REASONS` is a wire enum the
 * device grows independently of the dialog. The reason it publishes lands in
 * `UpdatesDialog`'s `checkFailureMessage` switch, whose `default` arm answers
 * `undefined` — so a reason with no arm renders the failure band with NO
 * sentence at all, and the operator is told a check failed with no way to act.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REQUIRED LIST IS DERIVED FROM THE WIRE ENUM, NEVER RE-TYPED
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `REASON_COPY_KEY` is `satisfies Record<UpdateCheckFailureReason, string>`, so
 * a fifth reason added to the wire removes a required key and fails `tsc`
 * BEFORE this gate even runs. It is a TABLE rather than an interpolated
 * namespace for the reason `apps/frontend/AGENTS.md` gives: interpolation is
 * what renders a raw dotted key the moment a wire enum grows, and the four
 * reasons genuinely live in two namespaces (the two pre-existing ones keep the
 * `general.*` copy that already ships).
 */

import { readFileSync } from "node:fs";
import {
	UPDATE_CHECK_FAILURE_REASONS,
	type UpdateCheckFailureReason,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { CATALOGS } from "./helpers/catalog";

/** One operator sentence per wire reason. Total over the enum, by construction. */
const REASON_COPY_KEY = {
	refresh_failed: "general.updateCheckReasonRefreshFailed",
	discovery_failed: "general.updateCheckReasonDiscoveryFailed",
	repos_unreachable: "settings.updates.checkFailed.repos_unreachable",
	captive_portal: "settings.updates.checkFailed.captive_portal",
} satisfies Record<UpdateCheckFailureReason, string>;

/**
 * The reachability + package-layer vocabulary this todo lands beside the
 * reasons. Todos 10/14/27 render these; the copy must exist before they do, or
 * their first render is a dotted key.
 */
const SURFACE_KEYS: readonly string[] = [
	"settings.updates.reachability.ipv4Only",
	"settings.updates.reachability.ipv6Only",
	"settings.updates.reachability.captivePortal",
	"settings.updates.layer.platformBand",
	"settings.updates.layer.keptBack",
	"settings.updates.failedReasonGeneric",
];

const REQUIRED_KEYS: readonly string[] = [
	...UPDATE_CHECK_FAILURE_REASONS.map((reason) => REASON_COPY_KEY[reason]),
	...SURFACE_KEYS,
];

/** The keys this todo ADDED — the ones a locale could still have copy-pasted. */
const NEW_KEYS: readonly string[] = REQUIRED_KEYS.filter((key) =>
	key.startsWith("settings.updates."),
);

const DIALOG_SOURCE = new URL(
	"../main/dialogs/UpdatesDialog.svelte",
	import.meta.url,
).pathname;

/**
 * Pure so the falsifiability proof below can hand it a damaged clone instead of
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

describe("the required list is derived from the wire enum", () => {
	it("asks for one sentence per reason, plus the reachability/layer surface", () => {
		expect(UPDATE_CHECK_FAILURE_REASONS.length).toBe(4);
		expect(Object.keys(REASON_COPY_KEY).sort()).toEqual(
			[...UPDATE_CHECK_FAILURE_REASONS].sort(),
		);
		expect(new Set(REQUIRED_KEYS).size).toBe(4 + SURFACE_KEYS.length);
	});

	it("names the two reasons this device cannot publish yet", () => {
		// Spelled out because a list that quietly started tracking what the
		// BACKEND emits today would drop exactly the two whose first render is
		// the one at risk — todo 10 is what starts emitting them.
		for (const reason of ["repos_unreachable", "captive_portal"] as const) {
			expect(REQUIRED_KEYS).toContain(REASON_COPY_KEY[reason]);
		}
	});
});

describe("every locale carries copy for every check-failure reason", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});
});

describe("the check is falsifiable — it FAILS on a removed key", () => {
	it.each(Object.keys(CATALOGS))(
		"%s — a removed reason sentence is reported",
		(locale) => {
			const key = REASON_COPY_KEY.repos_unreachable;
			const damaged = withoutKey(CATALOGS[locale], key);
			expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
		},
	);

	it("a removed surface key is reported too", () => {
		const key = "settings.updates.layer.keptBack";
		const damaged = withoutKey(CATALOGS.en, key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});
});

describe("the table is not dead copy — the dialog resolves every reason", () => {
	it("names each mapped key in UpdatesDialog.svelte", () => {
		const source = readFileSync(DIALOG_SOURCE, "utf8");
		for (const reason of UPDATE_CHECK_FAILURE_REASONS) {
			expect(source).toContain(`"${REASON_COPY_KEY[reason]}"`);
			expect(source).toContain(`case '${reason}':`);
		}
	});

	it("keeps the default arm, so an unmapped reason renders no sentence", () => {
		expect(readFileSync(DIALOG_SOURCE, "utf8")).toContain("default:");
	});
});

describe("the new copy is TRANSLATED, not the English value copy-pasted", () => {
	it.each(NEW_KEYS)("%s differs from en in every other locale", (key) => {
		const english = lookup(CATALOGS.en, key);
		expect(typeof english).toBe("string");
		expect((english as string).length).toBeGreaterThan(0);

		const duplicates = Object.entries(CATALOGS)
			.filter(([locale]) => locale !== "en")
			.filter(([, catalog]) => lookup(catalog, key) === english)
			.map(([locale]) => locale);
		expect(duplicates).toEqual([]);
	});

	it("never states the same sentence for two different reasons", () => {
		// `repos_unreachable` and `refresh_failed` are both "the repositories were
		// not reached", and they call for the same remedy but describe different
		// facts — one never spawned apt, the other ran it and it failed. Copy that
		// collapsed them would make the new reason unfalsifiable on screen.
		for (const locale of Object.keys(CATALOGS)) {
			const sentences = UPDATE_CHECK_FAILURE_REASONS.map((reason) =>
				lookup(CATALOGS[locale], REASON_COPY_KEY[reason]),
			);
			expect(new Set(sentences).size).toBe(sentences.length);
		}
	});
});
