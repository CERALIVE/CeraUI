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
import * as nm from "../modules/network/network-manager.ts";
import * as nmSecrets from "../modules/network/network-manager-secret.ts";
import * as credentials from "../modules/wifi/hotspot-credentials.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg, wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
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
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
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
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { readWifiRadio } from "../modules/wifi/wifi-radio-read-budget.ts";
import * as compat from "../rpc/compat.ts";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import {
	nmcliFieldNames,
	nmcliFieldOutput,
} from "./helpers/nmcli-field-output.ts";
import { mockRosterActivation } from "./helpers/wifi-active-observation.ts";
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
let profileName = "fixture-ap";
let profilePassword = "fixture-password";
let restoreSysfs: () => Promise<void>;
const storeTranscript: string[][] = [];
const writes: string[] = [];

beforeEach(async () => {
	jest.useFakeTimers();
	radios = [];
	active = false;
	profileBinding = { ifname: "wlan0", mac: MAC };
	profileName = "fixture-ap";
	profilePassword = "fixture-password";
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
			return nmcliFieldOutput(
				args,
				(field) =>
					(
						({
							"GENERAL.VENDOR": "Fixture",
							"GENERAL.PRODUCT": "Radio",
							"WIFI-PROPERTIES.AP": "yes",
							"WIFI-PROPERTIES.5GHZ": "no",
							"WIFI-PROPERTIES.2GHZ": "yes",
						}) as Record<string, string>
					)[field],
			);
		if (args.includes("uuid,type")) return "";
		if (args.includes("IN-USE,BSSID,SSID,MODE,CHAN,RATE,SIGNAL,BARS,SECURITY"))
			return "";
		if (nmcliFieldNames(args).length > 0) {
			if (["station", "virtual-station"].includes(args.at(-1) ?? ""))
				return nmcliFieldOutput(args, (field) =>
					field === "802-11-wireless.mode" ? "infrastructure" : "",
				);
			const fields: Record<string, string> = {
				"802-11-wireless.mode": "ap",
				"connection.autoconnect-priority": "999",
				"802-11-wireless.ssid": profileName,
				"802-11-wireless-security.psk": profilePassword,
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
			return nmcliFieldOutput(args, (key) => fields[key] ?? "");
		}
		if (args.includes("modify")) {
			writes.push(args.join(" "));
			return "";
		}
		throw new Error(`Unexpected nmcli command: ${args.join(" ")}`);
	});
	spyOn(nmSecrets, "readVerifiedNmWifiSecret").mockImplementation(
		async () => profilePassword,
	);
	mockRosterActivation();
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
			return true;
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

test("limited discovery reads the active AP details without adopting or repairing its profile", async () => {
	active = true;
	const observed = await discover([{ ...radio, permanent: undefined }]);
	expect(observed.wifi["0"]?.hotspot).toMatchObject({
		name: "fixture-ap",
		password: "fixture-password",
		channel: "auto",
	});
	expect(storeTranscript).toEqual([]);
	expect(writes).toEqual([]);
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

test("failed proof replacement still observes a live AP without fresh concurrency capability", async () => {
	await discover([radio]);
	const previous = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!previous || !canHotspot(previous))
		throw new Error("fixture has no hotspot row");
	previous.supportsApStaConcurrency = true;
	previous.concurrentHotspot = {
		ifname: "clap-wlan0",
		activeConn: "active-ap",
	};
	Object.assign(previous.hotspot, {
		conn: "active-ap",
		name: "fixture-ap",
		password: "fixture-password",
	});
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station",
		"clap-wlan0:wifi:connected:active-ap",
	]);
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path.endsWith("/ifindex"))
			return path.includes("/clap-wlan0/") ? "4" : undefined;
		if (path.endsWith("/index")) return "0";
		if (path.endsWith("/macaddress")) return MAC;
		return undefined;
	});
	storeTranscript.length = 0;
	const observed = await discover([
		radio,
		{ ...radio, ifname: "clap-wlan0", ifindex: 4 },
	]);
	const current = Object.values(connections.getWifiInterfacesByMacAddress())[0];
	expect(observed.keys).toEqual(["degraded:wlan0"]);
	expect(observed.wifi[String(current?.id)]?.hotspot).toMatchObject({
		name: "fixture-ap",
		password: "fixture-password",
	});
	const effects: string[] = [];
	expect(
		await wifiHotspotStop(
			{ device: current?.id ?? -1 },
			{
				nmDisconnect: async (uuid) => {
					effects.push(`down:${uuid}`);
					return true;
				},
				nmConnSetFields: async () => {
					effects.push("modify");
					return true;
				},
				releaseConcurrentInterface: async () => {
					effects.push("iw-del");
					return true;
				},
				broadcastState: () => undefined,
				setDupIpSuppression: () => undefined,
				rescan: async () => undefined,
			},
		),
	).toEqual({ success: true });
	expect(effects).toEqual(["down:active-ap"]);
	expect(storeTranscript).toEqual([]);
});

