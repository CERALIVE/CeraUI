import { expect, spyOn, test } from "bun:test";
import * as retries from "../helpers/retry.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	handleWifiMonitorEvent,
	registerPendingConfirmation,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

const productionPoll = defaultHotspotDeps.pollHotspotActive;
if (!productionPoll) throw new Error("Missing production confirmation probe");

for (const mode of ["infrastructure", "unknown", "ap"] as const) {
	test(`connected event cannot confirm a pending AP from ${mode} on another UUID`, async () => {
		const f = await firstAp();
		spyOn(interfaces, "wifiUpdateDevices").mockResolvedValue(false);
		const outcomes: unknown[] = [];
		f.deps.publishOutcome = (kind, device, outcome) =>
			outcomes.push([kind, device, outcome]);
		f.deps.pollHotspotActive = productionPoll;
		f.faults.confirmationPending = true;
		try {
			expect(await f.start()).toEqual({ success: true });
			f.row.conn = "station-uuid";
			f.row.activeConn = "station-uuid";
			f.row.activeMode = mode;
			f.observe("station-uuid", mode);
			await handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state: "connected",
			});
			expect(outcomes).toEqual([]);
			expect(f.row.conn).toBe("station-uuid");
			expect(f.row.hotspot.transition).toBe("activating");
			await settlePending("wlan0", false);
			expect(outcomes).toEqual([
				["start", 0, { success: false, error: "not-confirmed" }],
			]);
		} finally {
			await f.restore();
		}
	});
}

test("only the selected active UUID in AP mode confirms the pending hotspot", async () => {
	const f = await firstAp();
	spyOn(interfaces, "wifiUpdateDevices").mockResolvedValue(false);
	const outcomes: unknown[] = [];
	f.deps.publishOutcome = (kind, device, outcome) =>
		outcomes.push([kind, device, outcome]);
	f.deps.pollHotspotActive = productionPoll;
	f.faults.confirmationPending = true;
	try {
		expect(await f.start()).toEqual({ success: true });
		f.row.activeConn = f.created() ?? null;
		f.row.activeMode = "infrastructure";
		f.observe(f.created(), "infrastructure");
		await handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "connected",
		});
		expect(outcomes).toEqual([]);
		f.row.activeMode = "ap";
		f.observe(f.created(), "ap");
		await handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "connected",
		});
		expect(outcomes).toEqual([["start", 0, { success: true }]]);
	} finally {
		await f.restore();
	}
});

test("an old confirmation backstop cannot settle a newer pending profile", async () => {
	const f = await firstAp();
	const scheduled: Array<() => Promise<unknown>> = [];
	const scheduler = Promise.withResolvers<never>();
	spyOn(retries, "retryWithBackoff").mockImplementation((operation) => {
		scheduled.push(operation);
		return scheduler.promise;
	});
	const outcomes: unknown[] = [];
	let observedUuid: string | undefined;
	f.deps.pollHotspotActive = async (_iface, uuid) => uuid === observedUuid;
	f.deps.publishOutcome = (kind, device, outcome) =>
		outcomes.push([kind, device, outcome]);
	try {
		expect(await f.start()).toEqual({ success: true });
		f.row.hotspot.conn = "next-ap";
		registerPendingConfirmation(
			{ macAddress: MAC, uuid: "next-ap", ifname: f.row.ifname },
			f.row,
			f.deps,
		);
		const [oldBackstop, nextBackstop] = scheduled;
		if (!oldBackstop || !nextBackstop)
			throw new Error("Missing scheduled backstops");
		expect(await oldBackstop()).toBe(true);
		expect(outcomes).toEqual([]);
		observedUuid = "next-ap";
		f.observe("next-ap", "ap");
		expect(await nextBackstop()).toBe(true);
		expect(outcomes).toEqual([["start", 0, { success: true }]]);
	} finally {
		scheduler.reject(new Error("Fixture scheduler stopped"));
		await f.restore();
	}
});
