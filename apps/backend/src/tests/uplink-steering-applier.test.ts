import { describe, expect, spyOn, test } from "bun:test";

import { logger } from "../helpers/logger.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import type { RouteProvisioning } from "../modules/network/uplink-steering/applier.ts";
import {
	UplinkSteeringApplier,
	type UplinkSteeringApplierDeps,
} from "../modules/network/uplink-steering/applier.ts";
import { buildShareRuleset } from "../modules/network/uplink-steering/ruleset.ts";
import { prepared, uplink } from "./uplink-steering-test-fixtures.ts";

describe("UplinkSteeringApplier", () => {
	test("publishes opaque minted link ids for recovered flow resets", async () => {
		const identity = "id-path:pci-0000:01:00.0-usb-0:1:1.0";
		const events: Array<{ readonly linkId: string }> = [];
		const previous = prepared([
			uplink(identity, "wwan0", 100),
			uplink("kept", "wlan0", 100),
		]);
		const applier = new UplinkSteeringApplier({
			...makeApplierDeps([], []),
			publishFlowsReset: (event) => events.push(event),
		});
		const state = prepared([uplink("kept", "wlan0", 100)]);

		await applier.apply(previous, state);

		expect(events).toHaveLength(1);
		const event = events[0];
		expect(event?.linkId).toMatch(/^lnk_[0-9a-f]{16}$/);
		expect(event?.linkId).toBe(mintLinkId(identity));
	});

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
			`event:wwan0:${mintLinkId("down")}`,
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
			`event:wwan0:${mintLinkId("down")}`,
			"ruleset:reload",
			"ensure:wwan0",
			"ruleset:reload",
		]);
	});

	test.each([
		{ active: true, failure: "flush" },
		{ active: true, failure: "remove" },
		{ active: false, failure: "flush" },
		{ active: false, failure: "remove" },
	])(
		"keeps committed steering and forwarding on $failure failure (active=$active)",
		async ({ active, failure }) => {
			const next = prepared(
				[uplink("new", "eth0", 100)],
				active ? undefined : [],
			);
			const stale = prepared([uplink("stale", "wwan0", 100)]).routes[0];
			if (stale === undefined) throw new Error("missing stale route fixture");
			const log: string[] = [];
			const deps = makeApplierDeps(log, []);
			deps.discoverRoutes = async () => [stale];
			let failureMessage: string | undefined = "cleanup refused";
			const depsFlush = deps.flushConntrack;
			const depsRemove = deps.removeRoute;
			if (failure === "flush") {
				deps.flushConntrack = async (mark) => {
					await depsFlush(mark);
					if (failureMessage) throw new Error(failureMessage);
				};
			} else {
				deps.removeRoute = async (route) => {
					await depsRemove(route);
					if (failureMessage) throw new Error(failureMessage);
				};
			}
			const warn = spyOn(logger, "warn").mockImplementation(() => logger);
			try {
				const applier = new UplinkSteeringApplier(deps);
				await applier.apply(undefined, next);
				expect(log).toContain(`forward:${active ? "on" : "off"}`);
				expect(log).not.toContain("rollback:eth0");
				expect(log.filter((entry) => entry === "deactivate")).toHaveLength(
					active ? 0 : 1,
				);
				expect(warn).toHaveBeenCalledTimes(1);

				await applier.retryPendingCleanup();
				expect(warn).toHaveBeenCalledTimes(1);
				failureMessage = "different cleanup failure";
				await applier.retryPendingCleanup();
				expect(warn).toHaveBeenCalledTimes(2);
				failureMessage = undefined;
				await applier.retryPendingCleanup();
				expect(log.at(-1)).toBe("remove:wwan0");
				log.length = 0;
				await applier.retryPendingCleanup();
				expect(log).toEqual([]);
			} finally {
				warn.mockRestore();
			}
		},
	);

	test("drops a pending recovered mark and table when they become desired again", async () => {
		const initial = prepared([uplink("kept", "eth0", 100)]);
		const desiredAgain = prepared([uplink("stale", "wwan0", 100)]);
		const stale = desiredAgain.routes[0];
		if (stale === undefined) throw new Error("missing stale route fixture");
		const log: string[] = [];
		const deps = makeApplierDeps(log, []);
		deps.discoverRoutes = async () => [
			{ ...stale, identity: "recovered:opaque", ifname: "unknown0" },
		];
		let rejectCleanup = true;
		deps.flushConntrack = async (mark) => {
			log.push(`flush:${mark}`);
			if (mark === stale.mark && rejectCleanup) {
				throw new Error("stale cleanup refused");
			}
		};
		const applier = new UplinkSteeringApplier(deps);
		await applier.apply(undefined, initial);
		await applier.apply(initial, desiredAgain);
		log.length = 0;

		await applier.retryPendingCleanup();
		await applier.retryPendingCleanup();

		expect(log).toEqual([]);
		rejectCleanup = false;
		await applier.apply(desiredAgain, initial);
		log.length = 0;
		await applier.retryPendingCleanup();
		expect(log).toEqual([]);
	});

	test("restores previous rules after a transition flush failure before rolling back new routes", async () => {
		const previous = prepared([uplink("old", "wwan0", 100)]);
		const next = prepared([uplink("new", "eth0", 100)]);
		const log: string[] = [];
		const rulesets: string[] = [];
		const deps = makeApplierDeps(log, rulesets);
		deps.flushConntrack = async () => {
			log.push("flush:failed");
			throw new Error("pre-commit flush refused");
		};
		const applier = new UplinkSteeringApplier(deps);

		await expect(applier.apply(previous, next)).rejects.toThrow(
			"pre-commit flush refused",
		);
		expect(rulesets.at(-1)).toBe(buildShareRuleset(previous));
		expect(log).toEqual([
			"ensure:eth0",
			"ruleset:reload",
			"flush:failed",
			"ruleset:reload",
			"rollback:eth0",
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
			`event:wwan0:${mintLinkId("a")}`,
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
