import { expect, onTestFinished, test } from "bun:test";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	onNetifChange,
	setNetifState,
} from "../modules/network/state/netif-state.ts";
import {
	setUplinkHealthEngineForTest,
	UplinkHealthEngine,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import type { UplinkHealthOutcome } from "../modules/network/uplink-health/model.ts";
import type { UplinkHealthRuntimeDeps } from "../modules/network/uplink-health/runtime.ts";
import {
	reportAllLinksDown,
	setLifecycleIndicatorDepsForTest,
} from "../modules/streaming/lifecycle-indicators.ts";
import { networkEventsFixture } from "./events-network-fixture.ts";

function healthFixture(overrides: Partial<UplinkHealthRuntimeDeps> = {}) {
	const h = networkEventsFixture();
	const engine = new UplinkHealthEngine();
	setUplinkHealthEngineForTest(engine);
	const interfaces: Record<string, NetworkInterface> = {
		eth0: { ip: "192.0.2.2", enabled: true, error: 0, tp: 0, txb: 0, rxb: 0 },
	};
	let outcome: UplinkHealthOutcome = "success";
	const runtime = new UplinkHealthRuntime({
		now: h.now,
		interfaces: () => interfaces,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: async () => "192.0.2.100",
		probe: async () => outcome,
		publish: () => undefined,
		...overrides,
	});
	onTestFinished(() => {
		runtime.dispose();
		setUplinkHealthEngineForTest(null);
	});
	return {
		...h,
		interfaces,
		engine,
		runtime,
		tick(next: UplinkHealthOutcome = outcome) {
			outcome = next;
			return runtime.tick();
		},
	};
}

test("eth0 up to down emits once, while identical and signal-only publishes emit nothing", async () => {
	const h = healthFixture();
	await h.tick();
	expect(h.events()).toEqual([]);
	await h.tick();
	h.advance();
	await h.tick();
	expect(h.events()).toEqual([]);
	delete h.interfaces.eth0?.ip;
	await h.tick();
	expect(h.events()).toEqual([
		{
			code: "link_down",
			params: { iface: "eth0", kind: "ethernet", reason: "definitive_loss" },
		},
	]);
	await h.tick();
	h.advance();
	await h.tick();
	h.advance();
	expect(h.events()).toHaveLength(1);
});

test("degradation and recovery emit only state edges after the existing recovery threshold", async () => {
	const h = healthFixture();
	await h.tick();
	h.advance();
	await h.tick("captive_portal");
	await h.tick("captive_portal");
	await h.tick("passive_degraded");
	h.advance();
	for (let n = 0; n < 5; n++) await h.tick("success");
	h.advance();
	expect(h.events()).toEqual([
		{
			code: "link_degraded",
			params: { iface: "eth0", kind: "ethernet", reason: "captive_portal" },
		},
		{ code: "link_up", params: { iface: "eth0", kind: "ethernet" } },
	]);
});

test("health state changes are tracked independently per interface", async () => {
	const h = healthFixture();
	h.interfaces.wlan0 = {
		ip: "198.51.100.2",
		enabled: true,
		error: 0,
		tp: 0,
		txb: 0,
		rxb: 0,
	};
	await h.tick();
	await h.tick("failure");
	await h.tick("failure");
	await h.tick("failure");
	h.advance();
	expect(h.events()).toEqual([
		{
			code: "link_down",
			params: { iface: "eth0", kind: "ethernet", reason: "probe_failed" },
		},
		{
			code: "link_down",
			params: { iface: "wlan0", kind: "wifi", reason: "probe_failed" },
		},
	]);
});

test("link events retain the model's classified kind and optional display name", async () => {
	const h = healthFixture({ resolveTarget: async () => undefined });
	h.engine.observe({
		iface: "eth0",
		kind: "cellular",
		displayName: "Huawei E3372",
		outcome: "success",
		now: h.now(),
	});
	await h.tick();
	h.engine.observe({
		iface: "eth0",
		kind: "cellular",
		displayName: "Huawei E3372",
		outcome: "passive_degraded",
		now: h.now(),
	});
	await h.tick();
	h.advance();
	expect(h.events()).toEqual([
		{
			code: "link_degraded",
			params: {
				iface: "eth0",
				kind: "cellular",
				displayName: "Huawei E3372",
				reason: "passive_congestion",
			},
		},
	]);
});

test("a pruned interface returns as a first observation, without a synthetic down edge", async () => {
	const h = healthFixture();
	await h.tick();
	delete h.interfaces.eth0;
	await h.tick();
	h.interfaces.eth0 = { enabled: true, error: 0, tp: 0, txb: 0, rxb: 0 };
	await h.tick();
	h.advance();
	expect(h.events()).toEqual([]);
});

test("a new interface emits interface_added but no link event on first observation", async () => {
	setNetifState({});
	const unsubscribe = onNetifChange(() => undefined);
	onTestFinished(() => {
		unsubscribe();
		setNetifState({});
	});
	const h = healthFixture();
	setNetifState({
		eth0: {
			ip: "192.0.2.2",
			mac: "aa:bb:cc:dd:ee:ff",
			up: true,
			tp: 0,
			txb: 0,
			error: 0,
		},
	});
	await h.tick("captive_portal");
	h.advance();
	expect(h.events()).toEqual([
		{ code: "interface_added", params: { iface: "eth0", kind: "ethernet" } },
	]);
});

test("interface diffs report added and removed kinds without addresses or counter-only events", () => {
	setNetifState({});
	const unsubscribe = onNetifChange(() => undefined);
	onTestFinished(() => {
		unsubscribe();
		setNetifState({});
	});
	const h = networkEventsFixture();
	const entry = {
		ip: "192.0.2.2",
		mac: "aa:bb:cc:dd:ee:ff",
		up: true,
		tp: 0,
		txb: 0,
		error: 0,
	};
	setNetifState({ eth0: entry, wlan0: entry });
	h.advance();
	setNetifState({ eth0: { ...entry, ip: "192.0.2.3", tp: 10 }, wlan0: entry });
	h.advance();
	setNetifState({ wlan0: entry });
	h.advance();
	setNetifState({ wlan0: entry });
	h.advance();
	expect(h.events()).toEqual([
		{ code: "interface_added", params: { iface: "eth0", kind: "ethernet" } },
		{ code: "interface_added", params: { iface: "wlan0", kind: "wifi" } },
		{ code: "interface_removed", params: { iface: "eth0", kind: "ethernet" } },
	]);
});

test("bond entry and recovery emit once each and stream stop clears silently", () => {
	const h = networkEventsFixture();
	setLifecycleIndicatorDepsForTest({
		notify: () => undefined,
		removeNotification: () => ({ remove: [] }),
	});
	onTestFinished(() => setLifecycleIndicatorDepsForTest(null));
	reportAllLinksDown({ isStreaming: false, linkCount: 3, activeLinks: 0 });
	reportAllLinksDown({ isStreaming: true, linkCount: 0, activeLinks: 0 });
	reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 1 });
	expect(h.events()).toEqual([]);
	reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 0 });
	reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 0 });
	h.advance();
	reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 1 });
	reportAllLinksDown({ isStreaming: true, linkCount: 3, activeLinks: 2 });
	h.advance();
	reportAllLinksDown({ isStreaming: true, linkCount: 2, activeLinks: 0 });
	h.advance();
	reportAllLinksDown({ isStreaming: false, linkCount: 2, activeLinks: 0 });
	h.advance();
	expect(h.events()).toEqual([
		{ code: "bond_all_links_down", params: { linkCount: 3 } },
		{ code: "bond_links_recovered", params: { linkCount: 3 } },
		{ code: "bond_all_links_down", params: { linkCount: 2 } },
	]);
});
