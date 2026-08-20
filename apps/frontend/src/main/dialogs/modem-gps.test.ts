/**
 * `gpsView` under the §1 render contract.
 *
 * The load-bearing assertion is the DELEGATION one: a table showing the GPS view
 * and the FCC view agreeing today would also pass against two faithful copies of
 * the ladder that then drift. So this asserts that `gpsView` answers the SAME
 * mode as the shared resolver for every claim, which a private copy could only
 * do by accident.
 */

import type { GnssFixState, SupportClaimState } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	type CapabilityReasonKeys,
	resolveCapabilityRender,
} from "../network/capability-modules";
import { gpsErrorKey, gpsStatusLine, gpsView } from "./modem-gps";

const CLAIMS: readonly (SupportClaimState | undefined)[] = [
	undefined,
	"unavailable",
	"implemented",
	"enabled",
	"capable",
	"certified",
];

const REASONS: CapabilityReasonKeys = {
	moduleDisabled: "network.modem.gps.reason.moduleDisabled",
	unproven: "network.modem.gps.reason.unproven",
};

/** The view kind each render mode is expected to surface as. */
const MODE_TO_KIND = {
	absent: "absent",
	unknown: "unknown",
	blocked: "blocked",
	available: "toggle",
} as const;

describe("gpsView — DESIGN.md §1 CT-1…CT-5", () => {
	it("Given a module this build or this modem cannot do, When resolved, Then NOTHING renders", () => {
		expect(gpsView("unavailable", { gnssEnabled: true }).kind).toBe("absent");
		expect(gpsView(undefined, { gnssEnabled: true }).kind).toBe("absent");
	});

	// CT-4: below `capable` nobody has shown there is a receiver, so there is no
	// control to disable — only a diagnostic saying so.
	it("Given the device gate is off, When resolved, Then it is UNKNOWN with the gate reason", () => {
		expect(gpsView("implemented", { gnssEnabled: false })).toEqual({
			kind: "unknown",
			reasonKey: "network.modem.gps.reason.moduleDisabled",
		});
	});

	it("Given the gate is on but nothing was established, When resolved, Then it is UNKNOWN", () => {
		expect(gpsView("enabled", { gnssEnabled: false })).toEqual({
			kind: "unknown",
			reasonKey: "network.modem.gps.reason.unproven",
		});
	});

	// CT-2: the receiver is PROVEN to exist and has simply not reported yet, so
	// the control is shown disabled-with-a-reason. Withholding it here would be
	// indistinguishable from a modem that has no GNSS at all.
	it("Given a capable modem that published no status, When resolved, Then the control is BLOCKED with a reason", () => {
		expect(gpsView("capable", undefined)).toEqual({
			kind: "blocked",
			reasonKey: "network.modem.gps.reason.notReported",
		});
	});

	it.each(["capable", "certified"] as const)(
		"Given a %s claim with a live status, When resolved, Then the toggle renders",
		(claim) => {
			expect(gpsView(claim, { gnssEnabled: true })).toEqual({
				kind: "toggle",
				enabled: true,
			});
		},
	);

	// THE DELEGATION PROOF: one ladder, not two that happen to agree.
	it.each([...CLAIMS])(
		"Given the claim %s, When resolved, Then it matches the shared resolver's mode",
		(claim) => {
			const shared = resolveCapabilityRender(claim, REASONS);
			expect(gpsView(claim, { gnssEnabled: false }).kind).toBe(
				MODE_TO_KIND[shared.mode],
			);
		},
	);

	// CT-5: unknown never degrades on retry.
	it("Given the same unknown evidence twice, When resolved, Then the view is identical", () => {
		expect(gpsView("enabled", undefined)).toEqual(
			gpsView("enabled", undefined),
		);
	});
});

describe("gpsStatusLine", () => {
	it.each([
		[undefined, "off"],
		[{ kind: "off" } as GnssFixState, "off"],
		[{ kind: "unavailable" } as GnssFixState, "unavailable"],
	])(
		"Given %o, When read, Then the line kind is %s",
		(state, expected: string) => {
			expect(gpsStatusLine(state).kind).toBe(expected);
		},
	);
});

describe("gpsErrorKey", () => {
	it("Given a known token, When keyed, Then it maps to its own copy", () => {
		expect(gpsErrorKey("module_disabled")).toBe(
			"network.modem.gps.error.module_disabled",
		);
	});

	it("Given a token this build does not know, When keyed, Then it falls back rather than leaking", () => {
		expect(gpsErrorKey("some_future_reason")).toBe(
			"network.modem.gps.error.read_failed",
		);
	});
});
