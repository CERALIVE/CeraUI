/**
 * EVERY LOCK STATE READS DIFFERENTLY, IN ALL TEN LOCALES.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE PARITY GATE CANNOT CATCH THIS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `packages/i18n/tests/locale-parity-gate.test.ts` asserts the ten catalogs
 * carry the SAME key set — exactly the wrong shape for this defect, because a
 * key missing from every locale is perfectly in parity. This is the same hole
 * `usb-mode-copy-completeness.test.ts` and `modem-capability-copy-completeness.
 * test.ts` were written to close, and the same mechanism closes it.
 *
 * It matters here for two reasons at once. `ModemLockSection` resolves both the
 * state sentence and the refusal sentence DYNAMICALLY (`resolveMessageKey`),
 * which renders an unknown key as the dotted key itself — so a missing entry
 * reaches an operator as `network.routerCellular.lock.cause.lockedOut`. And the
 * two vocabularies behind those keys are WIRE ENUMS that can grow: a sixth
 * `MODEM_LOCK_STATES` member or a tenth credential refusal would otherwise ship
 * with no copy at all.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DISTINCTNESS IS THE POINT, NOT JUST PRESENCE
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Todo 22's requirement is that the five states are DISTINGUISHABLE, and the
 * three failure causes especially so: wrong password, unsupported firmware
 * profile and device lockout call for three different actions. A locale that
 * translated two of them to the same sentence would pass a presence check and
 * fail an operator, so every situation's sentence is compared against its
 * siblings WITHIN each locale.
 *
 * The required list is DERIVED from `MODEM_LOCK_STATES`, the sub-reason enum and
 * `modemCredentialsRefusalSchema` — never re-typed — so the gate tracks the wire
 * rather than a snapshot of it.
 */

import {
	MODEM_LOCK_STATES,
	modemCredentialsRefusalSchema,
	modemLockSubReasonSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { lockErrorKey, lockMessageKey } from "$lib/modem/lock-state";
import { CATALOGS } from "./helpers/catalog";

/** The section's own frame — the surface a state sentence sits inside. */
const SURFACE_KEYS: readonly string[] = [
	"network.routerCellular.lock.title",
	"network.routerCellular.lock.description",
	"network.routerCellular.lock.wait",
	"network.routerCellular.lock.waitUnknown",
	"network.routerCellular.lock.usernameLabel",
	"network.routerCellular.lock.passwordLabel",
	"network.routerCellular.lock.submit",
	"network.routerCellular.lock.submitBusy",
	"network.routerCellular.lock.clear",
	"network.routerCellular.lock.configured",
	"network.routerCellular.lock.controlsWithheld",
	"network.routerCellular.lock.outcome.unlocked",
	"network.routerCellular.lock.outcome.cleared",
];

/**
 * Every situation the lock model can resolve: the five wire states, plus each
 * sub-reason inside `locked`. Derived so a sixth state or a second sub-reason
 * lands here automatically.
 */
const SITUATION_KEYS: readonly string[] = [
	...MODEM_LOCK_STATES.map((state) => lockMessageKey(state)),
	...modemLockSubReasonSchema.options.map((sub) =>
		lockMessageKey("locked", sub),
	),
];

/** Every typed refusal the three credential procedures may answer, plus ours. */
const ERROR_KEYS: readonly string[] = [
	lockErrorKey(undefined),
	...modemCredentialsRefusalSchema.options.map((token) => lockErrorKey(token)),
];

/**
 * De-duplicated as a whole, not per group.
 *
 * The three credential CAUSES and the three matching typed REFUSALS now resolve
 * to the same key: `lockErrorKey` routes through the shared refusal taxonomy,
 * which deliberately points `auth-failed`, `unsupported-profile` and
 * `locked-out` back at this section's own `lock.cause.*` copy rather than
 * minting a second wording for one fact. A key listed twice would be reported
 * twice by the falsifiability proof below.
 */
const REQUIRED_KEYS: readonly string[] = [
	...new Set([...SURFACE_KEYS, ...SITUATION_KEYS, ...ERROR_KEYS]),
];

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

describe("the required list is DERIVED from the wire, not re-typed", () => {
	it("covers every lock state and every sub-reason inside `locked`", () => {
		expect(MODEM_LOCK_STATES.length).toBe(5);
		expect(modemLockSubReasonSchema.options.length).toBe(1);
		// Five states + one sub-reason situation = six reachable sentences.
		expect(new Set(SITUATION_KEYS).size).toBe(6);
	});

	it("covers every credential refusal the device can answer", () => {
		expect(modemCredentialsRefusalSchema.options.length).toBe(9);
		// …plus our own transport fallback, which must not borrow a device claim.
		expect(new Set(ERROR_KEYS).size).toBe(10);
	});

	it("names the three FAILURE causes explicitly", () => {
		// Spelled out because these three are the requirement: a derived list that
		// quietly stopped producing one of them would still look complete.
		expect(REQUIRED_KEYS).toContain(
			"network.routerCellular.lock.cause.authFailed",
		);
		expect(REQUIRED_KEYS).toContain(
			"network.routerCellular.lock.cause.unsupportedProfile",
		);
		expect(REQUIRED_KEYS).toContain(
			"network.routerCellular.lock.cause.lockedOut",
		);
	});
});

describe("every locale carries copy for every lock situation", () => {
	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], REQUIRED_KEYS)).toEqual([]);
	});
});

