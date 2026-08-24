/**
 * EVERY USB-MODE OUTCOME THE DEVICE CAN NAME HAS OPERATOR COPY, IN ALL TEN
 * LOCALES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE EXISTING GATES CANNOT CATCH THIS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts that all ten catalogs
 * carry the SAME key set. That is exactly the wrong shape for this defect: a key
 * missing from every locale is perfectly in parity. `setUsbModeRefusalSchema`
 * grew the four shared mutation-safety refusals (`mutation_blocked`,
 * `recovery_pending`, `device_decommissioned`, `rebaseline_required`) and no
 * catalog ever gained a `network.modem.usbMode.error.<token>` for any of them —
 * so the parity gate stayed green while `ModemConfigDialog` was one refused
 * switch away from printing a raw dotted key at an operator.
 *
 * That is not a cosmetic miss. `resolveMessageKey` renders an unknown key as the
 * key itself, and the modem surface's a11y gate forbids a raw dotted path
 * outright (`tests/e2e/modem-a11y.spec.ts`). The refusal an operator is most
 * likely to hit on a device that has ever had a mutation roll back badly is
 * precisely `mutation_blocked`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REQUIRED KEY LIST IS DERIVED FROM THE SCHEMAS, NEVER RE-TYPED
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The wire enums are the source of truth for what the device can say, and the
 * frontend's OWN key builders are the source of truth for where each token
 * resolves. Both are read here rather than mirrored, so the day someone adds an
 * eleventh refusal this test fails until its copy lands — which is the whole
 * point. Re-typing the list would reproduce the original defect one refactor
 * later.
 *
 * Note the two namespaces are NOT interchangeable: a refusal resolves under
 * `error.*` and a `transition_failed` reason under `reason.*`, and
 * `usbOfferSuppressionKey` is a TABLE spanning both because
 * `identity_unresolved` is a reason that also suppresses an offer. It is called
 * here rather than re-implemented for the same reason.
 */

import {
	setUsbModeFailureReasonSchema,
	setUsbModeRefusalSchema,
	usbModeOfferSuppressionSchema,
	usbModeRuntimeSuppressionSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	usbOfferSuppressionBodyKey,
	usbOfferSuppressionKey,
} from "../lib/rpc/usb-mode-offer";
import { CATALOGS } from "./helpers/catalog";

/** Every dotted key a USB-mode outcome can resolve to, derived from the wire. */
const REQUIRED_KEYS: readonly string[] = [
	...setUsbModeRefusalSchema.options.map(
		(refusal) => `network.modem.usbMode.error.${refusal}`,
	),
	...setUsbModeFailureReasonSchema.options.map(
		(reason) => `network.modem.usbMode.reason.${reason}`,
	),
	// The suppression table spans both namespaces AND re-spells the four
	// hyphenated runtime literals — ask it, do not guess.
	...usbModeOfferSuppressionSchema.options.map(usbOfferSuppressionKey),
	// The explanatory second line is copy too, and an absent one renders as a
	// missing band rather than a raw key — silent, and therefore worse.
	...usbModeOfferSuppressionSchema.options
		.map(usbOfferSuppressionBodyKey)
		.filter((key): key is string => key !== undefined),
];

/**
 * THE CHECK, as a pure function over one catalog.
 *
 * It is pure so the non-vacuity proof below can hand it a catalog with a key
 * removed instead of editing a file on disk — a gate that can only be trusted
 * after someone breaks the repo to try it is a gate nobody runs.
 */
export function missingCopyKeys(
	catalog: unknown,
	keys: readonly string[],
): string[] {
	return keys.filter((key) => typeof lookup(catalog, key) !== "string");
}

/** Resolve a dotted key against the re-nested catalog tree. */
function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/** A structural clone with ONE key removed — the falsifiability control. */
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