for (const priorAssociation of [false, true]) {
	test(`round two: Stop rejects a different sampled phy, prior association=${priorAssociation}`, async () => {
		const parent = { ...radio, permanent: undefined };
		const virtual = { ...parent, ifname: "clap-wlan0", ifindex: 4 };
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan0:wifi:connected:station",
			"clap-wlan0:wifi:connected:foreign-ap",
		]);
		if (priorAssociation) await discover([parent, virtual]);
		await discover([parent, { ...virtual, phy: 1, permanent: OTHER_MAC }]);
		const current = connections.getWifiInterfacesByMacAddress()["limited:3:0"];
		const { state, deps } = stopFixture("foreign-ap");
		expect(await wifiHotspotStop({ device: current?.id ?? -1 }, deps)).toEqual({
			success: true,
		});
		expect(state).toEqual({
			active: new Set(["foreign-ap"]),
			modified: new Set(),
			deleted: new Set(),
		});
		expect(current?.concurrentHotspot).toBeUndefined();
		if (!current || !canHotspot(current))
			throw new Error("fixture has no hotspot row");
		expect(current.hotspot.conn).toBeUndefined();
	});
}

test("round two: a readable virtual station cannot become the AP Stop target", async () => {
	spyOn(nm, "nmDevices").mockResolvedValue([
		"wlan0:wifi:connected:station",
		"clap-wlan0:wifi:connected:virtual-station",
	]);
	const parent = { ...radio, permanent: undefined };
	await discover([parent, { ...parent, ifname: "clap-wlan0", ifindex: 4 }]);
	const current = connections.getWifiInterfacesByMacAddress()["limited:3:0"];
	const { state, deps } = stopFixture("virtual-station");
	expect(await wifiHotspotStop({ device: current?.id ?? -1 }, deps)).toEqual({
		success: true,
	});
	expect(state).toEqual({
		active: new Set(["virtual-station"]),
		modified: new Set(),
		deleted: new Set(),
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

test("round two: exclusive details recover and survive a failed same UUID refresh", async () => {
	active = true;
	const read = nm.nmConnGetFields;
	let failDetails = true;
	spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
		if (fields.length > 1 && failDetails) {
			failDetails = false;
			return undefined;
		}
		return read(uuid, fields);
	});
	const frame = [{ ...radio, permanent: undefined }];
	const first = await discover(frame);
	expect(first.wifi["0"]?.hotspot?.name).toBeUndefined();
	const recovered = await discover(frame);
	expect(recovered.wifi["0"]?.hotspot).toMatchObject({
		name: "fixture-ap",
		password: "fixture-password",
	});
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	const retained = await discover(frame);
	expect(retained.wifi["0"]?.hotspot).toMatchObject({
		name: "fixture-ap",
		password: "fixture-password",
	});
	const { state, deps } = stopFixture("active-ap");
	spyOn(nm, "nmDevices").mockResolvedValue(["wlan0:wifi:connected:active-ap"]);
	expect(await wifiHotspotStop({ device: 0 }, deps)).toEqual({ success: true });
	expect(state).toEqual({
		active: new Set(),
		modified: new Set(),
		deleted: new Set(),
	});
	expect(storeTranscript).toEqual([]);
	expect(writes).toEqual([]);
});

for (const lostListing of [false, true]) {
	test(`round four: complete retry witnesses survive lost listing=${lostListing}`, async () => {
		const frame = [
			radio,
			{ ...radio, ifname: "clap-wlan0", ifindex: 8, phy: 1 },
			{ ...radio, ifname: "wlan1", ifindex: 9, phy: 2, permanent: OTHER_MAC },
		];
		let failed = lostListing;
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (path === "/sys/class/net/wlan1/ifindex" && !failed) {
				failed = true;
				return undefined;
			}
			const net = radios.find(
				(r) => path === `/sys/class/net/${r.ifname}/ifindex`,
			);
			if (net) return String(net.ifindex);
			const phy = radios.find((r) =>
				path.startsWith(`/sys/devices/equivalence/phy${r.phy}/`),
			);
			if (path.endsWith("/index")) return phy ? String(phy.phy) : undefined;
			if (path.endsWith("/macaddress")) return phy?.permanent;
			return undefined;
		});
		await discover(frame);
		expect(Object.keys(connections.getWifiInterfacesByMacAddress())).toContain(
			"limited:3:0",
		);
		if (lostListing) {
			spyOn(nm, "nmDevices").mockResolvedValue(undefined);
			await wifiUpdateDevices();
			jest.advanceTimersByTime(0);
		} else jest.advanceTimersByTime(250);
		await wifiRadioObservation.settled;
		expect(
			wifiRadioIdentity.state.rows.get("clap-wlan0")?.lifetime?.wiphy,
		).toBe(1);
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.classification).toBe(
			"limited",
		);
		expect(Object.keys(connections.getWifiInterfacesByMacAddress())).toContain(
			"limited:3:0",
		);
	});
}

