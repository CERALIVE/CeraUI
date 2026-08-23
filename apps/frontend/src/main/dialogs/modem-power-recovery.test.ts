/**
 * THE POWER/RECOVERY RULES, AND THE COPY EVERY REFUSAL RESOLVES TO.
 *
 * The pure half of todo 24. Three claims are under test and each was a real gap
 * rather than a hypothetical one:
 *
 * 1. A power reading has no companion write, and the SHAPE is what guarantees it
 *    — `PowerUnavailableOperation` has no slot a dispatchable thing could
 *    occupy, so a future caller cannot add a control without changing the type.
 * 2. `unknown` and ABSENCE are different answers. `unknown` is the modem saying
 *    it does not know; absence is this device reporting no power state at all.
 * 3. Every `modemConfigRefusalSchema` token has operator copy in all ten
 *    catalogs. Nine of sixteen had NONE when this todo started — including
 *    `streaming_active`, which is the refusal a recovery attempted mid-stream
 *    produces, i.e. exactly the one this surface exists to render.
 *
 * The locale-parity gate structurally cannot catch (3): a key missing from every
 * catalog is perfectly in parity. The required list is DERIVED from the wire
 * enum here, never re-typed, so a seventeenth refusal fails this test until its
 * copy lands.
 */

import { modemConfigRefusalSchema } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { CATALOGS } from "../../tests/helpers/catalog";
import {
	isStreamingRecoveryRefusal,
	POWER_UNAVAILABLE_OPERATIONS,
	radioPowerReading,
	recoveryOutcome,
} from "./modem-power-recovery";

/** Every dotted key a refused modem-config save can resolve to. */
const REQUIRED_REFUSAL_KEYS: readonly string[] =
	modemConfigRefusalSchema.options.map(
		(refusal) => `network.modem.saveRefused.${refusal}`,
	);

/** Every dotted key the power/recovery card renders. */
const REQUIRED_POWER_KEYS: readonly string[] = [
	"network.modem.power.title",
	"network.modem.power.description",
	"network.modem.power.stateLabel",
	"network.modem.power.unreported",
	"network.modem.power.provenance",
	"network.modem.power.recovery.title",
	"network.modem.power.recovery.body",
	"network.modem.saveReconcile",
	"network.modem.saveReconcileUnresolved",
	...(["unknown", "off", "low", "on"] as const).map(
		(state) => `network.modem.power.state.${state}`,
	),
	...POWER_UNAVAILABLE_OPERATIONS.flatMap((op) => [op.titleKey, op.reasonKey]),
];

function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

/**
 * The check, as a pure function over ONE catalog, so its own falsifiability can
 * be proven by handing it a clone with a key removed rather than by breaking the
 * repository to try it.
 */
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

describe("the radio power reading", () => {
	it.each(["unknown", "off", "low", "on"] as const)(
		"`%s` resolves to its own label and states its provenance",
		(state) => {
			const reading = radioPowerReading(state);

			expect(reading?.state).toBe(state);
			expect(reading?.labelKey).toBe(`network.modem.power.state.${state}`);
			expect(reading?.provenanceKey).toBe("network.modem.power.provenance");
		},
	);

	it("ABSENCE is not `unknown` — a device that said nothing gets no reading", () => {
		// The load-bearing distinction. `unknown` is the modem's own answer;
		// absence is a `router-ethernet` dongle, or a backend older than the field.
		expect(radioPowerReading(undefined)).toBeUndefined();
		expect(radioPowerReading("unknown")).toBeDefined();
	});

	it("carries a value and two keys, and nothing that could be dispatched", () => {
		const reading = radioPowerReading("on");

		expect(Object.keys(reading ?? {}).sort()).toEqual([
			"labelKey",
			"provenanceKey",
			"state",
		]);
	});
});