describe("the required key list is derived, and non-trivial", () => {
	it("covers every refusal, every failure reason, and every suppression", () => {
		// 10 refusals + 5 reasons + 7 suppressions, three of which resolve onto
		// keys already counted (`uncertified`, `unavailable_in_emulated_mode` and
		// `provisioning-disabled` are refusals; `identity_unresolved` is a reason)
		// + 5 explanatory bodies. The set, not the sum, is what matters.
		expect(setUsbModeRefusalSchema.options.length).toBeGreaterThanOrEqual(10);
		expect(setUsbModeFailureReasonSchema.options.length).toBe(5);
		expect(usbModeOfferSuppressionSchema.options.length).toBe(7);
		expect(usbModeRuntimeSuppressionSchema.options.length).toBe(4);
		expect(new Set(REQUIRED_KEYS).size).toBe(23);
	});

	it("names the four runtime suppressions explicitly", () => {
		// Spelled out for the same reason the mutation-safety four are below: a
		// derived list that silently stopped deriving would otherwise pass, and
		// these are the four that replace the blanket `uncertified` answer.
		for (const token of [
			"unknown-vendor",
			"no-return-path",
			"blocked-by-state",
			"provisioning-disabled",
		] as const) {
			expect(usbModeOfferSuppressionSchema.options).toContain(token);
			expect(REQUIRED_KEYS).toContain(usbOfferSuppressionKey(token));
		}
	});

	it("names the four shared mutation-safety refusals explicitly", () => {
		// Spelled out because these are the four that were missing, and a
		// derived list that silently stopped deriving would otherwise pass.
		for (const token of [
			"mutation_blocked",
			"recovery_pending",
			"device_decommissioned",
			"rebaseline_required",
		]) {
			expect(REQUIRED_KEYS).toContain(`network.modem.usbMode.error.${token}`);
		}
	});
});

describe("every locale carries copy for every USB-mode outcome", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});
});

describe("each suppression state reads DIFFERENTLY, in every locale", () => {
	// Completeness alone would be satisfied by four states sharing one sentence,
	// which is the defect being replaced one layer down: `uncertified` was a
	// single sentence standing in for four unrelated situations. So the copy is
	// additionally required to be DISTINGUISHABLE — an operator must be able to
	// tell "we can't ask this device" from "it can't come back" from "it's busy"
	// from "you turned this off", and be able to do so in their own language.
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		const sentences = usbModeOfferSuppressionSchema.options.map((reason) => {
			const head = lookup(CATALOGS[locale], usbOfferSuppressionKey(reason));
			const bodyKey = usbOfferSuppressionBodyKey(reason);
			const body =
				bodyKey === undefined ? "" : lookup(CATALOGS[locale], bodyKey);
			return `${String(head)}\u0000${String(body)}`;
		});

		expect(new Set(sentences).size).toBe(sentences.length);
	});

	it("…and the four runtime states are distinct from `uncertified` itself", () => {
		// The specific collision worth pinning: reusing the retired sentence for a
		// runtime state would satisfy the distinctness check above only until two
		// of them collided, and would reintroduce the exact claim being removed.
		const uncertified = lookup(
			CATALOGS.en,
			"network.modem.usbMode.error.uncertified",
		);
		for (const reason of usbModeRuntimeSuppressionSchema.options) {
			expect(lookup(CATALOGS.en, usbOfferSuppressionKey(reason))).not.toBe(
				uncertified,
			);
		}
	});
});

describe("the check is falsifiable — it FAILS on a removed key", () => {
	// Proving the gate can go red is the point: a completeness check that
	// cannot detect an absence is worth less than no check at all, because it
	// reads as coverage. Every locale is exercised so the proof is not an
	// accident of `en`'s shape.
	it.each(Object.keys(CATALOGS))(
		"%s — removing mutation_blocked is reported",
		(locale) => {
			const key = "network.modem.usbMode.error.mutation_blocked";
			const damaged = withoutKey(CATALOGS[locale], key);

			expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
			// …and the untouched catalog is still clean, so the removal is what
			// the check reacted to rather than some ambient difference.
			expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
		},
	);

	it("reports a key nothing ever defined", () => {
		expect(
			missingCopyKeys(CATALOGS.en, [
				"network.modem.usbMode.error.no_such_refusal",
			]),
		).toEqual(["network.modem.usbMode.error.no_such_refusal"]);
	});

	it("does not mistake a non-string node for copy", () => {
		// A dotted path that resolves to the PARENT object must not count as a
		// translation — otherwise `…usbMode.error` itself would satisfy every
		// child key.
		expect(
			missingCopyKeys(CATALOGS.en, ["network.modem.usbMode.error"]),
		).toEqual(["network.modem.usbMode.error"]);
	});
});
