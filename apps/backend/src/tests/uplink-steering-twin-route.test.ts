/**
 * A DUPLICATE-IP TWIN IS STEERED BY ITS MARK, NEVER BY ITS ADDRESS.
 *
 * `route-planner.ts` used to answer the twins from the SOURCE-RULE dimension,
 * and every question it asked there was a coin flip. Two dispatcher rules for
 * one shared address made the whole steering state refuse outright
 * (`source address selects several tables`), and a single rule matched whichever
 * twin the kernel liked — so a shared-client flow marked for twin B could be
 * routed out twin A with nothing on the device saying so.
 *
 * The mark CAN name the device: `stableUplinkMark` keys on the twin's own
 * port-anchored physical identity (`state-builder.ts`), so each twin holds a
 * distinct mark, a distinct managed table, and a default route carrying its own
 * `dev <ifname>`. That is the routing twin of the `curl --interface` binding the
 * health probe uses, and it reuses the fwmark machinery `route-policy.ts`
 * already installs for every other uplink rather than adding parallel plumbing.
 *
 * Two properties are load-bearing beyond "it plans something":
 *
 *   * a fwmark rule matches the CLIENT-FLOW namespace (`0xca……/0xffffff00`)
 *     ONLY, so a locally-originated SRT/SRTLA packet — which nothing in the
 *     client-zone nft table ever marks — cannot select a twin's table. The media
 *     path gets no rule of its own, and this file asserts that rather than
 *     assuming it;
 *   * the twin path is deliberately NOT gated on `isModuleProvisionedUplink`.
 *     That gate exists because a MISSING source rule on a dispatcher-mapped
 *     interface is evidence of broken routing; on a shared address no
 *     per-interface source rule can exist at all, so its absence proves nothing.
 *     The honest precondition is the interface owning a default route, and a
 *     twin that owns none is refused.
 */

import { describe, expect, test } from "bun:test";

