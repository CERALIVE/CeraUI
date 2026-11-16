import { spyOn } from "bun:test";
import type { WifiAdapterMode } from "@ceraui/rpc/schemas";
import type { HotspotCredentials } from "../../modules/wifi/hotspot-credentials.ts";
import {
	defaultAdapterModeDeps,
	reconcileWifiAdapterModes,
} from "../../modules/wifi/wifi-adapter-mode-transition.ts";
import { resetApStaCapabilityStateForTest } from "../../modules/wifi/wifi-ap-sta-capability.ts";
import { resetConcurrentInterfaceDepsForTest } from "../../modules/wifi/wifi-concurrent-interface.ts";
import * as connections from "../../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	startHotspotForInterface,
	startHotspotLocked,
} from "../../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
	stopHotspotForInterface,
	wifiHotspotConfig,
} from "../../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import {
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../../modules/wifi/wifi-interfaces.ts";
import { wifiFrameFixture } from "./wifi-frame-fixture.ts";
import { targetFixture } from "./wifi-hybrid-target.ts";

export const MAC = "dc:a6:32:aa:bb:c0";

export async function hybridFixture(first = false, recordDiscovery = true) {
	const frame = await wifiFrameFixture(false);
	const target = await targetFixture({ recordDiscovery });
	frame.row.conn = "station-uuid";
	frame.row.activeConn = "station-uuid";
	frame.row.hotspot.channel = "ch_11";
	frame.row.hotspot.availableChannels = ["auto", "ch_1", "ch_11"];
	frame.row.hotspot.derivedChannels = [
		{ channel: 1, freqMhz: 2412, band: "bg" },
		{ channel: 11, freqMhz: 2462, band: "bg" },
	];
	if (first) delete frame.row.hotspot.conn;
	const fields: Record<string, string> = {};
	const effects: string[] = [];
	let beforeUp: (() => void) | undefined;
	let failUp: (() => void) | undefined;
	let exclusive = false;
	let saved: HotspotCredentials = {
		ssid: "Original AP",
		password: "original-password",
		channel: "ch_11",
	};
	const deps = {
		...defaultHotspotDeps,
		readCapabilities: () => ({
			staApCombo: { supported: true, sameChannelOnly: true },
		}),
		preferConcurrentAp: () => !exclusive,
		nmConnSetFields: async (_uuid: string, value: Record<string, string>) => {
			Object.assign(fields, value);
			effects.push("write");
			beforeUp?.();
			beforeUp = undefined;
			return true;
		},
		nmApConnAdd: async (
			_name: string,
			_identity: { name: string; password: string },
			value: Record<string, string>,
		) => {
			Object.assign(fields, value);
			effects.push("add");
			return "new-owned-ap";
		},
		nmConnDelete: async () => true,
		nmConnect: async (uuid: string) => {
			effects.push("up");
			if (failUp) {
				const action = failUp;
				failUp = undefined;
				action();
				return false;
			}
			if (exclusive) return true;
			const connected =
				fields["802-11-wireless.band"] === "bg" &&
				fields["802-11-wireless.channel"] === "1";
			if (connected) {
				target.active(uuid);
				target.state("100 (connected)");
				const leg = target.objects.get("clap-wlan0");
				if (leg) leg.type = "AP";
			}
			return connected;
		},
		nmDisconnect: async (uuid: string) => {
			effects.push(`down:${uuid}`);
			target.active("");
			target.state("30 (disconnected)");
			const leg = target.objects.get("clap-wlan0");
			if (leg) leg.type = "managed";
			return true;
		},
		wifiUpdateSavedConns: async () => undefined,
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => undefined,
		credentials: {
			get: () => saved,
			remember: (_mac: string, value: HotspotCredentials) => {
				saved = { ...saved, ...value };
			},
		},
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
	};
	delete deps.recordIntent;
	delete deps.pollHotspotActive;
	const { recordIntent: _recordIntent, ...stopDeps } = defaultHotspotStopDeps;
	return {
		...frame,
		target,
		activationDeps: deps,
		fields,
		effects,
		saved: () => saved,
		failNextUp: (action: () => void = () => undefined) => {
			failUp = action;
		},
		changeBeforeUp: (action: () => void) => {
			beforeUp = action;
		},
		start: () => startHotspotForInterface(MAC, frame.row, deps),
		restoreFromIntent: (
			mode: "station" | "hybrid" | undefined,
			publish: typeof defaultAdapterModeDeps.publishHotspotOutcome = () =>
				undefined,
		) =>
			reconcileWifiAdapterModes(
				{
					...defaultAdapterModeDeps,
					resolveInterfaces: connections.getWifiInterfacesByMacAddress,
					readCapabilities: deps.readCapabilities,
					startHotspot: async (device, publish) => {
						const result = await startHotspotLocked(MAC, frame.row, {
							...deps,
							publishOutcome: publish,
						});
						if (!result.success) publish("start", device, result);
						return result;
					},
					publishOutcome: () => undefined,
					publishHotspotOutcome: publish,
				},
				(): Readonly<Record<string, WifiAdapterMode>> =>
					mode ? { [MAC]: mode } : {},
			),
		startExclusive: () => {
			exclusive = true;
			return startHotspotForInterface(MAC, frame.row, deps);
		},
		stop: () =>
			stopHotspotForInterface(MAC, frame.row, {
				...stopDeps,
				nmConnSetFields: deps.nmConnSetFields,
				nmDisconnect: deps.nmDisconnect,
				broadcastState: deps.broadcastState,
				setDupIpSuppression: deps.setDupIpSuppression,
				rescan: async () => undefined,
			}),
		configure: () =>
			wifiHotspotConfig(
				frame.context.ws,
				{
					device: 0,
					name: "Configured AP",
					password: "configured-password",
					channel: "ch_11",
				},
				{
					...defaultHotspotConfigDeps,
					nmConnSetFields: deps.nmConnSetFields,
					nmConnect: deps.nmConnect,
					nmDisconnect: deps.nmDisconnect,
					wifiUpdateSavedConns: deps.wifiUpdateSavedConns,
					broadcastState: deps.broadcastState,
					getCapabilities: () => undefined,
					rememberCredentials: deps.credentials.remember,
				},
			),
		observeRoam: (observe: () => Promise<unknown> = wifiUpdateDevices) => {
			spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
				deps.nmDisconnect,
			);
			spyOn(defaultHotspotStopDeps, "nmConnSetFields").mockImplementation(
				deps.nmConnSetFields,
			);
			spyOn(defaultHotspotStopDeps, "broadcastState").mockImplementation(
				deps.broadcastState,
			);
			spyOn(defaultHotspotStopDeps, "rescan").mockResolvedValue(undefined);
			return observe();
		},
		restore: async () => {
			settlePending("wlan0", false);
			resetConcurrentInterfaceDepsForTest();
			resetApStaCapabilityStateForTest();
			stopWifiUpdateLoopForTest();
			await frame.restore();
		},
	};
}
