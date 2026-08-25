import { describe, expect, test } from "bun:test";

import type { RouteProvisioning } from "../modules/network/uplink-steering/applier.ts";
import {
	UplinkSteeringApplier,
	type UplinkSteeringApplierDeps,
} from "../modules/network/uplink-steering/applier.ts";
import { prepared, uplink } from "./uplink-steering-test-fixtures.ts";

describe("UplinkSteeringApplier", () => {
	test("hard-down excludes selection before scoped flush and support removal", async () => {
		const kept = uplink("kept", "wlan0", 100);
		const down = uplink("down", "wwan0", 100);
		const previous = prepared([kept, down]);
		const next = prepared([kept]);
		const log: string[] = [];
		const appliedRulesets: string[] = [];
		const applier = new UplinkSteeringApplier(
			makeApplierDeps(log, appliedRulesets),
		);

		await applier.apply(previous, next);

		expect(log).toEqual([
			"ensure:wlan0",
			"ruleset:reload",
			`flush:${down.mark}`,
			"remove:wwan0",
			"event:wwan0:down",
			"ruleset:reload",
		]);
		expect(appliedRulesets[0]).toContain(
			`ct mark & 0xffffff00 == ${hexMark(down.mark)} oifname "wwan0" masquerade`,
		);
		expect(appliedRulesets[0]).not.toContain(
			`meta mark set (meta mark & 0x000000ff) | ${hexMark(down.mark)}`,
		);
		expect(appliedRulesets[1]).not.toContain(hexMark(down.mark));
	});

	test("ordinary reweight uses one reload and never resets flows", async () => {
		const before = prepared([uplink("a", "wwan0", 100)]);
		const after = prepared([uplink("a", "wwan0", 25)]);
		const log: string[] = [];
		const applier = new UplinkSteeringApplier(makeApplierDeps(log, []));

		await applier.apply(before, after);

		expect(log).toEqual(["ensure:wwan0", "ruleset:reload"]);
	});

	test("ruleset failure rolls back route support created for a new uplink", async () => {
		const next = prepared([uplink("new", "eth0", 100)]);
		const log: string[] = [];
		const deps = makeApplierDeps(log, []);
		deps.applyRuleset = async (_ruleset, mode) => {
			log.push(`ruleset:${mode}`);
			throw new Error("reload refused");
		};
		const applier = new UplinkSteeringApplier(deps);

		await expect(applier.apply(undefined, next)).rejects.toThrow(
			"reload refused",
		);
		expect(log).toEqual(["ensure:eth0", "ruleset:activate", "rollback:eth0"]);
	});

	test("forwarding activation failure stops the carrier and rolls back new routes", async () => {
		const next = prepared([uplink("new", "eth0", 100)]);
		const log: string[] = [];
		const deps = makeApplierDeps(log, []);
		deps.setIpForwarding = async (enabled) => {
			log.push(`forward:${enabled ? "on" : "off"}`);
			throw new Error("sysctl refused");
		};
		const applier = new UplinkSteeringApplier(deps);

		await expect(applier.apply(undefined, next)).rejects.toThrow(
			"sysctl refused",
		);
		expect(log).toEqual([
			"ensure:eth0",
			"ruleset:activate",
			"forward:on",
			"deactivate",
			"rollback:eth0",
		]);
	});

	test("a final hard-down reload failure restores support retained by the transition", async () => {
		const kept = uplink("kept", "wlan0", 100);
		const down = uplink("down", "wwan0", 100);
		const previous = prepared([kept, down]);
		const next = prepared([kept]);
		const log: string[] = [];
		const deps = makeApplierDeps(log, []);
		let rulesets = 0;
		deps.applyRuleset = async (_ruleset, mode) => {
			log.push(`ruleset:${mode}`);
			rulesets++;
			if (rulesets === 2) throw new Error("final reload refused");
		};
		const applier = new UplinkSteeringApplier(deps);

		await expect(applier.apply(previous, next)).rejects.toThrow(
			"final reload refused",
		);
		expect(log).toEqual([
			"ensure:wlan0",
			"ruleset:reload",
			`flush:${down.mark}`,
			"remove:wwan0",
			"event:wwan0:down",
			"ruleset:reload",
			"ensure:wwan0",
		]);
	});

	test("toggles forwarding only on client-zone activation edges", async () => {
		const inactive = prepared([], []);
		const active = prepared([uplink("a", "wwan0", 100)]);
		const log: string[] = [];
		const applier = new UplinkSteeringApplier(makeApplierDeps(log, []));

		await applier.apply(inactive, active);
		await applier.apply(active, inactive);

		expect(log).toEqual([
			"ensure:wwan0",
			"ruleset:activate",
			"forward:on",
			"ruleset:reload",
			`flush:${active.routes[0]?.mark}`,
			"remove:wwan0",
			"event:wwan0:a",
			"deactivate",
			"forward:off",
		]);
	});

	test("backend restart publishes the latest model before retiring stale route support", async () => {
		const next = prepared([uplink("kept", "wlan0", 100)]);
		const stale = prepared([uplink("stale", "wwan0", 100)]).routes[0];
		if (stale === undefined) throw new Error("missing stale route fixture");
		const log: string[] = [];
		const rulesets: string[] = [];
		const deps = makeApplierDeps(log, rulesets);
		deps.discoverRoutes = async () => [stale];
		const applier = new UplinkSteeringApplier(deps);

		await applier.apply(undefined, next);

		expect(log).toEqual([
			"ensure:wlan0",
			"ruleset:activate",
			`flush:${stale.mark}`,
			"remove:wwan0",
			"forward:on",
		]);
		expect(rulesets).toHaveLength(1);
		expect(rulesets[0]).not.toContain(hexMark(stale.mark));
	});

	test("backend restart retains recovered support that matches the desired mark and table", async () => {
		const next = prepared([uplink("kept", "wlan0", 100)]);
		const desiredRoute = next.routes[0];
		if (desiredRoute === undefined)
			throw new Error("missing desired route fixture");
		const log: string[] = [];
		const deps = makeApplierDeps(log, []);
		deps.discoverRoutes = async () => [
			{ ...desiredRoute, identity: "recovered:opaque", ifname: "unknown0" },
		];
		const applier = new UplinkSteeringApplier(deps);

		await applier.apply(undefined, next);

		expect(log).toEqual(["ensure:wlan0", "ruleset:activate", "forward:on"]);
	});
});

function makeApplierDeps(
	log: string[],
	appliedRulesets: string[],
): UplinkSteeringApplierDeps {
	return {
		discoverRoutes: async () => [],
		ensureRoute: async (route): Promise<RouteProvisioning> => {
			log.push(`ensure:${route.ifname}`);
			return { route, changed: route.identity === "new" };
		},
		rollbackRoute: async (provisioning) => {
			log.push(`rollback:${provisioning.route.ifname}`);
		},
		removeRoute: async (route) => {
			log.push(`remove:${route.ifname}`);
		},
		applyRuleset: async (ruleset, mode) => {
			log.push(`ruleset:${mode}`);
			appliedRulesets.push(ruleset);
		},
		deactivateSharing: async () => {
			log.push("deactivate");
		},
		flushConntrack: async (mark) => {
			log.push(`flush:${mark}`);
		},
		setIpForwarding: async (enabled) => {
			log.push(`forward:${enabled ? "on" : "off"}`);
		},
		publishFlowsReset: (event) => {
			log.push(`event:${event.iface}:${event.linkId}`);
		},
	};
}

function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
