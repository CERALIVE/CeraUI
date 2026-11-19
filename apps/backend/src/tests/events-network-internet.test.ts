import { beforeEach, expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import { resetEventEmitterForTest } from "../modules/events/emit.ts";
import {
	type GatewayElectionDeps,
	updateGw,
} from "../modules/network/gateways.ts";
import { naturalUplinkRecovery } from "../modules/network/natural-uplink-recovery.ts";
import { NETIF_ERR_HOTSPOT } from "../modules/network/network-interfaces.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";
import { networkEventsFixture } from "./events-network-fixture.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

beforeEach(() => resetEventEmitterForTest({ bootId: () => undefined }));

function gatewayFixture() {
	let reachable = true;
	const deps: GatewayElectionDeps = {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: ["203.0.113.10"], fromCache: true }),
		validateDns: () => undefined,
		checkConnectivity: async () => reachable,
		interfaces: () => ({
			eth0: { ip: "192.0.2.2", enabled: true, error: 0, tp: 0, txb: 0, rxb: 0 },
		}),
		eligible: () => true,
		defaultInterface: async () => "eth0",
		installRoute: async () => undefined,
		probes: {
			probeRepository: async () => deriveVerdict([]),
			probeViaDevice: async () => false,
			probeViaSourceIp: async () => false,
		},
	};
	return {
		deps,
		check(next: boolean, overrides: Partial<GatewayElectionDeps> = {}) {
			reachable = next;
			return updateGw({ ...deps, ...overrides });
		},
	};
}

test("healthy startup does not invent an internet restoration event", async () => {
	if (process.env.CERALIVE_TEST_FRESH_NETWORK === "1") {
		const h = networkEventsFixture();
		await gatewayFixture().check(true);
		h.advance();
		expect(h.events()).toEqual([]);
		return;
	}
	const result = await runTestCommand(
		[
			process.execPath,
			"test",
			"--timeout",
			"30000",
			import.meta.path,
			"-t",
			"^healthy startup",
		],
		{ env: { CERALIVE_TEST_FRESH_NETWORK: "1" } },
	);
	expect(result.code, result.stderr).toBe(0);
});

test("internet failure and default-route recovery emit edges, never repeated verdicts", async () => {
	const g = gatewayFixture();
	await g.check(true);
	const h = networkEventsFixture();
	await g.check(true);
	expect(h.events()).toEqual([]);
	await g.check(false);
	h.advance();
	await g.check(false);
	h.advance();
	await g.check(true);
	h.advance();
	await g.check(true);
	h.advance();
	expect(h.events()).toEqual([
		{ code: "internet_lost", params: {} },
		{ code: "internet_restored", params: {} },
	]);
});

test("an excluded default route withholds the offline claim", async () => {
	const g = gatewayFixture();
	await g.check(true);
	const h = networkEventsFixture();
	await g.check(false, {
		interfaces: () => ({
			eth0: {
				ip: "192.0.2.2",
				enabled: true,
				error: NETIF_ERR_HOTSPOT,
				tp: 0,
				txb: 0,
				rxb: 0,
			},
			eth1: {
				ip: "198.51.100.2",
				enabled: true,
				error: 0,
				tp: 0,
				txb: 0,
				rxb: 0,
			},
		}),
	});
	h.advance();
	expect(h.events()).toEqual([]);
});

test("elected connectivity restores the internet claim even when route installation fails", async () => {
	const g = gatewayFixture();
	await g.check(true);
	const h = networkEventsFixture();
	await g.check(false);
	h.advance();
	const result = await g.check(false, {
		installRoute: async () => {
			throw new Error("route refused");
		},
		probes: { ...g.deps.probes, probeViaDevice: async () => true },
	});
	h.advance();
	expect(result).toBe(false);
	expect(h.events()).toEqual([
		{ code: "internet_lost", params: {} },
		{ code: "internet_restored", params: {} },
	]);
});

test("the emulated-device gate never emits a connectivity verdict", async () => {
	const g = gatewayFixture();
	await g.check(true);
	const h = networkEventsFixture();
	await g.check(false, { isRealDevice: async () => false });
	h.advance();
	expect(h.events()).toEqual([]);
});

test.each([false, true])(
	"natural-route recovery restores only after a successful release (refused=%s)",
	async (refused) => {
		const g = gatewayFixture();
		await g.check(true);
		const h = networkEventsFixture();
		await g.check(false);
		h.advance();
		const runner: typeof run = async (_bin, args) =>
			args.includes("-6")
				? ""
				: "default dev owned proto 242 metric 49\ndefault dev eth0 proto 16 metric 50";
		const probes = {
			...g.deps.probes,
			probeRepository: async () =>
				deriveVerdict([
					{
						origin: {
							url: "https://repository.test",
							host: "repository.test",
							scheme: "https",
							probeUrl: "https://repository.test",
						},
						ipv4: "ok" as const,
						ipv6: "no_route" as const,
					},
				]),
		};
		const candidate = {
			name: "eth0",
			ip: "192.0.2.2",
			binding: { kind: "source-ip" as const, ip: "192.0.2.2" },
		};
		const recovery = naturalUplinkRecovery(runner);
		await recovery.ready([candidate], probes, () => 0);
		await recovery.ready([candidate], probes, () => 5_000);
		const result = await g.check(false, {
			routeRunner: runner,
			probes,
			now: () => 10_000,
			releaseRoutes: async () => {
				if (refused) throw new Error("release refused");
			},
		});
		h.advance();
		expect(result).toBe(!refused);
		expect(h.events()).toEqual(
			refused
				? [{ code: "internet_lost", params: {} }]
				: [
						{ code: "internet_lost", params: {} },
						{ code: "internet_restored", params: {} },
					],
		);
	},
);