for (const verified of [false, true]) {
	test(`round four: missing operational MAC retires moved AP verified=${verified}`, async () => {
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan0:wifi:connected:active-ap",
		]);
		await discover([{ ...radio, permanent: verified ? MAC : undefined }]);
		const key = verified ? MAC : "limited:3:0";
		const row = connections.getWifiInterfacesByMacAddress()[key];
		if (!row || !canHotspot(row)) throw new Error("Missing fixture hotspot");
		const cached = row.hotspot;
		profileBinding = { ifname: "", mac: "" };
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlrenamed:wifi:disconnected:",
			"wlan1:wifi:connected:active-ap",
		]);
		await discover([
			{
				...radio,
				ifname: "wlrenamed",
				operational: undefined,
				permanent: verified ? MAC : undefined,
			},
			{ ...radio, ifname: "wlan1", ifindex: 9, phy: 1, permanent: OTHER_MAC },
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
		spyOn(hotspotConfig.defaultHotspotStopDeps, "rescan").mockImplementation(
			deps.rescan,
		);
		spyOn(
			hotspotConfig.defaultHotspotStopDeps,
			"setDupIpSuppression",
		).mockImplementation(deps.setDupIpSuppression);
		await setWifiAdapterMode(row.id, "station", {
			...defaultAdapterModeDeps,
			persistMode: () => undefined,
			restoreMode: () => undefined,
			readPersistedMode: () => undefined,
			publishOutcome: () => undefined,
			publishHotspotOutcome: () => undefined,
		});
		expect(state.active).toEqual(new Set(["active-ap"]));
		expect(state.modified).toEqual(new Set());
		expect(row.conn).toBeNull();
		expect(row.activeConn).toBeNull();
		expect(row.activeMode).toBeUndefined();
		expect(row.hotspot).toBe(cached);
	});
}

