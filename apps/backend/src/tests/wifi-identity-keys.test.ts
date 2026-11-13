import {
	afterEach,
	beforeEach,
	expect,
	jest,
	mock,
	spyOn,
	test,
} from "bun:test";
import { logger } from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import * as credentials from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { setApStaCapabilityRunnerForTest } from "../modules/wifi/wifi-ap-sta-capability.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import * as connections from "../modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../modules/wifi/wifi-device-list.ts";
import { wifiHotspotPrepare } from "../modules/wifi/wifi-hotspot-activation.ts";
import * as hotspotConfig from "../modules/wifi/wifi-hotspot-config.ts";
import {
	resetWifiConnectionModeCache,
	resetWifiInterfaceDiscoveryForTest,
	stopWifiUpdateLoopForTest,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import {
	resolveWifiPermanentMac,
	setPermanentMacReaderForTest,
} from "../modules/wifi/wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	WifiRadioIdentityProducer,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { readWifiRadio } from "../modules/wifi/wifi-radio-read-budget.ts";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import type { RadioFixture } from "./helpers/wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";

const MAC = "58:02:05:e1:79:1c";
const OTHER_MAC = "dc:a6:32:aa:bb:cc";
const radio: RadioFixture = {
	ifname: "wlan0",
	operational: "02:00:00:00:00:01",
	permanent: MAC,
	ifindex: 3,
	phy: 0,
	state: "disconnected",
};
let radios: readonly RadioFixture[] = [];
let active = false;
let profileBinding = { ifname: "wlan0", mac: MAC };
let restoreSysfs: () => Promise<void>;
const storeTranscript: string[][] = [];
const writes: string[] = [];

beforeEach(async () => {
	jest.useFakeTimers();
	radios = [];
	active = false;
	profileBinding = { ifname: "wlan0", mac: MAC };
	storeTranscript.length = 0;
	writes.length = 0;
	wifiRadioObservation.reopenForTest();
	connections.clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	credentials.resetHotspotCredentialsForTest();
	setWifiState({});
	onWifiChange(() => undefined);
	connections.wifiStateInit({
		on: () => undefined,
		off: () => undefined,
		start: () => undefined,
		stop: () => undefined,
	});
	restoreSysfs = await fakeShadowSysfs(() => radios);
	setPermanentMacReaderForTest(
		async (ifname) => radios.find((r) => r.ifname === ifname)?.permanent,
	);
	setApStaCapabilityRunnerForTest(async () => "");
	capabilities.resetWifiCapabilitiesForTest();
	capabilities.setWifiCapabilityDepsForTest({
		runIw: async () => "",
		readPhyName: async () => undefined,
		pathExists: async () => false,
		readNmcliWifiProperties: async () => new Map(),
		now: () => 0,
	});
	for (const level of ["debug", "info", "warn", "error"] as const)
		spyOn(logger, level).mockReturnValue(logger);
	const get = credentials.getHotspotCredentials;
	const remember = credentials.rememberHotspotCredentials;
	spyOn(credentials, "getHotspotCredentials").mockImplementation((mac) => {
		storeTranscript.push(["get", mac]);
		return get(mac);
	});
	spyOn(credentials, "rememberHotspotCredentials").mockImplementation(
		(mac, value) => {
			storeTranscript.push(["remember", mac]);
			remember(mac, value);
		},
	);
	spyOn(runner, "run").mockImplementation(async (bin, args) => {
		if (bin !== "nmcli") throw new Error(`Unexpected command: ${bin}`);
		if (args.includes("device,type,state,con-uuid"))
			return radios
				.map(
					(r) =>
						`${r.ifname}:wifi:${r.state}:${active && r.state !== "unavailable" ? "active-ap" : ""}`,
				)
				.join("\n");
		if (
			args.includes(
				"GENERAL.VENDOR,GENERAL.PRODUCT,WIFI-PROPERTIES.AP,WIFI-PROPERTIES.5GHZ,WIFI-PROPERTIES.2GHZ",
			)
		)
			return "Fixture\nRadio\nyes\nno\nyes";
		if (args.includes("uuid,type")) return "";
		if (args.includes("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY"))
			return "";
		if (args.includes("--get-values")) {
			const fields: Record<string, string> = {
				"802-11-wireless.mode": "ap",
				"connection.autoconnect-priority": "999",
				"802-11-wireless.ssid": "fixture-ap",
				"802-11-wireless-security.psk": "fixture-password",
				"802-11-wireless.band": "",
				"802-11-wireless.channel": "0",
				"802-11-wireless.hidden": "no",
				"802-11-wireless-security.key-mgmt": "wpa-psk",
				"802-11-wireless-security.pairwise": "ccmp",
				"802-11-wireless-security.group": "ccmp",
				"802-11-wireless-security.proto": "rsn",
				"802-11-wireless-security.pmf": "1",
				"connection.interface-name": profileBinding.ifname,
				"802-11-wireless.mac-address": profileBinding.mac,
			};
			return (args[5] ?? "")
				.split(",")
				.map((key) => fields[key] ?? "")
				.join("\n");
		}
		if (args.includes("modify")) {
			writes.push(args.join(" "));
			return "";
		}
		throw new Error(`Unexpected nmcli command: ${args.join(" ")}`);
	});
});

afterEach(async () => {
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await restoreSysfs();
	connections.wifiCancelScanRefresh();
	stopWifiUpdateLoopForTest();
	connections.clearWifiInterfacesForTest();
	resetWifiInterfaceDiscoveryForTest();
	resetWifiConnectionModeCache();
	credentials.resetHotspotCredentialsForTest();
	setPermanentMacReaderForTest(null);
	setApStaCapabilityRunnerForTest(null);
	capabilities.resetWifiCapabilitiesForTest();
	onWifiChange(() => undefined);
	setWifiState({});
	wifiDeviceListStartUpdate();
	wifiDeviceListEndUpdate();
	mock.restore();
	jest.useRealTimers();
});

async function discover(frame: readonly RadioFixture[]) {
	radios = frame;
	wifiDeviceListStartUpdate();
	for (const r of radios)
		if (r.operational) wifiDeviceListAdd(r.ifname, r.operational);
	wifiDeviceListEndUpdate();
	await wifiUpdateDevices();
	jest.advanceTimersByTime(0);
	await wifiRadioObservation.settled;
	connections.wifiCancelScanRefresh();
	stopWifiUpdateLoopForTest();
	return {
		keys: Object.keys(connections.getWifiInterfacesByMacAddress()),
		wifi: wifiBuildMsg(),
	};
}

function stopFixture(uuid: string) {
	const state = {
		active: new Set([uuid]),
		modified: new Set<string>(),
		deleted: new Set<string>(),
	};
	const deps: hotspotConfig.HotspotStopDeps = {
		nmDisconnect: async (target) => {
			state.active.delete(target);
			return true;
		},
		nmConnSetFields: async (target) => {
			state.modified.add(target);
			return true;
		},
		releaseConcurrentInterface: async (ifname) => {
			state.deleted.add(ifname);
		},
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
		rescan: async () => undefined,
	};
	return { state, deps };
}

test("(1) an unreadable permanent address cannot inherit an operational cache entry or touch the store", async () => {
	setPermanentMacReaderForTest(async (name) =>
		name === "old-radio" ? MAC : undefined,
	);
	await resolveWifiPermanentMac("old-radio", radio.operational ?? "");
	active = true;
	const observed = await discover([{ ...radio, permanent: undefined }]);
	expect({
		keys: observed.keys,
		degraded: Object.values(observed.wifi).map((row) => row.degraded_reason),
		store: storeTranscript,
		writes,
	}).toEqual({
		keys: ["limited:3:0"],
		degraded: ["permanent-mac-unresolved"],
		store: [],
		writes: [],
	});
});

test("(2) the Rock topology counts distinct phys, including its clap witness, rather than interfaces", async () => {
	const topology = [
		radio,
		{ ...radio, ifname: "clap-wlan0", ifindex: 4 },
		{ ...radio, ifname: "wlan1", ifindex: 5, phy: 1, permanent: OTHER_MAC },
	];
	const observed = await discover(topology);
	const producer = new WifiRadioIdentityProducer(radioIdentityReaders);
	await producer.discover(topology.map(({ ifname }) => ({ ifname })));
	expect(producer.state.rows.get("wlan0")).toMatchObject({
		key: MAC,
		classification: "verified",
	});
	expect(observed.keys).toEqual([MAC, OTHER_MAC]);
	expect(
		Object.values(observed.wifi).map((row) => row.degraded_reason),
	).toEqual([undefined, undefined]);
});

test("(3) two non-clap interfaces on one phy remain separate limited rows", async () => {
	const observed = await discover([
		radio,
		{ ...radio, ifname: "wlan1", ifindex: 4 },
	]);
	expect(observed.keys).toEqual(["limited:3:0", "limited:4:0"]);
	expect(
		Object.values(observed.wifi).map((row) => row.degraded_reason),
	).toEqual(["permanent-mac-unresolved", "permanent-mac-unresolved"]);
});

test("capacity-deferred discovery recovers its published key and wire incarnation", async () => {
	const held = Array.from({ length: 4 }, () =>
		Promise.withResolvers<string | undefined>(),
	);
	const physical = held.map((gate) =>
		readWifiRadio(() => gate.promise, undefined),
	);
	try {
		const pending = await discover([radio]);
		expect(pending.keys).toEqual(["degraded:wlan0"]);
		expect(pending.wifi["0"]?.incarnation).toBeUndefined();
		held[0]?.resolve(undefined);
		await physical[0];
		await wifiRadioObservation.settled;
		expect(Object.keys(connections.getWifiInterfacesByMacAddress())).toEqual([
			MAC,
		]);
		expect(wifiBuildMsg()["0"]?.incarnation).toEqual(expect.any(String));
	} finally {
		for (const gate of held) gate.resolve(undefined);
		await Promise.all(physical);
	}
});

test("a same lifetime rename through unavailable preserves hotspot preparation", async () => {
	credentials.rememberHotspotCredentials(MAC, {
		ssid: "Retained fixture",
		password: "synthetic-retained-password",
		channel: "auto",
	});
	await discover([radio]);
	await discover([{ ...radio, ifname: "wlrenamed", state: "unavailable" }]);
	const resumed = await discover([{ ...radio, ifname: "wlrenamed" }]);
	const row = connections.getWifiInterfacesByMacAddress()[MAC];
	expect(resumed.keys).toEqual([MAC]);
	expect(await wifiHotspotPrepare({ device: row?.id ?? -1 })).toEqual({
		success: true,
		name: "Retained fixture",
		password: "synthetic-retained-password",
		firstTime: true,
	});
});

test("round two: unavailable rename cannot stop an AP now active on another radio", async () => {
	active = true;
	await discover([{ ...radio, state: "connected" }]);
	const before = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!before || !("hotspot" in before))
		throw new Error("fixture has no hotspot row");
	const hotspot = before.hotspot;
	const name = hotspot.name;
	const password = hotspot.password;
	// NetworkManager can move this profile after its bindings are cleared externally.
	profileBinding = { ifname: "", mac: "" };
	await discover([
		{ ...radio, ifname: "wlrenamed", state: "unavailable" },
		{
			...radio,
			ifname: "wlan1",
			ifindex: 9,
			phy: 1,
			permanent: OTHER_MAC,
			state: "connected",
		},
	]);
	const { state, deps } = stopFixture("active-ap");
	spyOn(
		hotspotConfig.defaultHotspotStopDeps,
		"nmDisconnect",
	).mockImplementation(deps.nmDisconnect);
	spyOn(
		hotspotConfig.defaultHotspotStopDeps,
		"nmConnSetFields",
	).mockImplementation(deps.nmConnSetFields);
	spyOn(
		hotspotConfig.defaultHotspotStopDeps,
		"releaseConcurrentInterface",
	).mockImplementation(deps.releaseConcurrentInterface);
	spyOn(
		hotspotConfig.defaultHotspotStopDeps,
		"broadcastState",
	).mockImplementation(deps.broadcastState);
	spyOn(
		hotspotConfig.defaultHotspotStopDeps,
		"setDupIpSuppression",
	).mockImplementation(deps.setDupIpSuppression);
	spyOn(hotspotConfig.defaultHotspotStopDeps, "rescan").mockImplementation(
		deps.rescan,
	);
	expect(
		await setWifiAdapterMode(before.id, "station", {
			...defaultAdapterModeDeps,
			persistMode: () => undefined,
			restoreMode: () => undefined,
			readPersistedMode: () => undefined,
			publishOutcome: () => undefined,
			publishHotspotOutcome: () => undefined,
		}),
	).toEqual({ success: true, applied: "station" });
	expect(state).toEqual({
		active: new Set(["active-ap"]),
		modified: new Set(),
		deleted: new Set(),
	});
	expect(connections.getWifiInterfacesByMacAddress()[MAC]).toBe(before);
	expect(before.ifname).toBe("wlrenamed");
	expect(before.conn).toBeNull();
	expect(before.activeConn).toBeNull();
	expect(before.activeMode).toBeUndefined();
	expect(before.hotspot).toBe(hotspot);
	expect({ name: hotspot.name, password: hotspot.password }).toEqual({
		name,
		password,
	});
});

for (const fixture of radioEquivalenceCases) {
	for (const incomplete of [false, true]) {
		test(`(4) every settled row has identity or a degraded reason: ${fixture.name}, incomplete=${incomplete}`, async () => {
			if (incomplete)
				spyOn(radioIdentityReaders, "readText").mockResolvedValue(undefined);
			for (const frame of fixture.frames) {
				const observed = await discover(frame);
				expect(
					Object.values(observed.wifi).filter(
						(row) =>
							row.incarnation === undefined &&
							row.degraded_reason === undefined,
					),
				).toEqual([]);
			}
		});
	}
}
