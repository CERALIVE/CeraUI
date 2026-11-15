import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import { resetHotspotCredentialsForTest } from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRecorder } from "../modules/wifi/wifi-adapter-mode.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import {
	handleWifiMonitorEvent,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotOutcomeKind,
	HotspotToggleOutcome,
} from "../modules/wifi/wifi-hotspot-outcome.ts";
import type { HotspotActivationDeps } from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();

async function setup(mode: "hotspot" | "hybrid", acceptsDown = true) {
	const row = f.row();
	row.supportsApStaConcurrency = mode === "hybrid";
	getWifiIdToMacAddress()[0] = MAC;
	await f.sample();
	const events: Array<{
		kind: HotspotOutcomeKind;
		outcome: HotspotToggleOutcome;
	}> = [];
	const downs: string[] = [];
	let state: "down" | "activating" | "connected" = "down";
	const publish = (
		kind: HotspotOutcomeKind,
		_device: number | string,
		outcome: HotspotToggleOutcome,
	) => {
		events.push({ kind, outcome });
	};
	const start: HotspotActivationDeps = {
		...f.deps,
		readCapabilities: () => ({ staApCombo: { supported: mode === "hybrid" } }),
		nmConnect: async () => {
			state = "activating";
			return true;
		},
		publishOutcome: publish,
	};
	const stop: HotspotStopDeps = {
		recordIntent: wifiAdapterModeRecorder,
		nmConnSetFields: (uuid, fields) => nm.nmConnSetFields(uuid, fields),
		nmDisconnect: async (uuid) => {
			downs.push(uuid);
			if (acceptsDown) state = "down";
			return acceptsDown;
		},
		releaseConcurrentInterface: async () => undefined,
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		rescan: async () => undefined,
		publishOutcome: publish,
	};
	return {
		row,
		start,
		stop,
		events,
		downs,
		state: () => state,
		async lateConnected() {
			if (state !== "down") state = "connected";
			const target = mode === "hybrid" ? "clap-wlan0" : "wlan0";
			f.list(
				mode === "hybrid"
					? [
							"wlan0:wifi:connected:station-link",
							`${target}:wifi:${state === "connected" ? `connected:${PROFILE}` : "disconnected:"}`,
						]
					: [
							`${target}:wifi:${state === "connected" ? `connected:${PROFILE}` : "disconnected:"}`,
						],
			);
			await handleWifiMonitorEvent({
				type: "device-state",
				device: target,
				state: "connected",
			});
		},
	};
}

test.each([
	["hotspot", true],
	["hybrid", true],
	["hotspot", false],
	["hybrid", false],
] as const)(
	"r9 accepted %s Stop requires down=%s before a late confirmation",
	async (mode, acceptsDown) => {
		const s = await setup(mode, acceptsDown);
		expect(await wifiHotspotStart({ device: 0 }, s.start)).toEqual({
			success: true,
		});
		expect(s.row.hotspot.transition).toBe("activating");
		expect(s.events).toEqual([]);
		const stopped = await wifiHotspotStop({ device: 0 }, s.stop);
		await s.lateConnected();
		expect({
			stopped,
			downs: s.downs,
			state: s.state(),
			transition: s.row.hotspot.transition ?? null,
			intent: getConfig().wifi_modes?.[MAC],
			events: s.events,
		}).toEqual({
			stopped: acceptsDown
				? { success: true }
				: { success: false, error: "deactivation-failed" },
			downs: [PROFILE],
			state: acceptsDown ? "down" : "connected",
			transition: null,
			intent: acceptsDown ? "station" : mode,
			events: [
				{ kind: "start", outcome: { success: false, error: "not-confirmed" } },
				{
					kind: "stop",
					outcome: acceptsDown
						? { success: true }
						: { success: false, error: "deactivation-failed" },
				},
			],
		});
	},
);

test.each(["create", "up"] as const)(
	"r9 Stop remains DEVICE_BUSY while the %s reply is held",
	async (phase) => {
		const s = await setup("hotspot");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		if (phase === "create") {
			resetHotspotCredentialsForTest();
			delete s.row.hotspot.conn;
			f.profiles.delete(PROFILE);
			s.start.nmApConnAdd = async () => {
				f.profiles.set(PROFILE, { "802-11-wireless.mode": "ap" });
				entered.resolve();
				await release.promise;
				return PROFILE;
			};
		} else {
			const connect = s.start.nmConnect;
			s.start.nmConnect = async (uuid, timeout) => {
				const result = await connect(uuid, timeout);
				entered.resolve();
				await release.promise;
				return result;
			};
		}
		const starting = wifiHotspotStart({ device: 0 }, s.start);
		try {
			await entered.promise;
			const effectsBeforeStop = f.effects.length;
			expect(await wifiHotspotStop({ device: 0 }, s.stop)).toEqual({
				success: false,
				error: "DEVICE_BUSY",
			});
			expect(s.downs).toEqual([]);
			expect(f.effects).toHaveLength(effectsBeforeStop);
			expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
		} finally {
			release.resolve();
			await starting;
			settlePending("wlan0", false);
		}
	},
);