for (const concurrent of [false, true]) {
	for (const initialFailure of [false, true]) {
		test(`round four: AP details are delivered concurrent=${concurrent} initialFailure=${initialFailure}`, async () => {
			const messages: unknown[] = [];
			spyOn(compat, "broadcastMsg").mockImplementation((type, data) => {
				if (
					type === "status" &&
					typeof data === "object" &&
					data !== null &&
					"wifi" in data
				)
					messages.push(structuredClone(data.wifi));
			});
			if (initialFailure) {
				const read = nm.nmConnGetFields;
				let failed = false;
				spyOn(nm, "nmConnGetFields").mockImplementation(
					async (uuid, fields) => {
						if (!failed && fields.length > 1) {
							failed = true;
							return undefined;
						}
						return read(uuid, fields);
					},
				);
			}
			const parent = { ...radio, permanent: undefined };
			spyOn(nm, "nmDevices").mockResolvedValue(
				concurrent
					? [
							"wlan0:wifi:connected:station",
							"clap-wlan0:wifi:connected:active-ap",
						]
					: ["wlan0:wifi:connected:active-ap"],
			);
			const frame = concurrent
				? [parent, { ...parent, ifname: "clap-wlan0", ifindex: 4 }]
				: [parent];
			await discover(frame);
			expect(messages).not.toEqual([]);
			messages.length = 0;
			profileName = "Updated AP";
			profilePassword = "updated-synthetic-password";
			await discover(frame);
			expect(messages).toContainEqual(
				expect.objectContaining({
					"0": expect.objectContaining({
						hotspot: expect.objectContaining({
							name: profileName,
							password: profilePassword,
						}),
					}),
				}),
			);
			spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
			await discover(frame);
			expect(wifiBuildMsg()["0"]?.hotspot).toMatchObject({
				name: profileName,
				password: profilePassword,
			});
		});
	}
}

for (const foreignUuid of ["foreign-ap", ""]) {
	for (const exclusiveInitially of [false, true]) {
		for (const downEvent of [
			"none",
			"idle",
			"disconnected",
			"unavailable",
			"deactivated",
			"changed-uuid",
		]) {
			test(`round four: retire previous virtual UUID foreign=${foreignUuid} exclusive=${exclusiveInitially}${downEvent === "none" ? "" : ` down=${downEvent}`}`, async () => {
				let listing = [
					`wlan0:wifi:connected:${exclusiveInitially ? "parent-ap" : "station"}`,
					"clap-wlan0:wifi:connected:old-ap",
				];
				spyOn(nm, "nmDevices").mockImplementation(async () => listing);
				const virtual = { ...radio, ifname: "clap-wlan0", ifindex: 4 };
				await discover([radio, virtual]);
				if (downEvent === "deactivated")
					connections.handleWifiMonitorEvent({
						type: "connection-state",
						connection: profileName,
						state: "deactivated",
					});
				else if (
					downEvent !== "none" &&
					downEvent !== "idle" &&
					downEvent !== "changed-uuid"
				)
					connections.handleWifiMonitorEvent({
						type: "device-state",
						device: "clap-wlan0",
						state: downEvent,
					});
				if (downEvent === "changed-uuid") {
					listing = [
						`wlan0:wifi:connected:${exclusiveInitially ? "parent-ap" : "station"}`,
						"clap-wlan0:wifi:connected:new-virtual-ap",
					];
					await discover([radio, virtual]);
				}
				// An intermediate idle listing must not erase the binding's provenance.
				if (downEvent !== "none") {
					listing = [
						`wlan0:wifi:connected:${exclusiveInitially ? "parent-ap" : "station"}`,
						"clap-wlan0:wifi:disconnected:",
					];
					await discover([radio, virtual]);
				}
				listing = [
					"wlan0:wifi:connected:parent-ap",
					`clap-wlan0:wifi:connected:${foreignUuid}`,
				];
				await discover([radio, { ...virtual, phy: 1, permanent: OTHER_MAC }]);
				const row = connections.getWifiInterfacesByMacAddress()[MAC];
				if (!row || !canHotspot(row))
					throw new Error("Missing fixture hotspot");
				expect(row.activeConn).toBe("parent-ap");
				expect(row.concurrentHotspot).toBeUndefined();
				const { state, deps } = stopFixture("parent-ap");
				if (foreignUuid) state.active.add(foreignUuid);
				expect(await wifiHotspotStop({ device: row.id }, deps)).toEqual({
					success: true,
				});
				expect(state.active).toEqual(new Set(foreignUuid ? [foreignUuid] : []));
				expect(state.deleted).toEqual(new Set());
			});
		}
	}
}

