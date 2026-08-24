/**
 * The USSD session rule, driven directly.
 *
 * The interesting properties here are all REFUSALS — which verb is illegal in
 * which state, which token gets which sentence, and which outcome must never be
 * rendered as a success. Every one is a rule rather than a rendering, so it is
 * asserted against the function that owns it instead of through a mounted
 * component that could satisfy it by accident.
 *
 * Two of the blocks below are completeness gates rather than behaviour tests, and
 * they derive their expectations FROM the wire enums. A re-typed list would go
 * stale on exactly the change that needs it: the day a tenth refusal or a fifth
 * outcome lands, the surface would resolve it to a dotted key at an operator, and
 * the locale-parity gate structurally cannot catch that (a key missing from all
 * ten catalogs is perfectly in parity).
 */

import {
	USSD_SESSION_STATES,
	type UssdRefusal,
	type UssdSessionOutcome,
	type UssdSessionSnapshot,
	type UssdSessionState,
	ussdRefusalSchema,
	ussdSessionOutcomeSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { CATALOGS } from "../../tests/helpers/catalog";
import {
	canCancelUssd,
	canInitiateUssd,
	canRespondUssd,
	isNetworkPolicyRefusal,
	isUssdDialogueLive,
	isValidUssdCommand,
	isValidUssdResponse,
	ussdCapabilityView,
	ussdOutcomeKind,
	ussdOutcomeView,
	ussdRefusalKey,
	ussdSurfacePhase,
} from "./ussd-session";

/** `CATALOGS` is a NESTED view, so a dotted key is walked rather than indexed. */
function copy(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

const at = (state: UssdSessionState): UssdSessionSnapshot => ({ state });

const closed = (
	outcome: UssdSessionOutcome,
	refusal?: UssdRefusal,
): UssdSessionSnapshot => ({
	state: "closed",
	outcome,
	...(refusal === undefined ? {} : { refusal }),
});

/** Every capability-mutation refusal a USSD answer can carry on `mutationRefusal`. */
const CAPABILITY_REFUSALS = [
	"module_disabled",
	"module_unavailable",
	"identity_unresolved",
	"mutation_in_progress",
	"streaming_active",
	"recovery_pending",
	"mutation_blocked",
	"device_decommissioned",
	"rebaseline_required",
] as const;

describe("ussdCapabilityView — the ladder, minus the state that would hide the dialogue", () => {
	it("renders NOTHING for a modem that cannot do USSD", () => {
		expect(ussdCapabilityView("unavailable")).toEqual({ mode: "absent" });
	});

	it("renders NOTHING for a backend that published no claim at all", () => {
		expect(ussdCapabilityView(undefined)).toEqual({ mode: "absent" });
	});

	it("distinguishes a gate that is off from a capability nobody probed", () => {
		const gateOff = ussdCapabilityView("implemented");
		const unproven = ussdCapabilityView("enabled");
		expect(gateOff.mode).toBe("unknown");
		expect(unproven.mode).toBe("unknown");
		// Two different operator actions — turn the gate on, versus wait for the
		// probe — so they must never resolve to one sentence.
		expect(gateOff).not.toEqual(unproven);
	});

	it.each(["capable", "certified"] as const)(
		"offers the dialogue at %s",
		(claim) => {
			expect(ussdCapabilityView(claim)).toEqual({ mode: "available" });
		},
	);

	it("NEVER answers `blocked`, because that state suppresses the dialogue", () => {
		const claims = [
			undefined,
			"unavailable",
			"implemented",
			"enabled",
			"capable",
			"certified",
		] as const;
		for (const claim of claims) {
			expect(ussdCapabilityView(claim).mode).not.toBe("blocked");
		}
	});
});

describe("ussdSurfacePhase — seven device states folded onto five operator phases", () => {
	it("treats an absent snapshot as idle", () => {
		expect(ussdSurfacePhase(undefined)).toBe("idle");
	});

	it.each([
		["idle", "idle"],
		["initiating", "working"],
		["responding", "working"],
		["cancelling", "working"],
		["active", "open"],
		["awaiting-reply", "awaiting-reply"],
		["closed", "closed"],
	] as const)("folds %s onto %s", (state, phase) => {
		expect(ussdSurfacePhase(at(state))).toBe(phase);
	});

	it("is TOTAL over the wire enum", () => {
		for (const state of USSD_SESSION_STATES) {
			expect(ussdSurfacePhase(at(state))).toBeDefined();
		}
	});

	it("never leaves an in-flight verb without a phase that resolves", () => {
		// `working` is the only phase with no control of its own, so it is the only
		// one that could strand an operator. It must be reachable ONLY from states
		// the device itself drives to a terminal, never from a resting state.
		const working = USSD_SESSION_STATES.filter(
			(state) => ussdSurfacePhase(at(state)) === "working",
		);
		expect(working).toEqual(["initiating", "responding", "cancelling"]);
	});
});

describe("the three verb mirrors refuse a doomed dispatch locally", () => {
	it("refuses a SECOND initiate for every state that holds the network slot", () => {
		const live = USSD_SESSION_STATES.filter((state) =>
			isUssdDialogueLive(at(state)),
		);
		expect(live).toEqual([
			"initiating",
			"active",
			"awaiting-reply",
			"responding",
			"cancelling",
		]);
		for (const state of live) {
			expect(canInitiateUssd(at(state))).toBe(false);
		}
	});

	it("allows a fresh dialogue only where no slot is held", () => {
		expect(canInitiateUssd(undefined)).toBe(true);
		expect(canInitiateUssd(at("idle"))).toBe(true);
		// `closed` is terminal for one session OBJECT; the device starts the next
		// dialogue from a fresh machine, so this is exactly when a new one is legal.
		expect(canInitiateUssd(at("closed"))).toBe(true);
	});

	it("accepts an answer ONLY while the network is asking", () => {
		const accepted = USSD_SESSION_STATES.filter((state) =>
			canRespondUssd(at(state)),
		);
		expect(accepted).toEqual(["awaiting-reply"]);
		expect(canRespondUssd(undefined)).toBe(false);
	});

	it("accepts a cancel on every open state except one already cancelling", () => {
		const accepted = USSD_SESSION_STATES.filter((state) =>
			canCancelUssd(at(state)),
		);
		expect(accepted).toEqual([
			"initiating",
			"active",
			"awaiting-reply",
			"responding",
		]);
		expect(canCancelUssd(at("cancelling"))).toBe(false);
		expect(canCancelUssd(undefined)).toBe(false);
	});
});

describe("the four session outcomes are four different things to say", () => {
	it("reports a timeout as UNKNOWN — never a success and never a failure", () => {
		expect(ussdOutcomeKind("timed-out")).toBe("unknown");
	});

	it("reports a network refusal as refused", () => {
		expect(ussdOutcomeKind("failed")).toBe("refused");
	});

	it.each(["completed", "cancelled"] as const)(
		"reports %s as a request that took effect",
		(outcome) => {
			expect(ussdOutcomeKind(outcome)).toBe("applied");
		},
	);

	it("is TOTAL over the wire enum", () => {
		for (const outcome of ussdSessionOutcomeSchema.options) {
			expect(ussdOutcomeKind(outcome)).toBeDefined();
		}
	});

	it("says nothing at all while the dialogue has not ended", () => {
		for (const state of USSD_SESSION_STATES.filter((s) => s !== "closed")) {
			expect(ussdOutcomeView(at(state))).toBeUndefined();
		}
		expect(ussdOutcomeView(undefined)).toBeUndefined();
		// A `closed` snapshot with no outcome is not an ending anyone can describe.
		expect(ussdOutcomeView(at("closed"))).toBeUndefined();
	});

	it("carries a timeout to the unknown band with its own sentence", () => {
		expect(ussdOutcomeView(closed("timed-out"))).toEqual({
			outcome: "timed-out",
			kind: "unknown",
			messageKey: "network.modem.ussd.outcome.timed-out",
		});
	});

	it("resolves a failure through the device's OWN refusal, not a generic one", () => {
		const view = ussdOutcomeView(closed("failed", "carrier-rejected"));
		expect(view).toEqual({
			outcome: "failed",
			kind: "refused",
			messageKey: "network.modem.ussd.error.carrier-rejected",
			refusal: "carrier-rejected",
		});
	});

	it("degrades a refusal-less failure rather than rendering an empty band", () => {
		const view = ussdOutcomeView(closed("failed"));
		expect(view?.kind).toBe("refused");
		expect(view?.messageKey).toBe("network.modem.ussd.error.transport-failed");
		expect(view?.refusal).toBeUndefined();
	});
});

describe("lte-only-unsupported is a CARRIER policy, never a device fault", () => {
	it("is the only refusal marked as one", () => {
		const flagged = [
			...ussdRefusalSchema.options,
			...CAPABILITY_REFUSALS,
		].filter((token) => isNetworkPolicyRefusal(token));
		expect(flagged).toEqual(["lte-only-unsupported"]);
	});

	it("does not claim policy for an absent or unknown token", () => {
		expect(isNetworkPolicyRefusal(undefined)).toBe(false);
		expect(isNetworkPolicyRefusal("carrier-rejected")).toBe(false);
	});

	it("keeps its own sentence, distinct from every other refusal", () => {
		const mine = copy(
			CATALOGS.en,
			"network.modem.ussd.error.lte-only-unsupported",
		);
		const others = [...ussdRefusalSchema.options]
			.filter((token) => token !== "lte-only-unsupported")
			.map((token) => copy(CATALOGS.en, ussdRefusalKey(token)));
		expect(typeof mine).toBe("string");
		expect(others).not.toContain(mine);
	});
});

describe("ussdRefusalKey is TOTAL over both wire enums, in every locale", () => {
	const TOKENS = [...ussdRefusalSchema.options, ...CAPABILITY_REFUSALS];

	it("maps every token to its own key", () => {
		for (const token of TOKENS) {
			expect(ussdRefusalKey(token)).toBe(`network.modem.ussd.error.${token}`);
		}
	});

	it("falls back rather than leaking an unmapped token into copy", () => {
		expect(ussdRefusalKey("a-token-no-build-has-shipped")).toBe(
			"network.modem.ussd.error.transport-failed",
		);
	});

	for (const [locale, catalog] of Object.entries(CATALOGS)) {
		it(`${locale}: every token resolves to a real sentence`, () => {
			const missing = TOKENS.filter((token) => {
				const value = copy(catalog, ussdRefusalKey(token));
				return typeof value !== "string" || value.length === 0;
			});
			expect(missing).toEqual([]);
		});
	}
});

describe("the surface's own copy exists in every locale", () => {
	const KEYS = [
		"network.modem.ussd.title",
		"network.modem.ussd.description",
		"network.modem.ussd.privacyNotice",
		"network.modem.ussd.reason.moduleDisabled",
		"network.modem.ussd.reason.unproven",
		"network.modem.ussd.commandLabel",
		"network.modem.ussd.commandHint",
		"network.modem.ussd.send",
		"network.modem.ussd.working",
		"network.modem.ussd.workingHint",
		"network.modem.ussd.replyTitle",
		"network.modem.ussd.questionTitle",
		"network.modem.ussd.responseLabel",
		"network.modem.ussd.respond",
		"network.modem.ussd.cancel",
		"network.modem.ussd.openHint",
		"network.modem.ussd.busy",
		"network.modem.ussd.newSession",
		"network.modem.ussd.policyTitle",
		"network.modem.ussd.policyBody",
		...ussdSessionOutcomeSchema.options
			.filter((outcome) => outcome !== "failed")
			.map((outcome) => `network.modem.ussd.outcome.${outcome}`),
	];

	for (const [locale, catalog] of Object.entries(CATALOGS)) {
		it(`${locale}: no key resolves to a dotted path`, () => {
			const missing = KEYS.filter((key) => {
				const value = copy(catalog, key);
				return typeof value !== "string" || value.length === 0;
			});
			expect(missing).toEqual([]);
		});
	}

	it("gives `failed` no outcome sentence of its own, on purpose", () => {
		// A failure is explained by the device's refusal, not by a generic "it
		// failed" — so the absence of this key is a property, not a gap.
		expect(
			copy(CATALOGS.en, "network.modem.ussd.outcome.failed"),
		).toBeUndefined();
	});
});

describe("input shape mirrors the wire, so no Send offers a value the boundary rejects", () => {
	it.each(["*611#", "#123#", "*100*1#", "1#"])("accepts %s", (value) => {
		expect(isValidUssdCommand(value)).toBe(true);
	});

	it.each([
		["", "empty"],
		["*611", "no terminating hash"],
		["balance#", "letters"],
		["*611#\n", "a control byte"],
		[`${"1".repeat(200)}#`, "over the wire's length cap"],
	])("rejects %s (%s)", (value) => {
		expect(isValidUssdCommand(value)).toBe(false);
	});

	it("accepts a free-form menu answer, because a carrier may ask for one", () => {
		expect(isValidUssdResponse("1")).toBe(true);
		expect(isValidUssdResponse("Jane Doe")).toBe(true);
	});

	it("rejects an empty answer and any control byte", () => {
		expect(isValidUssdResponse("")).toBe(false);
		expect(isValidUssdResponse("1\u0000")).toBe(false);
		expect(isValidUssdResponse("1\n2")).toBe(false);
	});
});