describe("the unavailable operations are a STATEMENT, not a control set", () => {
	it("names the radio-power write, the reset and the hub power-cycle", () => {
		expect(POWER_UNAVAILABLE_OPERATIONS.map((op) => op.id)).toEqual([
			"radio-power",
			"modem-reset",
			"hub-power",
		]);
	});

	it("has NO slot a dispatchable thing could occupy", () => {
		// The guarantee is structural: an operation is three i18n keys. Adding a
		// handler means changing this type, which means changing this assertion.
		for (const op of POWER_UNAVAILABLE_OPERATIONS) {
			expect(Object.keys(op).sort()).toEqual(["id", "reasonKey", "titleKey"]);
			for (const value of Object.values(op)) {
				expect(typeof value).toBe("string");
			}
		}
	});

	it("is frozen, because it describes the SHIPPED STACK and not the device", () => {
		expect(Object.isFrozen(POWER_UNAVAILABLE_OPERATIONS)).toBe(true);
		for (const op of POWER_UNAVAILABLE_OPERATIONS) {
			expect(Object.isFrozen(op)).toBe(true);
		}
	});

	it("names no prohibited recovery path", () => {
		// EDL / firmware / DIAG are inert fences in the control library, and
		// advertising them on an operator surface would describe a route this
		// product does not have. The reasons are prose, so the sweep is on the
		// KEYS, which are ours.
		const keys = POWER_UNAVAILABLE_OPERATIONS.flatMap((op) => [
			op.id,
			op.titleKey,
			op.reasonKey,
		]).join(" ");

		expect(keys).not.toMatch(/edl|firmware|diag|nvram|efs/i);
	});
});

describe("a recovery outcome", () => {
	it("renders a refusal with the DEVICE's own token, keyed", () => {
		const view = recoveryOutcome({
			status: "refused",
			refusal: "streaming_active",
		});

		expect(view.kind).toBe("refused");
		expect(view.key).toBe("network.modem.saveRefused.streaming_active");
		expect(view.reconcilable).toBe(false);
	});

	it("renders an unconfirmed save as UNKNOWN with a reconcile, never a success", () => {
		const view = recoveryOutcome({ status: "unconfirmed" });

		expect(view.kind).toBe("unknown");
		expect(view.kind).not.toBe("applied");
		expect(view.reconcilable).toBe(true);
	});

	it.each(modemConfigRefusalSchema.options)(
		"`%s` resolves to its own sentence, never a shared one",
		(refusal) => {
			expect(recoveryOutcome({ status: "refused", refusal }).key).toBe(
				`network.modem.saveRefused.${refusal}`,
			);
		},
	);

	it("names the streaming interlock as its own operator action", () => {
		expect(isStreamingRecoveryRefusal("streaming_active")).toBe(true);
		expect(isStreamingRecoveryRefusal("mutation_blocked")).toBe(false);
		expect(isStreamingRecoveryRefusal(undefined)).toBe(false);
	});
});

describe("every refusal and every power string has copy, in all ten locales", () => {
	const ALL = [...REQUIRED_REFUSAL_KEYS, ...REQUIRED_POWER_KEYS];

	it("the derived list is non-trivial", () => {
		// Sixteen refusals — nine of which carried NO copy before this todo — plus
		// the card's own strings. The SET is what matters, not the sum.
		expect(modemConfigRefusalSchema.options.length).toBe(16);
		expect(REQUIRED_REFUSAL_KEYS).toContain(
			"network.modem.saveRefused.streaming_active",
		);
		expect(new Set(ALL).size).toBe(ALL.length);
	});

	it.each(Object.keys(CATALOGS))("%s has every key", (locale) => {
		expect(missingCopyKeys(CATALOGS[locale], ALL)).toEqual([]);
	});

	it("the check is falsifiable — a removed key is reported, per locale", () => {
		for (const locale of Object.keys(CATALOGS)) {
			const crippled = withoutKey(
				CATALOGS[locale],
				"network.modem.saveRefused.streaming_active",
			);

			expect(missingCopyKeys(crippled, ALL)).toEqual([
				"network.modem.saveRefused.streaming_active",
			]);
		}
	});

	it("the seven shared mutation refusals reuse ONE sentence per token", () => {
		// The established rule: one machine token, one operator sentence, across
		// every modem-mutation surface. A second wording for the same refusal is
		// how the same fact comes to read differently depending on which control
		// produced it.
		for (const token of [
			"identity_unresolved",
			"mutation_in_progress",
			"streaming_active",
			"recovery_pending",
			"mutation_blocked",
			"device_decommissioned",
			"rebaseline_required",
		] as const) {
			for (const locale of Object.keys(CATALOGS)) {
				expect(
					lookup(CATALOGS[locale], `network.modem.saveRefused.${token}`),
				).toBe(lookup(CATALOGS[locale], `network.modem.gps.error.${token}`));
			}
		}
	});
});