describe("the five states are DISTINGUISHABLE in every locale", () => {
	it.each(Object.keys(CATALOGS))(
		"%s — six situations, six sentences",
		(locale) => {
			const sentences = [...new Set(SITUATION_KEYS)].map(
				(key) => lookup(CATALOGS[locale], key) as string,
			);
			expect(sentences).toHaveLength(6);
			expect(new Set(sentences).size).toBe(6);
			for (const sentence of sentences) {
				expect(sentence.trim().length).toBeGreaterThan(0);
			}
		},
	);

	it.each(Object.keys(CATALOGS))(
		"%s — the three failure causes never share a sentence",
		(locale) => {
			const causes = [
				lockMessageKey("auth-failed"),
				lockMessageKey("locked", "unsupported-profile"),
				lockMessageKey("locked-out"),
			].map((key) => lookup(CATALOGS[locale], key) as string);
			expect(new Set(causes).size).toBe(3);
		},
	);

	it.each(Object.keys(CATALOGS))(
		"%s — every refusal reads on its own",
		(locale) => {
			const sentences = ERROR_KEYS.map(
				(key) => lookup(CATALOGS[locale], key) as string,
			);
			// `auth_failed`, `locked_out` and `unsupported_profile` are the three the
			// operator acts on differently; collapsing any pair would send someone to
			// the wrong remedy.
			const acted = [
				lookup(CATALOGS[locale], lockErrorKey("auth_failed")),
				lookup(CATALOGS[locale], lockErrorKey("locked_out")),
				lookup(CATALOGS[locale], lockErrorKey("unsupported_profile")),
			];
			expect(new Set(acted).size).toBe(3);
			for (const sentence of sentences) {
				expect(sentence.trim().length).toBeGreaterThan(0);
			}
		},
	);
});

describe("nothing here is the English string left untranslated", () => {
	it.each(Object.keys(CATALOGS).filter((locale) => locale !== "en"))(
		"%s translates the three failure causes",
		(locale) => {
			for (const key of [
				lockMessageKey("auth-failed"),
				lockMessageKey("locked", "unsupported-profile"),
				lockMessageKey("locked-out"),
			]) {
				expect(lookup(CATALOGS[locale], key)).not.toBe(
					lookup(CATALOGS.en, key),
				);
			}
		},
	);
});

describe("the wait copy really carries the device's own number", () => {
	it.each(Object.keys(CATALOGS))("%s interpolates {minutes}", (locale) => {
		// A locale that dropped the parameter would render a lockout with no wait
		// at all, which is the one thing `locked-out` exists to state.
		expect(
			lookup(CATALOGS[locale], "network.routerCellular.lock.wait"),
		).toContain("{minutes}");
	});

	it("the unknown-window sentence carries NO parameter", () => {
		// It is reached precisely when the device named no window; interpolating
		// there would print a placeholder.
		for (const locale of Object.keys(CATALOGS)) {
			expect(
				lookup(CATALOGS[locale], "network.routerCellular.lock.waitUnknown"),
			).not.toContain("{minutes}");
		}
	});
});

describe("the check is falsifiable — it FAILS on a removed key", () => {
	it.each(Object.keys(CATALOGS))(
		"%s — a removed failure cause is reported",
		(locale) => {
			const key = "network.routerCellular.lock.cause.lockedOut";
			const damaged = withoutKey(CATALOGS[locale], key);
			expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
		},
	);

	it("a removed refusal is reported too", () => {
		const key = lockErrorKey("auth_failed");
		const damaged = withoutKey(CATALOGS.en, key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});

	it("a removed surface key is reported too", () => {
		const key = "network.routerCellular.lock.controlsWithheld";
		const damaged = withoutKey(CATALOGS.en, key);
		expect(missingCopyKeys(damaged, REQUIRED_KEYS)).toEqual([key]);
	});
});
