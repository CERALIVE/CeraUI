import { expect, onTestFinished, test } from "bun:test";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	onUplinkHealthChange,
	setUplinkHealthEngineForTest,
	UplinkHealthEngine,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";
import { recordNetworkEvents } from "./events-network-recording-fixture.ts";

const nic = (): NetworkInterface => ({
	ip: "192.0.2.2",
	enabled: true,
	tp: 0,
	txb: 0,
	rxb: 0,
	error: 0,
});

function health(
	resolveTarget: () => Promise<string | undefined> = async () => "192.0.2.100",
) {
	const h = recordNetworkEvents();
	const engine = new UplinkHealthEngine();
	setUplinkHealthEngineForTest(engine);
	const interfaces: Record<string, NetworkInterface> = {
		eth0: nic(),
		wlan0: nic(),
		wwan0: nic(),
	};
	let publications = 0;
	const runtime = new UplinkHealthRuntime({
		now: h.now,
		interfaces: () => interfaces,
		streaming: () => false,
		telemetry: () => null,
		resolveTarget,
		probe: async () => "success",
		publish: () => {
			publications++;
		},
	});
	onTestFinished(() => {
		runtime.dispose();
		setUplinkHealthEngineForTest(null);
	});
	return {
		...h,
		runtime,
		engine,
		interfaces,
		publications: () => publications,
	};
}

test.each(["unchanged", "new"] as const)(
	"every later interface transition is emitted in publication order after a %s first interface",
	async (first) => {
		const h = health();
		if (first === "new") delete h.interfaces.eth0;
		await h.runtime.tick();
		expect(h.calls).toEqual([]);
		if (first === "new") {
			h.interfaces.eth0 = nic();
			delete h.interfaces.eth0.ip;
		}
		delete h.interfaces.wlan0?.ip;
		delete h.interfaces.wwan0?.ip;
		await h.runtime.tick();
		const down = [
			{
				code: "link_down",
				params: {
					iface: "wlan0",
					kind: "wifi",
					displayName: undefined,
					reason: "definitive_loss",
				},
			},
			{
				code: "link_down",
				params: {
					iface: "wwan0",
					kind: "cellular",
					displayName: undefined,
					reason: "definitive_loss",
				},
			},
		];
		expect(h.calls).toEqual(down);
		expect(h.publications()).toBe(2);
		h.advance();
		h.interfaces.wlan0 = nic();
		h.interfaces.wwan0 = nic();
		for (let n = 0; n < 5; n++) await h.runtime.tick();
		expect(h.calls).toEqual([
			...down,
			{
				code: "link_up",
				params: {
					iface: "wlan0",
					kind: "wifi",
					displayName: undefined,
					reason: undefined,
				},
			},
			{
				code: "link_up",
				params: {
					iface: "wwan0",
					kind: "cellular",
					displayName: undefined,
					reason: undefined,
				},
			},
		]);
		h.advance();
		expect(h.events().map(({ code, params }) => [code, params.iface])).toEqual([
			["link_down", "wlan0"],
			["link_down", "wwan0"],
			["link_up", "wlan0"],
			["link_up", "wwan0"],
		]);
	},
);

test("identical health records publish once and a changed snapshot publishes once more", async () => {
	const h = health(async () => undefined);
	const notified: string[][] = [];
	const unsubscribe = onUplinkHealthChange((records) => {
		notified.push(records.map(({ state }) => state));
	});
	onTestFinished(unsubscribe);
	h.engine.observe({
		iface: "eth0",
		kind: "ethernet",
		outcome: "success",
		now: h.now(),
	});
	await h.runtime.tick();
	await h.runtime.tick();
	expect(h.publications()).toBe(1);
	expect(h.calls).toEqual([]);
	h.engine.observe({
		iface: "eth0",
		kind: "ethernet",
		outcome: "passive_degraded",
		now: h.now(),
	});
	await h.runtime.tick();
	await h.runtime.tick();
	expect(h.publications()).toBe(2);
	expect(notified).toEqual([["up"], ["degraded"]]);
	expect(h.calls).toEqual([
		{
			code: "link_degraded",
			params: {
				iface: "eth0",
				kind: "ethernet",
				displayName: undefined,
				reason: "passive_congestion",
			},
		},
	]);
});
