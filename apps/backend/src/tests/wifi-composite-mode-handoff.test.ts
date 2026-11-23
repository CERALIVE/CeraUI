import { expect, spyOn, test } from "bun:test";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { wifiAdapterModeRestoreSource } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { qualifiedHybridEvidence } from "./helpers/wifi-hybrid-qualification.ts";

const f = autoconnectFixture();
const OWNER = `${MAC}@${PORT}`;
const TWIN = "wlan1:wifi:disconnected:";
const LIVE = "handoff-parent-ap";
const LEG = "handoff-hybrid-leg";

function addTwin() {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "usb-OtherPort:2.0",
	});
}

function seedProfile(uuid: string) {
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy AP profile");
	f.profiles.set(uuid, {
		...legacy,
		"connection.autoconnect": "no",
		"match.path": PORT,
	});
}

async function startHandoff(arrives: boolean, virtual: boolean) {
	seedProfile(LIVE);
	if (virtual) seedProfile(LEG);
	rememberHotspotCredentials(OWNER, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: virtual ? LEG : LIVE,
	});
	removeWifiInterface(MAC);
	if (!arrives) addTwin();
	f.list(["wlan0:wifi:disconnected:", ...(arrives ? [] : [TWIN])]);
	await f.discover();
	const source = getWifiInterfacesByMacAddress()[arrives ? MAC : OWNER];
	if (!source) throw new Error("Missing source row");

	if (arrives) addTwin();
	else f.witnesses.delete("wlan1");
	if (virtual) {
		const parent = f.witnesses.get("wlan0");
		if (!parent) throw new Error("Missing parent witness");
		f.witnesses.set("clap-wlan0", { ...parent, ifindex: 7 });
	}
	return source.id;
}

function isModeRead(uuid: string, fields: readonly string[], target: string) {
	return (
		uuid === target &&
		fields.length === 1 &&
		fields[0] === "802-11-wireless.mode"
	);
}

const cases = [
	{ arrives: true, request: "station", read: "parent" },
	{ arrives: false, request: "station", read: "parent" },
	{ arrives: false, request: "hotspot", read: "virtual" },
	{ arrives: false, request: "station", read: "virtual" },
	{ arrives: true, request: "hybrid", read: "parent" },
	{ arrives: true, request: "start", read: "parent" },
] as const;

test.each(cases)(
	"$request refuses during a twin handoff (arriving=$arrives, $read mode read)",
	async ({ arrives, request, read }) => {
		const virtual = read === "virtual";
		const device = await startHandoff(arrives, virtual);
		const expectedModes = { [MAC]: "hotspot", [OWNER]: "hotspot" } as const;
		f.persistMode(MAC, "hotspot");
		f.persistMode(OWNER, "hotspot");
		const diskBefore = await Bun.file(getConfigFilePath()).text();
		f.list([
			virtual && request === "station"
				? "wlan0:wifi:disconnected:"
				: `wlan0:wifi:connected:${LIVE}`,
			...(virtual ? [`clap-wlan0:wifi:connected:${LEG}`] : []),
			...(arrives ? [TWIN] : []),
		]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const getFields = nm.nmConnGetFields;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (uuid, fields) => {
			if (isModeRead(uuid, fields, virtual ? LEG : LIVE)) {
				entered.resolve();
				await release.promise;
			}
			return getFields(uuid, fields);
		});
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:", ...(arrives ? [TWIN] : [])]);
			return true;
		});
		spyOn(
			defaultHotspotStopDeps,
			"releaseConcurrentInterface",
		).mockResolvedValue(true);
		const start = spyOn(defaultAdapterModeDeps, "startHotspot");
		const persist = spyOn(defaultAdapterModeDeps, "persistMode");
		const discovery = f.discover();
		try {
			await entered.promise;
			const actual =
				request === "start"
					? await wifiHotspotStart({ device })
					: await setWifiAdapterMode(device, request, {
							...defaultAdapterModeDeps,
							readCapabilities: () => ({ staApCombo: { supported: true } }),
							readHybridChannel: qualifiedHybridEvidence.readHybridChannel,
						});
			expect(actual).toEqual({ success: false, error: "DEVICE_BUSY" });
			expect(down).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
			expect(persist).not.toHaveBeenCalled();
			expect(getConfig().wifi_modes).toEqual(expectedModes);
			expect(await Bun.file(getConfigFilePath()).text()).toBe(diskBefore);
		} finally {
			release.resolve();
			await discovery;
		}
		if (request === "station") {
			expect(await setWifiAdapterMode(device, "station")).toEqual({
				success: true,
				applied: "station",
			});
			expect(down.mock.calls).toEqual([
				[
					virtual ? LEG : LIVE,
					ACTIVE_PATH,
					RUN_ID,
					virtual ? "clap-wlan0" : "wlan0",
				],
			]);
		}
	},
);

test("a skipped discovery defers Stop, then Station waits for the refreshed hybrid leg", async () => {
	const device = await startHandoff(false, true);
	f.list(["wlan0:wifi:disconnected:", `clap-wlan0:wifi:connected:${LEG}`]);
	const getFields = nm.nmConnGetFields;
	const read = spyOn(nm, "nmConnGetFields").mockImplementation(
		async (uuid, fields) =>
			isModeRead(uuid, fields, LEG) ? undefined : getFields(uuid, fields),
	);
	await f.discover();
	const getDevices = nm.nmDevices;
	const skipped = Promise.withResolvers<void>();
	const recovered = Promise.withResolvers<void>();
	const list = spyOn(nm, "nmDevices")
		.mockImplementationOnce(async () => {
			skipped.resolve();
			return undefined;
		})
		.mockImplementationOnce(async (...args) => {
			recovered.resolve();
			return getDevices(...args);
		});
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);
	spyOn(defaultHotspotStopDeps, "releaseConcurrentInterface").mockResolvedValue(
		true,
	);
	expect(await wifiHotspotStop({ device })).toEqual({
		success: false,
		error: "DEVICE_BUSY",
	});
	await skipped.promise;
	expect(list).toHaveBeenCalledWith("device,type,state,con-uuid");
	expect(down).not.toHaveBeenCalled();
	read.mockRestore();
	const refreshed = Promise.withResolvers<void>();
	const unsubscribe = wifiAdapterModeRestoreSource.subscribe(async () => {
		if (
			getWifiInterfacesByMacAddress()[MAC]?.concurrentHotspot?.activeConn ===
			LEG
		)
			refreshed.resolve();
	});
	try {
		expect(await setWifiAdapterMode(device, "station")).toEqual({
			success: true,
			applied: "station",
		});
		expect(down.mock.calls).toEqual([[LEG, ACTIVE_PATH, RUN_ID, "clap-wlan0"]]);
		await recovered.promise;
		await refreshed.promise;
	} finally {
		unsubscribe();
	}
	expect(await wifiHotspotStop({ device })).toEqual({ success: true });
	expect(down.mock.calls).toEqual([[LEG, ACTIVE_PATH, RUN_ID, "clap-wlan0"]]);
});
