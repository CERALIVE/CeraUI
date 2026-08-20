import {
	CAPABILITY_MODULES,
	type CapabilityModuleClaims,
	type SupportClaimState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	buildCapabilityModuleViews,
	type CapabilityReasonKeys,
	resolveCapabilityRender,
	surfacedCapabilityModules,
} from "./capability-modules";

const REASONS: CapabilityReasonKeys = {
	moduleDisabled: "reason.moduleDisabled",
	unproven: "reason.unproven",
};

function claims(
	overrides: Partial<Record<string, SupportClaimState>> = {},
): CapabilityModuleClaims {
	return Object.fromEntries(
		CAPABILITY_MODULES.map((module) => [
			module,
			overrides[module] ?? "implemented",
		]),
	) as CapabilityModuleClaims;
}

describe("capability-module rendering", () => {
	it("renders every module, never a filtered subset", () => {
		const views = buildCapabilityModuleViews(claims());
		expect(views.map((view) => view.module)).toEqual([...CAPABILITY_MODULES]);
	});

	it("surfaces nothing while the gates are off", () => {
		expect(surfacedCapabilityModules(claims())).toEqual([]);
	});

	it("surfaces a module only when it is enabled AND the modem is capable", () => {
		expect(
			surfacedCapabilityModules(
				claims({ "band-lock": "capable", gps: "enabled" }),
			),
		).toEqual(["band-lock"]);
	});

	it("surfaces a certified module too — certification governs claims, not use", () => {
		expect(surfacedCapabilityModules(claims({ esim: "certified" }))).toEqual([
			"esim",
		]);
	});

	it("renders an incapable modem's module as unavailable, not as a missing row", () => {
		const views = buildCapabilityModuleViews(claims({ ussd: "unavailable" }));
		const ussd = views.find((view) => view.module === "ussd");
		expect(ussd).toEqual({
			module: "ussd",
			state: "unavailable",
			surfaced: false,
		});
	});

	it("fails CLOSED for a backend that publishes no matrix at all", () => {
		const views = buildCapabilityModuleViews(undefined);
		expect(views).toHaveLength(CAPABILITY_MODULES.length);
		for (const view of views) {
			expect(view.state).toBe("unavailable");
			expect(view.surfaced).toBe(false);
		}
	});
});

/**
 * THE §1 RENDER CONTRACT, as a table. Every row here is one of the four
 * operation-state classes pass 1 has to be able to prove, and the DOM gate in
 * `ModemConfigDialog.capabilityTruth.test.ts` asserts the RENDERED form of the
 * same four — this proves the rule, that proves the markup obeys it.
 */
describe("resolveCapabilityRender — DESIGN.md §1 CT-1…CT-5", () => {
	// CT-1: positively unsupported, or not shipped in this build.
	it.each(["unavailable", undefined] as const)(
		"Given the claim %s, When resolved, Then NOTHING is rendered",
		(claim) => {
			expect(resolveCapabilityRender(claim, REASONS)).toEqual({
				mode: "absent",
			});
		},
	);

	// CT-3: "we have not looked" and "we looked and it is not there" are different
	// facts, and the second must never stand in for the first.
	it("Given the gate is off, When resolved, Then it is UNKNOWN — never absent", () => {
		expect(resolveCapabilityRender("implemented", REASONS)).toEqual({
			mode: "unknown",
			reasonKey: "reason.moduleDisabled",
		});
	});

	it("Given the gate is on but nothing was established, When resolved, Then it is UNKNOWN", () => {
		expect(resolveCapabilityRender("enabled", REASONS)).toEqual({
			mode: "unknown",
			reasonKey: "reason.unproven",
		});
	});

	it.each(["capable", "certified"] as const)(
		"Given a %s claim with nothing refusing it, When resolved, Then the control is offered",
		(claim) => {
			expect(resolveCapabilityRender(claim, REASONS)).toEqual({
				mode: "available",
			});
		},
	);

	// CT-2: supported, refused right now — visible, disabled, with a reason.
	it.each(["capable", "certified"] as const)(
		"Given a %s claim the device refuses right now, When resolved, Then it is BLOCKED with that reason",
		(claim) => {
			expect(resolveCapabilityRender(claim, REASONS, "reason.busy")).toEqual({
				mode: "blocked",
				reasonKey: "reason.busy",
			});
		},
	);

	// CT-4: a disabled control may exist ONLY at ≥ capable. A caller that passes a
	// refusal for an unproven module must not be able to conjure one.
	it.each(["implemented", "enabled"] as const)(
		"Given the sub-capable claim %s AND a refusal, When resolved, Then no control is conjured",
		(claim) => {
			expect(resolveCapabilityRender(claim, REASONS, "reason.busy").mode).toBe(
				"unknown",
			);
		},
	);

	it("Given an unsupported claim AND a refusal, When resolved, Then it stays absent", () => {
		expect(
			resolveCapabilityRender("unavailable", REASONS, "reason.busy"),
		).toEqual({ mode: "absent" });
	});

	// CT-5: unknown never degrades on retry.
	it("Given the same unknown evidence twice, When resolved, Then the view is identical", () => {
		expect(resolveCapabilityRender("enabled", REASONS)).toEqual(
			resolveCapabilityRender("enabled", REASONS),
		);
	});

	// The four classes must be mutually distinguishable, or a gate keyed on the
	// mode proves nothing.
	it("Given every claim, When resolved, Then each class is a distinct mode", () => {
		const modes = new Set(
			(["unavailable", "implemented", "capable"] as const).map(
				(claim) => resolveCapabilityRender(claim, REASONS).mode,
			),
		);
		expect(modes).toEqual(new Set(["absent", "unknown", "available"]));
		expect(
			resolveCapabilityRender("capable", REASONS, "reason.busy").mode,
		).toBe("blocked");
	});
});