for (const failedRead of [
	"ifindex",
	"phyPath",
	"wiphy",
	"ifindex-after",
	"phyPath-after",
	"first-observation",
]) {
	test(`round five: failed witness ${failedRead} never grants duplicate MAC authority`, async () => {
		const frame = [
			radio,
			{ ...radio, ifname: "clap-wlan0", ifindex: 8, phy: 1 },
			{ ...radio, ifname: "wlan1", ifindex: 9, phy: 2, permanent: OTHER_MAC },
		];
		let initialFailure = true;
		let loseWitness = failedRead === "first-observation";
		let indexReads = 0;
		let pathReads = 0;
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (path === "/sys/class/net/wlan1/ifindex" && initialFailure) {
				initialFailure = false;
				return undefined;
			}
			if (path === "/sys/class/net/clap-wlan0/ifindex" && loseWitness) {
				indexReads++;
				if (
					failedRead === "ifindex" ||
					failedRead === "first-observation" ||
					(failedRead === "ifindex-after" && indexReads === 2)
				)
					return undefined;
			}
			if (
				path === "/sys/devices/equivalence/phy1/index" &&
				loseWitness &&
				failedRead === "wiphy"
			)
				return undefined;
			const net = radios.find(
				(r) => path === `/sys/class/net/${r.ifname}/ifindex`,
			);
			if (net) return String(net.ifindex);
			const phy = radios.find((r) =>
				path.startsWith(`/sys/devices/equivalence/phy${r.phy}/`),
			);
			if (path.endsWith("/index")) return phy ? String(phy.phy) : undefined;
			if (path.endsWith("/macaddress")) return phy?.permanent;
			return undefined;
		});
		spyOn(radioIdentityReaders, "realpath").mockImplementation(async (path) => {
			if (path === "/sys/class/net/clap-wlan0/phy80211" && loseWitness) {
				pathReads++;
				if (
					failedRead === "phyPath" ||
					(failedRead === "phyPath-after" && pathReads === 2)
				)
					return undefined;
			}
			const net = radios.find(
				(r) => path === `/sys/class/net/${r.ifname}/phy80211`,
			);
			return net ? `/sys/devices/equivalence/phy${net.phy}` : undefined;
		});
		await discover(frame);
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.classification).toBe(
			"limited",
		);
		loseWitness = true;
		for (const delay of [250, 1000, 4000]) {
			indexReads = 0;
			pathReads = 0;
			jest.advanceTimersByTime(delay);
			await wifiRadioObservation.settled;
			expect(
				wifiRadioIdentity.state.rows.get("clap-wlan0")?.classification,
			).toBe("unverified");
			expect(wifiRadioIdentity.state.rows.get("wlan0")?.classification).toBe(
				"limited",
			);
			expect(
				Object.keys(connections.getWifiInterfacesByMacAddress()),
			).toContain("limited:3:0");
		}
		// Only a fresh successful listing proves the foreign witness disappeared.
		await discover(frame.filter((item) => item.ifname !== "clap-wlan0"));
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.classification).toBe(
			"verified",
		);
	});
}

for (const state of ["disconnected", "unavailable", "deactivated"]) {
	test(`round four sibling: monitor ${state} retires parent active observations`, async () => {
		active = true;
		await discover([radio]);
		const row = connections.getWifiInterfacesByMacAddress()[MAC];
		if (!row || !canHotspot(row)) throw new Error("Missing fixture hotspot");
		row.saved["fixture-ap"] = "active-ap";
		if (state === "deactivated")
			connections.handleWifiMonitorEvent({
				type: "connection-state",
				connection: "fixture-ap",
				state,
			});
		else
			connections.handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state,
			});
		expect(row.conn).toBeNull();
		expect(row.activeConn).toBeNull();
		expect(row.activeMode).toBeUndefined();
	});
}

