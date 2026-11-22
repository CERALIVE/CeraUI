import { jest, mock, spyOn } from "bun:test";
import { logger } from "../../helpers/logger.ts";
import * as runner from "../../helpers/run.ts";
import * as mocks from "../../mocks/mock-service.ts";
import { getConfig } from "../../modules/config.ts";
import * as nm from "../../modules/network/network-manager.ts";
import * as profileInstances from "../../modules/network/network-manager-profile-instance.ts";
import * as nmSecrets from "../../modules/network/network-manager-secret.ts";
import * as streaming from "../../modules/streaming/streaming.ts";
import * as credentials from "../../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../../modules/wifi/state/wifi-state.ts";
import * as apSta from "../../modules/wifi/wifi-ap-sta-capability.ts";
import * as capabilities from "../../modules/wifi/wifi-capabilities.ts";
import * as concurrent from "../../modules/wifi/wifi-concurrent-interface.ts";
import * as connections from "../../modules/wifi/wifi-connections.ts";
import * as devices from "../../modules/wifi/wifi-device-list.ts";
import {
	defaultHotspotDeps,
	startHotspotForInterface,
} from "../../modules/wifi/wifi-hotspot-activation.ts";
import {
	type HotspotStopDeps,
	wifiHotspotStop,
} from "../../modules/wifi/wifi-hotspot-config.ts";
import * as monitor from "../../modules/wifi/wifi-hotspot-monitor.ts";
import { canHotspot } from "../../modules/wifi/wifi-hotspot-types.ts";
import * as interfaces from "../../modules/wifi/wifi-interfaces.ts";
import { wifiRadioObservation } from "../../modules/wifi/wifi-radio-observation.ts";
import { nmcliFieldNames, nmcliFieldOutput } from "./nmcli-field-output.ts";
import { RUN_ID } from "./wifi-active-observation.ts";
import {
	mockQualifiedHybridDriver,
	qualifiedHybridEvidence,
} from "./wifi-hybrid-qualification.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./wifi-radio-equivalence-shadow.ts";

export const BINDING_MAC = "58:02:05:e1:79:1c";
export type BindingRadio = RadioFixture & { readonly active: string };
export const bindingParent: BindingRadio = {
	ifname: "wlan0",
	ifindex: 3,
	phy: 0,
	permanent: BINDING_MAC,
	operational: BINDING_MAC,
	state: "connected",
	active: "station",
};
export const bindingVirtual: BindingRadio = {
	...bindingParent,
	ifname: "clap-wlan0",
	ifindex: 4,
	active: "old-ap",
};

