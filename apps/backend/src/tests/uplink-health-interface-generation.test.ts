import { describe, expect, it, mock, onTestFinished } from "bun:test";

import {
	NETIF_ERR_SHAREDLAN,
	type NetworkInterface,
	onNetworkInterfacesChange,
	triggerNetworkInterfacesChange,
} from "../modules/network/network-interfaces.ts";
import {
	setUplinkHealthEngineForTest,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import type { UplinkHealthRuntimeDeps } from "../modules/network/uplink-health/runtime.ts";

const netif = (): NetworkInterface => ({
	ip: "192.0.2.2",
	tp: 0,
	txb: 0,
	rxb: 0,
	enabled: true,
	error: 0,
});

function fixture(overrides: Partial<UplinkHealthRuntimeDeps> = {}) {
	setUplinkHealthEngineForTest(new UplinkHealthEngine());
	onTestFinished(() => setUplinkHealthEngineForTest(null));
	let now = 1_000;
	const interfaces: Record<string, NetworkInterface> = { eth0: netif() };
	const probe = mock(() => Promise.resolve("success" as const));
	const runtime = new UplinkHealthRuntime({
		now: () => now,
		interfaces: () => interfaces,
		onInterfacesChange: (callback) => {
			const unsubscribe = onNetworkInterfacesChange(callback);
			onTestFinished(unsubscribe);
			return unsubscribe;
		},
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: () => Promise.resolve("192.0.2.100"),
		probe,
		publish: () => undefined,
		...overrides,
	});
	return {
		runtime,
		interfaces,
		probe,
		change: () => {
			now++;
			triggerNetworkInterfacesChange();
		},
	};
}

describe("uplink health interface invalidation between ticks", () => {
	const changes: {
		name: string;
		apply: (interfaces: Record<string, NetworkInterface>) => void;
	}[] = [
		{
			name: "removed and re-added with the same address",
			apply: (interfaces) => {
				delete interfaces.eth0;
				triggerNetworkInterfacesChange();
				interfaces.eth0 = netif();
			},
		},
		{
			name: "address changes A to B to A in place",
			apply: (interfaces) => {
				const entry = interfaces.eth0;
				if (!entry) throw new Error("missing test interface");
				entry.ip = "192.0.2.3";
				triggerNetworkInterfacesChange();
				entry.ip = "192.0.2.2";
			},
		},
		{
			name: "eligibility changes away and back in place",
			apply: (interfaces) => {
				const entry = interfaces.eth0;
				if (!entry) throw new Error("missing test interface");
				entry.error = NETIF_ERR_SHAREDLAN;
				triggerNetworkInterfacesChange();
				entry.error = 0;
			},
		},
	];

	for (const change of changes) {
		it(`discards in-flight evidence when ${change.name}`, async () => {
			const started = Promise.withResolvers<void>();
			const result = Promise.withResolvers<UplinkHealthOutcome>();
			let probes = 0;
			const h = fixture({
				probe: () => {
					if (probes++ > 0) return Promise.resolve("success");
					started.resolve();
					return result.promise;
				},
			});
			const pending = h.runtime.tick();
			await started.promise;
			change.apply(h.interfaces);
			h.change();
			result.resolve("captive_portal");
			await pending;

			expect(h.runtime.records()).toEqual([]);
			await h.runtime.tick();
			expect(h.runtime.records()[0]).toMatchObject({
				state: "up",
				probes: { successes: 1, failures: 0 },
				signals: { activeAt: 1_001 },
			});
		});

		it(`does not launch an old candidate when ${change.name} during target resolution`, async () => {
			const target = Promise.withResolvers<string>();
			const h = fixture({ resolveTarget: () => target.promise });
			const pending = h.runtime.tick();
			change.apply(h.interfaces);
			h.change();
			target.resolve("192.0.2.100");
			await pending;

			expect(h.probe).not.toHaveBeenCalled();
			expect(h.runtime.records()).toEqual([]);
		});
	}

	it("keeps evidence after counters, bond selection, and equivalent entries change", async () => {
		const started = Promise.withResolvers<void>();
		const result = Promise.withResolvers<UplinkHealthOutcome>();
		const h = fixture({
			probe: () => {
				started.resolve();
				return result.promise;
			},
		});
		const pending = h.runtime.tick();
		await started.promise;
		h.interfaces.eth0 = { ...netif(), enabled: false, txb: 100, rxb: 200 };
		h.change();
		result.resolve("success");
		await pending;

		expect(h.runtime.records()[0]).toMatchObject({
			state: "up",
			probes: { successes: 1, failures: 0 },
			signals: { activeAt: 1_000 },
		});
	});
});