test("round four sibling: unrelated connection down preserves the current connection", async () => {
	await discover([radio]);
	const row = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!row) throw new Error("Missing fixture row");
	row.saved.old = "old-uuid";
	row.conn = "new-uuid";
	row.activeConn = "new-uuid";
	row.activeMode = "infrastructure";
	connections.handleWifiMonitorEvent({
		type: "connection-state",
		connection: "old",
		state: "deactivated",
	});
	expect({
		conn: row.conn,
		activeConn: row.activeConn,
		activeMode: row.activeMode,
	}).toEqual({
		conn: "new-uuid",
		activeConn: "new-uuid",
		activeMode: "infrastructure",
	});
});

for (const deviceEvent of [false, true]) {
	test(`round four sibling: virtual AP deactivation preserves parent station device=${deviceEvent}`, async () => {
		const parent = { ...radio, permanent: undefined };
		spyOn(nm, "nmDevices").mockResolvedValue([
			"wlan0:wifi:connected:station",
			"clap-wlan0:wifi:connected:active-ap",
		]);
		await discover([parent, { ...parent, ifname: "clap-wlan0", ifindex: 4 }]);
		const row = connections.getWifiInterfacesByMacAddress()["limited:3:0"];
		if (!row || !canHotspot(row)) throw new Error("Missing fixture hotspot");
		row.conn = "station";
		if (deviceEvent)
			connections.handleWifiMonitorEvent({
				type: "device-state",
				device: "clap-wlan0",
				state: "disconnected",
			});
		else
			connections.handleWifiMonitorEvent({
				type: "connection-state",
				connection: "fixture-ap",
				state: "deactivated",
			});
		expect(row.concurrentHotspot?.activeConn).toBeNull();
		expect({
			conn: row.conn,
			activeConn: row.activeConn,
			activeMode: row.activeMode,
		}).toEqual({
			conn: "station",
			activeConn: "station",
			activeMode: "infrastructure",
		});
	});
}

test("round four sibling: new station activation replaces stale parent AP observations", async () => {
	active = true;
	await discover([radio]);
	const row = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!row) throw new Error("Missing fixture row");
	row.saved.next = "station-uuid";
	connections.handleWifiMonitorEvent({
		type: "connection-state",
		connection: "next",
		state: "activated",
	});
	expect({
		conn: row.conn,
		activeConn: row.activeConn,
		activeMode: row.activeMode,
	}).toEqual({
		conn: "station-uuid",
		activeConn: "station-uuid",
		activeMode: "infrastructure",
	});
});

test("round four sibling: an activated unsaved station cannot retain the prior AP UUID", async () => {
	active = true;
	await discover([radio]);
	const row = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!row) throw new Error("Missing fixture row");
	row.available.set("unsaved", {
		active: false,
		ssid: "unsaved",
		signal: 0,
		security: "",
		freq: 0,
	});
	connections.handleWifiMonitorEvent({
		type: "connection-state",
		connection: "unsaved",
		state: "activated",
	});
	expect({
		conn: row.conn,
		activeConn: row.activeConn,
		activeMode: row.activeMode,
	}).toEqual({
		conn: null,
		activeConn: null,
		activeMode: "infrastructure",
	});
});

test("round four sibling: saved AP refresh settles before its caller can publish", async () => {
	active = true;
	await discover([radio]);
	const row = connections.getWifiInterfacesByMacAddress()[MAC];
	if (!row || !canHotspot(row)) throw new Error("Missing fixture hotspot");
	profileName = "Saved refresh AP";
	spyOn(nm, "nmConnsGet").mockResolvedValue(["active-ap:802-11-wireless"]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const read = nm.nmConnGetFields;
	spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
		if (fields.length > 3) {
			entered.resolve();
			await release.promise;
		}
		return read(uuid, fields);
	});
	let completed = false;
	const refresh = wifiUpdateSavedConns().then(() => {
		completed = true;
	});
	try {
		await entered.promise;
		await Promise.resolve();
		expect(completed).toBe(false);
		release.resolve();
		await refresh;
		expect(row.hotspot.name).toBe(profileName);
	} finally {
		release.resolve();
		await refresh;
	}
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