export async function virtualBindingFixture() {
	mockQualifiedHybridDriver();
	jest.useFakeTimers();
	const priorModes = getConfig().wifi_modes;
	getConfig().wifi_modes = {};
	let radios: readonly BindingRadio[] = [];
	let listing: "complete" | "failed" | "partial" = "complete";
	let parentHandoff: string | undefined;
	let unreadableHandoffMode: string | undefined;
	const active = new Set<string>(["foreign-ap"]);
	const down: string[] = [];
	const modified = new Set<string>();
	let confirmation = false;
	const profile = (uuid: string, fields: readonly string[]) => {
		if (
			uuid === unreadableHandoffMode &&
			fields.length === 1 &&
			fields[0] === "802-11-wireless.mode"
		) {
			unreadableHandoffMode = undefined;
			throw new Error("Current handoff mode is temporarily unreadable");
		}
		const values: Record<string, string> = {
			"802-11-wireless.mode": uuid === "station" ? "infrastructure" : "ap",
			"802-11-wireless.ssid": uuid,
			"802-11-wireless-security.psk": "synthetic-binding-password",
			"802-11-wireless.channel": "0",
			"802-11-wireless.band": "",
			"802-11-wireless-security.key-mgmt": "wpa-psk",
			"connection.autoconnect-priority": "999",
			"802-11-wireless.hidden": "no",
			"802-11-wireless-security.pairwise": "ccmp",
			"802-11-wireless-security.group": "ccmp",
			"802-11-wireless-security.proto": "rsn",
			"802-11-wireless-security.pmf": "1",
			"connection.interface-name":
				uuid === "old-ap" && parentHandoff !== uuid
					? "clap-wlan0"
					: (radios.find((r) => !r.ifname.startsWith("clap-"))?.ifname ??
						"wlan0"),
			"802-11-wireless.mac-address":
				uuid === "old-ap" && parentHandoff !== uuid ? "" : BINDING_MAC,
		};
		return fields.map((field) => values[field] ?? "");
	};
	wifiRadioObservation.reopenForTest();
	connections.clearWifiInterfacesForTest();
	interfaces.resetWifiInterfaceDiscoveryForTest();
	interfaces.resetWifiConnectionModeCache();
	credentials.resetHotspotCredentialsForTest();
	for (const conn of ["previous-parent", "old-ap"])
		credentials.rememberHotspotCredentials(BINDING_MAC, {
			conn,
			ssid: conn,
			password: "synthetic-binding-password",
		});
	spyOn(nmSecrets, "readVerifiedNmWifiSecret").mockImplementation(
		async (uuid) =>
			uuid === "station" ? undefined : "synthetic-binding-password",
	);
	setWifiState({});
	onWifiChange(() => undefined);
	for (const level of ["debug", "info", "warn", "error"] as const)
		spyOn(logger, level).mockReturnValue(logger);
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(streaming, "getIsStreaming").mockReturnValue(false);
	const restoreSysfs = await fakeShadowSysfs(() => radios);
	spyOn(apSta, "supportsApStaConcurrency").mockResolvedValue(true);
	spyOn(capabilities, "refreshWifiCapabilities").mockResolvedValue(undefined);
	spyOn(nm, "nmDevices").mockImplementation(async () => {
		if (listing === "failed") return undefined;
		const rows = radios.map((r) => `${r.ifname}:wifi:${r.state}:${r.active}`);
		return listing === "partial" ? [...rows.slice(0, 1), "incomplete"] : rows;
	});
	const activePath = (ifname: string) => {
		const index = radios.findIndex((radio) => radio.ifname === ifname);
		return `/org/freedesktop/NetworkManager/ActiveConnection/${index + 1}`;
	};
	spyOn(profileInstances, "nmRunId").mockResolvedValue(RUN_ID);
	spyOn(nm, "nmDeviceProp").mockImplementation(async (ifname, fields) => {
		if (fields === "GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH") {
			const current = radios.find((radio) => radio.ifname === ifname);
			if (
				current?.active &&
				(active.has(current.active) || current.active === "station")
			)
				return ["100", current.active, activePath(ifname)];
			return ["30", "", ""];
		}
		return ["Fixture", "Radio", "yes", "no", "yes"];
	});
	spyOn(nm, "nmConnsGet").mockResolvedValue([]);
	spyOn(nm, "nmConnSetFields").mockImplementation(async (uuid) => {
		modified.add(uuid);
		return true;
	});
	spyOn(connections, "wifiUpdateScanResult").mockResolvedValue(false);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		const names = nmcliFieldNames(args);
		if (bin === "nmcli" && names.length > 0) {
			const values = profile(args.at(-1) ?? "", names);
			return nmcliFieldOutput(args, (field) => values[names.indexOf(field)]);
		}
		throw new Error(`Unexpected binding fixture command ${bin}`);
	});
	concurrent.setConcurrentInterfaceDepsForTest(
		async () => "Interface clap-wlan0\n ifindex 4\n wdev 0x4\n type managed\n",
		async () => true,
	);
	const row = () => {
		const parentName =
			radios.find((r) => !r.ifname.startsWith("clap-"))?.ifname ?? "wlan0";
		const current = connections.getWifiInterfaceByIfname(parentName);
		if (!current || !canHotspot(current))
			throw new Error("Missing binding fixture radio");
		return current;
	};
	const stopDeps: HotspotStopDeps = {
		nmDisconnect: async (uuid, path, runId) => {
			if (
				runId !== RUN_ID ||
				!radios.some(
					(radio) =>
						radio.active === uuid &&
						active.has(uuid) &&
						activePath(radio.ifname) === path,
				)
			)
				throw new Error("Down did not target the current device activation");
			down.push(uuid);
			active.delete(uuid);
			radios = radios.map((radio) =>
				activePath(radio.ifname) === path
					? { ...radio, active: "", state: "disconnected" }
					: radio,
			);
			return true;
		},
		nmConnSetFields: async (uuid) => {
			modified.add(uuid);
			return true;
		},
		releaseConcurrentInterface: async () => true,
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		rescan: async () => undefined,
	};
	return {
		row,
		active,
		down,
		modified,
		handoffKnownApToParent(uuid: string) {
			parentHandoff = uuid;
			unreadableHandoffMode = uuid;
			interfaces.resetWifiConnectionModeCache();
		},
		async discover(
			frame: readonly BindingRadio[],
			state: typeof listing = "complete",
		) {
			radios = frame;
			listing = state;
			active.clear();
			active.add("foreign-ap");
			for (const radio of radios)
				if (radio.active && radio.active !== "station")
					active.add(radio.active);
			devices.wifiDeviceListStartUpdate();
			for (const radio of radios)
				if (radio.operational)
					devices.wifiDeviceListAdd(radio.ifname, radio.operational);
			devices.wifiDeviceListEndUpdate();
			await interfaces.wifiUpdateDevices();
			jest.advanceTimersByTime(0);
			await wifiRadioObservation.settled;
			connections.wifiCancelScanRefresh();
			interfaces.stopWifiUpdateLoopForTest();
			return row();
		},
		async start(fail = false) {
			confirmation = false;
			const {
				recordIntent: _intent,
				pollHotspotActive: _poll,
				...defaults
			} = defaultHotspotDeps;
			return startHotspotForInterface(BINDING_MAC, row(), {
				...defaults,
				...qualifiedHybridEvidence,
				ensureConcurrentInterface: async () => ({
					ifname: concurrent.concurrentApIfname(row().ifname),
					created: false,
				}),
				readCapabilities: () => ({ staApCombo: { supported: true } }),
				credentials: credentials.hotspotCredentialsStore,
				findHotspotConn: async () => undefined,
				preferConcurrentAp: () => true,
				nmApConnAdd: async () => (fail ? undefined : "old-ap"),
				nmConnect: async () => !fail,
				nmConnSetFields: nm.nmConnSetFields,
				wifiUpdateSavedConns: async () => undefined,
				pruneHotspotConns: async () => undefined,
				broadcastState: () => undefined,
				setDupIpSuppression: () => undefined,
				pollHotspotActive: async (_iface, uuid) =>
					confirmation &&
					uuid !== undefined &&
					profile(uuid, ["802-11-wireless.mode"])[0] === "ap",
			});
		},
		async confirm() {
			const target = row().concurrentHotspot?.ifname ?? row().ifname;
			active.add("old-ap");
			radios = radios.map((radio) =>
				radio.ifname === target
					? { ...radio, active: "old-ap", state: "connected" }
					: radio,
			);
			confirmation = true;
			await monitor.handleWifiMonitorEvent({
				type: "connection-state",
				connection: row().hotspot.name ?? "",
				state: "activated",
			});
		},
		stop: () => wifiHotspotStop({ device: row().id }, stopDeps),
		async close() {
			await monitor.settlePending("wlan0", false);
			await monitor.settlePending("wlmoved", false);
			wifiRadioObservation.stop();
			await wifiRadioObservation.settled;
			await restoreSysfs();
			connections.wifiCancelScanRefresh();
			interfaces.stopWifiUpdateLoopForTest();
			connections.clearWifiInterfacesForTest();
			credentials.resetHotspotCredentialsForTest();
			concurrent.resetConcurrentInterfaceDepsForTest();
			onWifiChange(() => undefined);
			setWifiState({});
			getConfig().wifi_modes = priorModes;
			mock.restore();
			jest.useRealTimers();
		},
	};
}
