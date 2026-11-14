import { describe, expect, test } from "bun:test";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringAvailability } from "../modules/network/uplink-steering/contracts.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import { planUplinkRoute } from "../modules/network/uplink-steering/route-manager.ts";
import {
	markForSlot,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import {
	readDesiredSteeringState,
	type SteeringStateBuilderDeps,
} from "../modules/network/uplink-steering/state-builder.ts";

interface Device {
	readonly identity: string;
	readonly ifname: string;
	readonly slot?: number;
}

const earlier = {
	identity: "constructed-twin-322",
	ifname: "wwan0",
} as const;
const later = {
	identity: "constructed-twin-386",
	ifname: "wwan1",
} as const;

function netif(ip: string): NetworkInterface {
	return {
		ip,
		netmask: "255.255.255.0",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	};
}

function lifecycle() {
	let devices: readonly Device[] = [];
	const statuses: SteeringAvailability[] = [];
	const flushed: number[] = [];
	const desired: PreparedSteeringState[] = [];
	const rulesets: string[] = [];
	const applier = new UplinkSteeringApplier({
		discoverRoutes: async () => [],
		ensureRoute: async (route) => ({ route, changed: false }),
		rollbackRoute: async () => {},
		removeRoute: async () => {},
		applyRuleset: async (ruleset) => {
			rulesets.push(ruleset);
		},
		deactivateSharing: async () => {},
		flushConntrack: async (mark) => {
			flushed.push(mark);
		},
		setIpForwarding: async () => {},
		publishFlowsReset: () => {},
	});
	const deps: SteeringStateBuilderDeps = {
		netifReady: () => true,
		discoverRoutes: async () => [],
		zonesReady: () => true,
		identityCovered: () => true,
		identityDeadlineExpired: () => false,
		interfaces: () => ({
			eth9: netif("10.43.0.1"),
			...Object.fromEntries(
				devices.map((device) => [
					device.ifname,
					netif(`100.64.${Number(device.ifname.slice(4))}.2`),
				]),
			),
		}),
		health: () => [],
		wifiIdentity: () => undefined,
		physicalIdentity: (ifname) =>
			devices.find((device) => device.ifname === ifname)?.identity ?? "",
		markForIdentity: (identity) => {
			const device = devices.find((device) => device.identity === identity);
			return device?.slot === undefined
				? stableUplinkMark(identity)
				: markForSlot(device.slot);
		},
		isBondCandidate: () => false,
		isClientZone: (ifname) => ifname === "eth9",
		planRoute: (candidate) =>
			planUplinkRoute(candidate, {
				run: async (command, args) => {
					expect(command).toBe("ip");
					if (args.join(" ") === "rule show")
						return "0: from all lookup local\n32766: from all lookup main\n32767: from all lookup default\n";
					if (args.slice(0, 5).join(" ") === "-4 route show default dev")
						return "default via 100.64.0.1 proto static metric 100\n";
					throw new Error(`unexpected route read: ${args.join(" ")}`);
				},
			}),
	};
	const coordinator = new UplinkSteeringCoordinator({
		readDesiredState: async (context) => {
			const next = await readDesiredSteeringState(deps, context);
			if (!("pending" in next)) desired.push(next);
			return next;
		},
		apply: (previous, next) => applier.apply(previous, next),
		publishAvailability: (status) => statuses.push(status),
		waitBeforeRetry: async () => {},
	});
	return {
		coordinator,
		statuses,
		flushed,
		desired,
		rulesets,
		reconcile: async (next: readonly Device[]) => {
			devices = next;
			await coordinator.requestReconcile();
		},
	};
}

function marks(state: PreparedSteeringState | undefined) {
	return Object.fromEntries(
		state?.uplinks.map(({ identity, mark }) => [identity, mark]) ?? [],
	);
}

describe("applied collision lifecycle", () => {
	test("joining a colliding link preserves the incumbent through the real coordinator and applier", async () => {
		const h = lifecycle();
		await h.reconcile([later]);
		await h.reconcile([earlier, later]);

		expect(marks(h.desired.at(-1))).toEqual({
			[earlier.identity]: 0xca671900,
			[later.identity]: 0xca671800,
		});
		expect(h.statuses).toEqual([{ available: true }, { available: true }]);
		expect(marks(h.coordinator.appliedState())).toEqual(
			marks(h.desired.at(-1)),
		);
		expect(h.flushed).toEqual([]);
		expect(h.rulesets).toHaveLength(2);
	});

	test("leaving a colliding link preserves the surviving applied mark", async () => {
		const h = lifecycle();
		await h.reconcile([earlier, later]);
		await h.reconcile([later]);

		expect(marks(h.desired.at(-1))).toEqual({
			[later.identity]: 0xca671900,
		});
		expect(h.statuses).toEqual([{ available: true }, { available: true }]);
		expect(marks(h.coordinator.appliedState())).toEqual(
			marks(h.desired.at(-1)),
		);
		expect(h.flushed).toEqual([0xca671800]);
	});

	test("three-way collisions assign free slots only to newcomers", async () => {
		const a = { identity: "constructed-a", ifname: "wwan0", slot: 17 };
		const b = { identity: "constructed-b", ifname: "wwan1", slot: 17 };
		const c = { identity: "constructed-c", ifname: "wwan2", slot: 17 };
		const h = lifecycle();
		await h.reconcile([c]);
		await h.reconcile([b, c]);
		await h.reconcile([a, b, c]);

		expect(marks(h.desired.at(-1))).toEqual({
			[a.identity]: 0xca001300,
			[b.identity]: 0xca001200,
			[c.identity]: 0xca001100,
		});
		expect(h.statuses).toEqual([
			{ available: true },
			{ available: true },
			{ available: true },
		]);
		expect(marks(h.coordinator.appliedState())).toEqual(
			marks(h.desired.at(-1)),
		);
		expect(h.flushed).toEqual([]);
	});

	test("an applied prober keeps its mark when a natural owner joins and leaves", async () => {
		const a = { identity: "constructed-a", ifname: "wwan0", slot: 17 };
		const b = { identity: "constructed-b", ifname: "wwan1", slot: 17 };
		const c = { identity: "constructed-c", ifname: "wwan2", slot: 18 };
		const h = lifecycle();
		await h.reconcile([a, b]);
		await h.reconcile([a, b, c]);

		expect(marks(h.desired.at(-1))).toEqual({
			[a.identity]: 0xca001100,
			[b.identity]: 0xca001200,
			[c.identity]: 0xca001300,
		});
		await h.reconcile([a, b]);
		expect(marks(h.coordinator.appliedState())).toEqual({
			[a.identity]: 0xca001100,
			[b.identity]: 0xca001200,
		});
		expect(h.statuses).toEqual([
			{ available: true },
			{ available: true },
			{ available: true },
		]);
		expect(h.flushed).toEqual([0xca001300]);
	});

	test("a newcomer cannot reuse a departing mark before its transition cleanup", async () => {
		const h = lifecycle();
		await h.reconcile([later]);
		await h.reconcile([earlier]);

		expect(marks(h.desired.at(-1))).toEqual({
			[earlier.identity]: 0xca671900,
		});
		expect(h.statuses).toEqual([{ available: true }, { available: true }]);
		expect(marks(h.coordinator.appliedState())).toEqual(
			marks(h.desired.at(-1)),
		);
		expect(h.flushed).toEqual([0xca671800]);
	});

	test("cold starts with the same identity set remain deterministic without applied history", async () => {
		for (const devices of [
			[earlier, later],
			[later, earlier],
		]) {
			const h = lifecycle();
			await h.reconcile(devices);

			expect(marks(h.coordinator.appliedState())).toEqual({
				[earlier.identity]: 0xca671800,
				[later.identity]: 0xca671900,
			});
			expect(h.statuses).toEqual([{ available: true }]);
		}
	});
});
