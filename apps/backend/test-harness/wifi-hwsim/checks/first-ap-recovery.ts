import assert from "node:assert/strict";
import { run } from "../../../src/helpers/run.ts";
import { nmDeviceProp } from "../../../src/modules/network/network-manager.ts";
import { getBootReadiness } from "../../../src/modules/system/readiness.ts";
import {
	getPersistedWifiAdapterMode,
	observedWifiAdapterMode,
} from "../../../src/modules/wifi/wifi-adapter-mode.ts";
import { notifyWifiAdapterModeEdge } from "../../../src/modules/wifi/wifi-adapter-mode-events.ts";
import { startWifiAdapterModeRestore } from "../../../src/modules/wifi/wifi-adapter-mode-restore.ts";
import { wifiHotspotStart } from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotStop } from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import type { WifiInterfaceWithHotspot } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import type { FirstApCheckpoint } from "./first-ap-diagnostics.ts";
import type { NativeNmcliProbe } from "./first-ap-nmcli-shim.ts";
import { observeSavedProfileRadio } from "./first-ap-radio.ts";

export async function nativeRecoveryCase(
	target: {
		readonly uuid: string;
		readonly owner: string;
		readonly ifname: string;
	},
	row: WifiInterfaceWithHotspot,
	probe: NativeNmcliProbe,
	checkpoint: FirstApCheckpoint,
): Promise<void> {
	const count = async () =>
		(await probe.events()).filter(
			(event) => event.kind === "up" && event.uuid === target.uuid,
		).length;
	const wait = async (condition: () => Promise<boolean>, limit = 75000) => {
		const deadline = Date.now() + limit;
		do {
			await observeSavedProfileRadio(target.ifname);
			await notifyWifiAdapterModeEdge();
			if (await condition()) return;
			await Bun.sleep(100);
		} while (Date.now() < deadline);
		throw new Error("Native recovery observation deadline exceeded");
	};
	const active = async () => {
		const fields = await nmDeviceProp(
			target.ifname,
			"GENERAL.STATE,GENERAL.CON-UUID",
		);
		return (
			Number.parseInt(fields?.[0] ?? "", 10) === 100 &&
			fields?.[1] === target.uuid &&
			row.hotspot.transition === undefined &&
			observedWifiAdapterMode(row) === "hotspot"
		);
	};
	const otherHealth = () =>
		getBootReadiness().degradedSubsystems.filter(
			(value) => value !== `wifi-hotspot-restore:${target.owner}`,
		);
	const baseline = otherHealth();
	const cancel = startWifiAdapterModeRestore();
	try {
		checkpoint("recovery.loss");
		assert.equal(getPersistedWifiAdapterMode(target.owner), "hotspot");
		await notifyWifiAdapterModeEdge();
		const before = await count();
		await run("nmcli", ["connection", "down", target.uuid]);
		await wait(async () => (await active()) && (await count()) > before);
		assert.equal(row.ifname, target.ifname);
		assert.equal(row.hotspot.conn, target.uuid);
		assert.deepEqual(otherHealth(), baseline);

		checkpoint("recovery.stop");
		const stopped = await wifiHotspotStop({ device: row.id });
		checkpoint("recovery.stop", stopped);
		assert(stopped.success);
		assert.equal(getPersistedWifiAdapterMode(target.owner), "station");
		const afterStop = await count();
		const stationaryUntil = Date.now() + 3500;
		await wait(async () => {
			assert.equal(await count(), afterStop);
			const state = await nmDeviceProp(
				target.ifname,
				"GENERAL.STATE,GENERAL.CON-UUID",
			);
			assert.notEqual(state?.[1], target.uuid);
			return Date.now() >= stationaryUntil;
		}, 10000);

		checkpoint("recovery.exhaust");
		const started = await wifiHotspotStart({ device: row.id });
		checkpoint("recovery.exhaust", started);
		assert(started.success);
		await wait(active);
		await notifyWifiAdapterModeEdge();
		const initialAttempts = await count();
		await probe.block(target.uuid);
		await run("nmcli", ["connection", "down", target.uuid]);
		await wait(async () =>
			getBootReadiness().degradedSubsystems.includes(
				`wifi-hotspot-restore:${target.owner}`,
			),
		);
		assert.equal((await count()) - initialAttempts, 3);
		assert.deepEqual(otherHealth(), baseline);
		const exhaustedUntil = Date.now() + 3500;
		await wait(async () => {
			assert.equal((await count()) - initialAttempts, 3);
			return Date.now() >= exhaustedUntil;
		}, 10000);
		console.log(
			"first-ap: observed loss recovered exact owner; Stop cancelled; three failures degraded only owner",
		);
	} finally {
		cancel();
		await probe.block();
	}
}
