import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as time from "../helpers/time.ts";
import {
	type GatewayElectionDeps,
	updateGw,
	updateGwWrapper,
} from "../modules/network/gateways.ts";
import { deriveVerdict } from "../modules/system/apt-reachability.ts";

afterEach(() => mock.restore());

function fixture() {
	const installed: Array<[string, number]> = [];
	const deps: GatewayElectionDeps = {
		isRealDevice: async () => true,
		resolve: async () => ({ addrs: ["203.0.113.10"], fromCache: true }),
		validateDns: () => {},
		checkConnectivity: async () => true,
		interfaces: () => ({
			"uplink-a": {
				ip: "192.0.2.2",
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: true,
				error: 0,
			},
			"uplink-b": {
				ip: "198.51.100.2",
				tp: 0,
				txb: 0,
				rxb: 0,
				enabled: true,
				error: 0,
			},
		}),
		eligible: () => true,
		defaultInterface: async () => "uplink-a",
		installRoute: async (ifname, family) => {
			installed.push([ifname, family]);
		},
		probes: {
			probeRepository: async (ifname) =>
				deriveVerdict([
					{
						origin: {
							url: "https://packages.example.test",
							host: "packages.example.test",
							scheme: "https",
							probeUrl: "https://packages.example.test/",
						},
						ipv4: ifname === "uplink-b" ? "ok" : "unknown",
						ipv6: "no_route",
					},
				]),
			probeViaDevice: async () => true,
			probeViaSourceIp: async () => true,
		},
	};
	return { deps, installed };
}

describe("host repository policy reaches route application", () => {
	test("unbound HTTP success cannot short-circuit repository-aware election", async () => {
		// Given: ordinary host HTTP works through the wrong NIC.
		const h = fixture();
		// When: gateway maintenance runs without any apt error trigger.
		const result = await updateGw(h.deps);
		// Then: success includes installing the repository-working route.
		expect(result).toBe(true);
		expect(h.installed).toEqual([["uplink-b", 4]]);
	});

	test("route-install failure is false even though both connectivity probes succeed", async () => {
		// Given: a preferred NIC and an OS route write that fails.
		const h = fixture();
		// When: repair reaches that refused write.
		const result = await updateGw({
			...h.deps,
			installRoute: async () => {
				throw new Error("route refused");
			},
		});
		// Then: connectivity success cannot stand in for application success.
		expect(result).toBe(false);
	});

	test("a failed repair re-arms the queued maintenance pass", async () => {
		// Given: a failed first route write and a later ordinary polling tick.
		const clock = spyOn(time, "getms").mockReturnValue(10_000);
		const h = fixture();
		let attempts = 0;
		const deps = {
			...h.deps,
			installRoute: async () => {
				if (++attempts === 1) throw new Error("route refused");
			},
		};
		await updateGwWrapper(true, deps);
		clock.mockReturnValue(20_000);
		// When: no new request is queued by a caller.
		const repaired = await updateGwWrapper(false, deps);
		// Then: the failure itself kept repair pending.
		expect(repaired).toBe(true);
		expect(attempts).toBe(2);
	});

	test("an awaited caller joins route installation already in flight", async () => {
		// Given: maintenance is parked inside the actual route apply seam.
		const h = fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let attempts = 0;
		const deps = {
			...h.deps,
			installRoute: async () => {
				attempts++;
				entered.resolve();
				await release.promise;
			},
		};
		const maintenance = updateGwWrapper(true, deps);
		await entered.promise;
		// When: apt requests an awaited election concurrently.
		const apt = updateGwWrapper(true, deps);
		// Then: both callers share completion, not a busy/no-op success.
		expect(apt).toBe(maintenance);
		release.resolve();
		expect(await apt).toBe(true);
		expect(attempts).toBe(1);
	});

	test("an emulated host performs no network or route operations", async () => {
		// Given: production dependencies must not be invoked on a dev host.
		const h = fixture();
		const resolve = mock(h.deps.resolve);
		// When: the device gate refuses real execution.
		const result = await updateGw({
			...h.deps,
			isRealDevice: async () => false,
			resolve,
		});
		// Then: no probe or host mutation was dispatched.
		expect(result).toBe(true);
		expect(resolve).not.toHaveBeenCalled();
		expect(h.installed).toEqual([]);
	});
});