import {
	CLIENT_FLOW_NAMESPACE,
	CLIENT_FLOW_NAMESPACE_MASK,
	FWMARK_RULE_PRIORITY,
	SOURCE_ROUTE_RULE_PRIORITY,
	UPLINK_MARK_MASK,
} from "../modules/network/uplink-steering/contracts.ts";
import {
	ensureUplinkRoute,
	planUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";
import { hexMark, scripted } from "./uplink-steering-route-test-fixtures.ts";

/** The bench pair: two E3372 HiLinks, one factory MAC, one shared lease. */
const TWIN_A = "enx0c5b8f279a64";
const TWIN_B = "eth1";
const TWIN_IP = "192.168.8.100";
const TWIN_GW = "192.168.8.1";

/**
 * Each twin resolves to its OWN port-anchored identity, exactly as
 * `state-builder.ts` derives it — that is what makes the marks differ.
 */
const IDENTITY_A = "id-path:platform-xhci-hcd.0.auto-usb-0:1.4.1";
const IDENTITY_B = "id-path:platform-xhci-hcd.0.auto-usb-0:1.4.2";

const BASE_RULES =
	"0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n";

/**
 * The rule state the twins really produce: BOTH dispatcher rules name the same
 * shared address. This is the input that used to refuse the whole steering
 * state, so it is the fixture the happy path must survive.
 */
const AMBIGUOUS_RULES =
	`100: from ${TWIN_IP} lookup 100\n` +
	`100: from ${TWIN_IP} lookup 101\n` +
	"32766: from all lookup main\n";

function twinCandidate(ifname: string, identity: string) {
	return {
		identity,
		ifname,
		sourceAddress: TWIN_IP,
		sourceAddressUnique: false,
		mark: stableUplinkMark(identity),
	};
}

function defaultRouteAnswer(ifname: string): Record<string, string> {
	return {
		[`ip -4 route show default dev ${ifname}`]: `default via ${TWIN_GW} dev ${ifname} proto dhcp src ${TWIN_IP} metric 100\n`,
	};
}

describe("a duplicate-IP twin is planned by mark, not by address", () => {
	test("the plan is managed, table-per-mark, and carries NO source rule", async () => {
		const h = scripted({
			"ip rule show": AMBIGUOUS_RULES,
			...defaultRouteAnswer(TWIN_A),
		});
		const candidate = twinCandidate(TWIN_A, IDENTITY_A);

		const plan = await planUplinkRoute(candidate, h);

		expect(plan.managed).toBe(true);
		expect(plan.ifname).toBe(TWIN_A);
		// A `from <shared ip>` rule names a PAIR, so it is never installed here.
		expect(plan.sourceRulePriority).toBeUndefined();
		// The default route replayed into the private table keeps its own device
		// clause — that is what separates two identical `via 192.168.8.1` lines.
		expect(plan.defaultRouteArgv).toEqual([
			"route",
			"replace",
			"table",
			plan.table,
			"default",
			"via",
			TWIN_GW,
			"dev",
			TWIN_A,
			"proto",
			"dhcp",
			"src",
			TWIN_IP,
			"metric",
			"100",
		]);
	});

	test("the ambiguous source-rule dimension is never consulted", async () => {
		const h = scripted({
			"ip rule show": AMBIGUOUS_RULES,
			...defaultRouteAnswer(TWIN_A),
		});

		await planUplinkRoute(twinCandidate(TWIN_A, IDENTITY_A), h);

		// Reading a table selected by the shared address is the coin flip. The
		// planner must go straight from `ip rule show` (for the foreign-priority
		// assertion) to the interface's own default route.
		expect(
			h.calls.filter((call) =>
				call.join(" ").startsWith("ip route show table"),
			),
		).toEqual([]);
		expect(h.calls).toContainEqual([
			"ip",
			"-4",
			"route",
			"show",
			"default",
			"dev",
			TWIN_A,
		]);
	});

	test("the two twins get DIFFERENT marks, tables and device clauses", async () => {
		const [a, b] = await Promise.all(
			(
				[
					[TWIN_A, IDENTITY_A],
					[TWIN_B, IDENTITY_B],
				] as const
			).map(([ifname, identity]) =>
				planUplinkRoute(
					twinCandidate(ifname, identity),
					scripted({
						"ip rule show": AMBIGUOUS_RULES,
						...defaultRouteAnswer(ifname),
					}),
				),
			),
		);

		expect(a?.mark).not.toBe(b?.mark);
		expect(a?.table).not.toBe(b?.table);
		expect(a?.defaultRouteArgv).toContain(TWIN_A);
		expect(b?.defaultRouteArgv).toContain(TWIN_B);
		// Same address on both sides: the divergence above is the mark's doing.
		expect(a?.sourceAddress).toBe(b?.sourceAddress ?? "");
	});

	test("a twin that owns NO default route is refused, naming the collision", async () => {
		const h = scripted({
			"ip rule show": AMBIGUOUS_RULES,
			[`ip -4 route show default dev ${TWIN_B}`]: "",
		});

		await expect(
			planUplinkRoute(twinCandidate(TWIN_B, IDENTITY_B), h),
		).rejects.toMatchObject({
			reason: "policy_route_missing",
			message: expect.stringContaining(TWIN_IP),
		});
	});

	test("the twin path is not gated on the dispatcher-mapped class", async () => {
		// `wlan0` has no dispatcher source rule and, with a UNIQUE address, is
		// correctly refused. The control has to stay red-adjacent: this is what
		// makes the twin admission below a property of the shared address rather
		// than of the planner having gone permissive.
		await expect(
			planUplinkRoute(
				{
					identity: "wifi-a",
					ifname: "wlan0",
					sourceAddress: "192.168.2.10",
					sourceAddressUnique: true,
					mark: stableUplinkMark("wifi-a"),
				},
				scripted({ "ip rule show": BASE_RULES }),
			),
		).rejects.toMatchObject({ reason: "policy_route_missing" });

		const twinRadio = await planUplinkRoute(
			{
				identity: "wifi-twin",
				ifname: "wlan0",
				sourceAddress: TWIN_IP,
				sourceAddressUnique: false,
				mark: stableUplinkMark("wifi-twin"),
			},
			scripted({
				"ip rule show": BASE_RULES,
				...defaultRouteAnswer("wlan0"),
			}),
		);
		expect(twinRadio).toMatchObject({ managed: true, ifname: "wlan0" });
		expect(twinRadio.sourceRulePriority).toBeUndefined();
	});
});

describe("provisioning a twin installs a client-flow fwmark rule and nothing else", () => {
	test("the fwmark rule is added and NO source rule ever is", async () => {
		const h = scripted({
			"ip rule show": AMBIGUOUS_RULES,
			...defaultRouteAnswer(TWIN_A),
		});
		const plan = await planUplinkRoute(twinCandidate(TWIN_A, IDENTITY_A), h);

		await ensureUplinkRoute(plan, h);

		expect(h.calls).toContainEqual([
			"ip",
			"rule",
			"add",
			"priority",
			String(FWMARK_RULE_PRIORITY),
			"fwmark",
			`${hexMark(plan.mark)}/${hexMark(UPLINK_MARK_MASK)}`,
			"lookup",
			plan.table,
		]);
		const ruleCalls = h.calls.filter((call) => call[1] === "rule");
		expect(
			ruleCalls.some((call) =>
				call.includes(String(SOURCE_ROUTE_RULE_PRIORITY)),
			),
		).toBe(false);
		expect(h.calls.some((call) => call.includes(`${TWIN_IP}/32`))).toBe(false);
	});

	test("the rule matches the CLIENT-FLOW namespace, so the media path cannot", async () => {
		const h = scripted({
			"ip rule show": AMBIGUOUS_RULES,
			...defaultRouteAnswer(TWIN_A),
		});
		const plan = await planUplinkRoute(twinCandidate(TWIN_A, IDENTITY_A), h);

		// The top byte is the client-zone provenance proof. A locally-originated
		// SRT/SRTLA packet carries mark 0 — nothing in `inet ceralive_share` marks
		// it — so it cannot satisfy `fwmark 0xca……/0xffffff00` and never reaches
		// this table. That is the media-path exclusion, structurally.
		expect((plan.mark & CLIENT_FLOW_NAMESPACE_MASK) >>> 0).toBe(
			CLIENT_FLOW_NAMESPACE,
		);
		const unmarkedMediaPacket = 0;
		expect((unmarkedMediaPacket & UPLINK_MARK_MASK) >>> 0).not.toBe(
			(plan.mark & UPLINK_MARK_MASK) >>> 0,
		);

		await ensureUplinkRoute(plan, h);
		const ruleAdds = h.calls.filter(
			(call) => call[1] === "rule" && call[2] === "add",
		);
		expect(ruleAdds).toHaveLength(1);
		expect(ruleAdds[0]?.join(" ")).toContain(
			`fwmark 0xca${((plan.mark >>> 8) & 0xffff).toString(16).padStart(4, "0")}00/0xffffff00`,
		);
	});
});
