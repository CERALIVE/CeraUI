/*
 * The rule-band ordering contract.
 *
 * The image's source-routing rules and the steering layer's fwmark rules share
 * ONE ordered RPDB, so the only thing keeping a client flow from being re-routed
 * before the image has had its say is the numeric gap between the two bands.
 *
 * BOTH priorities are READ from `uplink-steering/contracts.ts` — this file
 * contains no priority literal at all. A test that typed `100` and `110` would
 * go on asserting the ordering it was written for long after somebody changed
 * the constants, which is the exact regression it exists to catch.
 */
import { describe, expect, it } from "bun:test";

import { checkSteeringRules } from "../modules/network/sharing-diag/checks.ts";
import { parseIpRuleBands } from "../modules/network/sharing-diag/ip-rules.ts";
import {
	FWMARK_RULE_PRIORITY,
	SOURCE_ROUTE_RULE_PRIORITY,
} from "../modules/network/uplink-steering/contracts.ts";
import { ipRuleShow } from "./sharing-diag-test-fixtures.ts";

describe("source-routing and steering bands are ordered, not merely different", () => {
	it("the steering band is strictly greater than the source-routing band", () => {
		expect(FWMARK_RULE_PRIORITY).toBeGreaterThan(SOURCE_ROUTE_RULE_PRIORITY);
	});

	it("the two bands do not overlap in a real `ip rule show`", () => {
		const parsed = parseIpRuleBands(ipRuleShow());
		expect(parsed).not.toBeNull();
		if (parsed === null) return;

		// Non-vacuity: the fixture must actually carry rules from BOTH bands, or
		// "they do not overlap" is true of an empty set.
		expect(parsed.sourceRoutes.length).toBeGreaterThan(0);
		expect(parsed.steering.length).toBeGreaterThan(0);

		const sourcePriorities = parsed.sourceRoutes.map((rule) => rule.priority);
		const steeringPriorities = parsed.steering.map((rule) => rule.priority);

		expect(new Set(sourcePriorities)).toEqual(
			new Set([SOURCE_ROUTE_RULE_PRIORITY]),
		);
		expect(new Set(steeringPriorities)).toEqual(
			new Set([FWMARK_RULE_PRIORITY]),
		);
		expect(
			sourcePriorities.every((priority) =>
				steeringPriorities.every((steering) => steering > priority),
			),
		).toBe(true);
	});

	it("a device laid out at the two constants passes the ordering check", () => {
		expect(
			checkSteeringRules(
				ipRuleShow({
					sourcePriority: SOURCE_ROUTE_RULE_PRIORITY,
					steeringPriority: FWMARK_RULE_PRIORITY,
				}),
			),
		).toEqual({ state: "ok" });
	});

	it("collapsing the gap is reported as a shadow, in both directions", () => {
		const sameBand = checkSteeringRules(
			ipRuleShow({ steeringPriority: SOURCE_ROUTE_RULE_PRIORITY }),
		);
		expect(sameBand.reason).toBe("steering_rule_shadows_source_route");

		const ahead = checkSteeringRules(
			ipRuleShow({ steeringPriority: SOURCE_ROUTE_RULE_PRIORITY - 1 }),
		);
		expect(ahead.reason).toBe("steering_rule_shadows_source_route");
	});

	it("judges against the source rules the DEVICE really installed, not only the constant", () => {
		// An image whose own source rules moved past the pinned priority must still
		// be protected: the floor is the higher of the contract and what is on the
		// box, so a steering rule that is legal against the constant alone but sits
		// ahead of the real source rules is still a shadow.
		const relocated = ipRuleShow({
			sourcePriority: FWMARK_RULE_PRIORITY + 10,
			steeringPriority: FWMARK_RULE_PRIORITY,
		});

		expect(checkSteeringRules(relocated).reason).toBe(
			"steering_rule_shadows_source_route",
		);
	});
});
