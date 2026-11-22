import { expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { registerWifiAdapterTeardownLocked } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { reconcileWifiAdapterPolicies } from "../modules/wifi/wifi-adapter-reconciler.ts";
import * as apSta from "../modules/wifi/wifi-ap-sta-capability.ts";
import { hotspotAutoconnectPolicy } from "../modules/wifi/wifi-autoconnect-policy.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import {
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotStopDeps,
	wifiHotspotStop,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../modules/wifi/wifi-radio-publication.ts";
import {
	hotspotPrepareProcedure,
	wifiDisconnectProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import { ACTIVE_PATH, RUN_ID } from "./helpers/wifi-active-observation.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

const f = autoconnectFixture();
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};

test.each(["selection", "startup"] as const)(
	"review R3 station intent at %s disarms pinned current and historical APs across reboot",
	async (source) => {
		profile()["match.path"] = PORT;
		f.profiles.set("current-ap", { ...profile() });
		rememberHotspotCredentials(MAC, {
			ssid: "Policy AP",
			password: "fixture-password",
			conn: "current-ap",
		});
		if (source === "selection") {
			f.persistMode(MAC, "hotspot");
			await f.sample();
			expect(
				await setWifiAdapterMode(0, "station", {
					...defaultAdapterModeDeps,
					publishOutcome: () => undefined,
				}),
			).toEqual({ success: true, applied: "station" });
			expect(profile()["connection.autoconnect"]).toBe("no");
		} else f.persistMode(MAC, "station");

		await f.discover();
		await f.restore();

		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
		expect(f.activations).toEqual([]);
		expect(observedWifiAdapterMode(f.row())).toBe("station");
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	},
);

test("review R3 a rejected station policy write refuses success and restores prior intent", async () => {
	f.persistMode(MAC, "hotspot");
	const write = spyOn(nm, "nmConnSetFields").mockResolvedValue(false);

	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: false, error: "deactivation-failed" });
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
	expect(write).toHaveBeenCalledWith(
		PROFILE,
		{ "connection.autoconnect": "no" },
		expect.any(Function),
	);
});

test("Station restores prior intent if pin readback is unavailable at the disarm guard", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");
	await f.sample();
	const read = nm.nmConnGetFields;
	const pinRead = spyOn(nm, "nmConnGetFields").mockImplementation(
		(uuid, fields, separator, secrets) =>
			fields.join(",") ===
			"802-11-wireless.mac-address,match.path,connection.autoconnect"
				? Promise.resolve(undefined)
				: read(uuid, fields, separator, secrets),
	);

	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: false, error: "deactivation-failed" });
	expect(pinRead).toHaveBeenCalledWith(
		PROFILE,
		["802-11-wireless.mac-address", "match.path", "connection.autoconnect"],
		undefined,
		false,
	);
	expect(f.effects).toEqual([]);
	expect(profile()["connection.autoconnect"]).toBe("yes");
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test("Station refuses if pin readback fails only at Modify dispatch", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");
	await f.sample();
	const modify = spyOn(nm, "nmConnSetFields");
	const read = nm.nmConnGetFields;
	let deniedAtDispatch = false;
	spyOn(nm, "nmConnGetFields").mockImplementation(
		(uuid, fields, separator, secrets) => {
			if (
				uuid === PROFILE &&
				fields.join(",") ===
					"802-11-wireless.mac-address,match.path,connection.autoconnect" &&
				modify.mock.calls.length > 0
			) {
				deniedAtDispatch = true;
				return Promise.resolve(undefined);
			}
			return read(uuid, fields, separator, secrets);
		},
	);

	const result = await setWifiAdapterMode(0, "station", {
		...defaultAdapterModeDeps,
		publishOutcome: () => undefined,
	});

	expect(f.effects).toEqual([]);
	expect(result).toEqual({ success: false, error: "deactivation-failed" });
	expect(deniedAtDispatch).toBe(true);
	expect(profile()["connection.autoconnect"]).toBe("yes");
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });
});

test("a rejected station policy write keeps Station intent and still downs the AP", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	const write = spyOn(
		defaultHotspotStopDeps,
		"nmConnSetFields",
	).mockResolvedValue(false);
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);

	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: true, applied: "station" });
	expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
	expect(write).toHaveBeenCalledWith(PROFILE, {
		"connection.autoconnect": "no",
	});
});

test.each(["stop", "station"] as const)(
	"%s takes the AP down even when the mode config cannot be written",
	async (action) => {
		f.persistMode(MAC, "hotspot");
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		const configPath = getConfigFilePath();
		f.failIntent();
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:"]);
			return true;
		});

		const result =
			action === "stop"
				? await wifiHotspotStop({ device: 0 })
				: await setWifiAdapterMode(0, "station");
		expect(result.success).toBe(true);
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "hotspot" });

		await f.restore();
		expect(f.activations).toEqual([]);
		setConfigFilePath(configPath);
		await f.discover();
		expect(await Bun.file(configPath).json()).toMatchObject({
			wifi_modes: { [MAC]: "station" },
		});
	},
);

test.each(["unreadable history", "pending teardown"] as const)(
	"Station downs the live AP despite %s",
	async (failure) => {
		f.persistMode(MAC, "hotspot");
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		if (failure === "pending teardown") {
			registerWifiAdapterTeardownLocked(MAC, async () => ({
				complete: false,
				stopped: false,
			}));
		} else {
			f.profiles.set("unreadable-ap", { ...profile() });
			rememberHotspotCredentials(MAC, {
				ssid: "Policy AP",
				password: "fixture-password",
				conn: "unreadable-ap",
			});
			const read = nm.nmConnGetFields;
			spyOn(nm, "nmConnGetFields").mockImplementation((uuid, fields) =>
				uuid === "unreadable-ap"
					? Promise.resolve(undefined)
					: read(uuid, fields),
			);
		}
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockResolvedValue(true);

		expect(await setWifiAdapterMode(0, "station")).toEqual({
			success: true,
			applied: "station",
		});
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	},
);

test.each(["stop", "station"] as const)(
	"%s does not save Station if Down refuses after the config path recovers",
	async (action) => {
		f.persistMode(MAC, "hotspot");
		f.list([`wlan0:wifi:connected:${PROFILE}`]);
		await f.discover();
		const configPath = getConfigFilePath();
		f.failIntent();
		const down = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			setConfigFilePath(configPath);
			return false;
		});

		const result =
			action === "stop"
				? await wifiHotspotStop({ device: 0 })
				: await setWifiAdapterMode(0, "station");
		expect(result).toEqual({ success: false, error: "deactivation-failed" });
		expect(down.mock.calls).toEqual([[PROFILE, ACTIVE_PATH, RUN_ID, "wlan0"]]);
		expect(await Bun.file(configPath).json()).toMatchObject({
			wifi_modes: { [MAC]: "hotspot" },
		});
	},
);

test.each([undefined, "station", "hotspot", "hybrid"] as const)(
	"review R3 autoconnect arms only with AP intent, given %s",
	async (intent) => {
		if (intent !== undefined) f.persistMode(MAC, intent);
		await f.sample();
		expect(
			(
				await hotspotAutoconnectPolicy(MAC, {
					"802-11-wireless.mac-address": MAC,
					"match.path": PORT,
				})
			)?.fields["connection.autoconnect"],
		).toBe(intent === "hotspot" || intent === "hybrid" ? "yes" : "no");
	},
);

test("review R3 pinned hotspot intent keeps its reboot recovery", async () => {
	profile()["match.path"] = PORT;
	f.persistMode(MAC, "hotspot");

	await f.discover();
	await f.restore();

	expect(profile()["connection.autoconnect"]).toBe("yes");
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test.each(["hotspot", "station"] as const)(
	"review R4 rejected quiesce with %s intent withholds creation and publication until next pass",
	async (intent) => {
		f.persistMode(MAC, intent);
		removeWifiInterface(MAC);
		resetBootReadiness();
		spyOn(apSta, "supportsApStaConcurrency").mockResolvedValue(true);
		const allocate = spyOn(
			concurrent,
			"ensureConcurrentApInterface",
		).mockResolvedValue({
			ifname: "clap-wlan0",
			created: false,
			type: "managed",
		});
		const write = nm.nmConnSetFields;
		let rejected = true;
		spyOn(nm, "nmConnSetFields").mockImplementation((uuid, fields) =>
			rejected && fields["connection.autoconnect"] === "no"
				? Promise.resolve(false)
				: write(uuid, fields),
		);
		try {
			await f.discover();

			expect(allocate).not.toHaveBeenCalled();
			expect(f.publications).toEqual([]);
			expect(getWifiInterfacesByMacAddress()).toEqual({});
			expect(getBootReadiness()).toEqual({
				degraded: true,
				degradedSubsystems: [`wifi-hotspot-autoconnect:${MAC}`],
			});

			rejected = false;
			await f.discover();

			expect(profile()["connection.autoconnect"]).toBe("no");
			expect(allocate).not.toHaveBeenCalled();
			expect(f.publications).toContain("no");
			expect(f.publications).not.toContain("yes");
		} finally {
			resetBootReadiness();
		}
	},
);

test("a duplicate path on distinct phys is unreadable for autoconnect", async () => {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: "dc:a6:32:aa:bb:cc",
		path: PORT,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
});

test("a failed exclusive pin write refuses activation and never arms autoconnect", async () => {
	f.refusePin();
	expect(await f.start()).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(f.activations).toEqual([]);
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
});

test("a first profile gets both pins before its explicit reconnect is allowed to arm autoconnect", async () => {
	delete f.row().hotspot.conn;
	expect(await f.start()).toEqual({ success: true });
	expect(profile()["match.path"]).toBe(PORT);
	expect(profile()["802-11-wireless.mac-address"]).toBe(MAC);
	expect(profile()["connection.autoconnect"]).toBe("yes");
});

test("a port read across replacement cannot publish the predecessor path", async () => {
	spyOn(nm, "nmDeviceProp").mockImplementation(async (_ifname, fields) => {
		if (fields !== "GENERAL.PATH") return undefined;
		f.witnesses.set("wlan0", {
			ifindex: 99,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
			path: "usb-successor",
		});
		return [PORT];
	});
	await f.sample();
	expect(wifiRadioIdentity.state.rows.get("wlan0")?.lifetime).toBeUndefined();
});

test.each(["stop", "station"] as const)(
	"idle %s and rediscovery leave the same profile UUID active on the other radio",
	async (action) => {
		await f.discover();
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			mac: "58:02:05:e1:79:2c",
			path: "usb-foreign:1.0",
		});
		const foreignList = [
			"wlan0:wifi:disconnected:",
			`wlan1:wifi:connected:${PROFILE}`,
		];
		f.list(foreignList);
		const before = spyOn(
			defaultHotspotStopDeps,
			"nmDisconnect",
		).mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
			return true;
		});
		const during = spyOn(nm, "nmDisconnect").mockImplementation(async () => {
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
			return true;
		});

		const result =
			action === "stop"
				? await wifiHotspotStop({ device: f.row().id })
				: await setWifiAdapterMode(f.row().id, "station");
		if (action === "station") {
			expect(result).toEqual({ success: true, applied: "station" });
			expect(getConfig().wifi_modes).toEqual({ [MAC]: "station" });
		}
		await f.discover();

		expect(result.success).toBe(true);
		expect(await nm.nmDevices("device,type,state,con-uuid")).toEqual(
			foreignList,
		);
		expect(before).not.toHaveBeenCalled();
		expect(during).not.toHaveBeenCalled();
	},
);

test("Stop cannot use cached AP state to Down after the roster becomes unreadable", async () => {
	f.persistMode(MAC, "hotspot");
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);
	f.list(["wlan0:wifi:disconnected:", `wlan1:wifi:connected:${PROFILE}`]);
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	spyOn(nm, "nmDeviceProp").mockResolvedValue(undefined);
	expect(await wifiHotspotStop({ device: f.row().id })).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(down).not.toHaveBeenCalled();
});

test("Station checks for a local AP that came up after the last discovery", async () => {
	await f.discover();
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(
		async () => {
			f.list(["wlan0:wifi:disconnected:"]);
			return true;
		},
	);
	expect(await setWifiAdapterMode(f.row().id, "station")).toEqual({
		success: true,
		applied: "station",
	});
	expect(await nm.nmDevices("device,type,state,con-uuid")).toEqual([
		"wlan0:wifi:disconnected:",
	]);
	expect(down).toHaveBeenCalledTimes(1);
});

test("Station does not report applied when the fresh device roster cannot be read", async () => {
	await f.discover();
	spyOn(nm, "nmDevices").mockResolvedValue(undefined);
	const down = spyOn(defaultHotspotStopDeps, "nmDisconnect").mockResolvedValue(
		true,
	);
	expect(await setWifiAdapterMode(f.row().id, "station")).toEqual({
		success: false,
		error: "deactivation-failed",
	});
	expect(down).not.toHaveBeenCalled();
});

test("station Disconnect changes only the selected device when its UUID is also active elsewhere", async () => {
	const uuid = "station-link";
	f.profiles.set(uuid, { "802-11-wireless.mode": "infrastructure" });
	f.list([`wlan0:wifi:connected:${uuid}`]);
	await f.discover();
	f.row().saved.Station = uuid;
	f.row().conn = uuid;
	const foreign = `wlan1:wifi:connected:${uuid}`;
	f.list([`wlan0:wifi:connected:${uuid}`, foreign]);
	const down = spyOn(nm, "nmDisconnect").mockImplementation(
		async (_id, path) => {
			f.list(path === ACTIVE_PATH ? ["wlan0:wifi:disconnected:", foreign] : []);
			return true;
		},
	);
	const result = await call(
		wifiDisconnectProcedure,
		{ uuid },
		{ context: wifiProtocolContext() },
	);
	expect(result).toEqual({ success: true });
	expect(await nm.nmDevices("device,type,state,con-uuid")).toEqual([
		"wlan0:wifi:disconnected:",
		foreign,
	]);
	expect(down).toHaveBeenCalledTimes(1);
});

test("discovery Station Down cannot hit an activation that moves after the device read", async () => {
	f.persistMode(MAC, "hotspot");
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	profile()["connection.autoconnect"] = "no";
	f.persistMode(MAC, "station");
	const oldPath = "/org/freedesktop/NetworkManager/ActiveConnection/1";
	const foreign = [
		"wlan0:wifi:disconnected:",
		`wlan1:wifi:connected:${PROFILE}`,
	];
	spyOn(nm, "nmDeviceProp").mockImplementation(async (ifname, fields) => {
		if (fields === "GENERAL.PATH") return [PORT];
		if (ifname === "wlan0" && fields.startsWith("GENERAL.STATE")) {
			f.list(foreign);
			return ["100", PROFILE, oldPath];
		}
		return undefined;
	});
	const down = spyOn(nm, "nmDisconnect").mockImplementation(
		async (_uuid, path) => {
			if (path === oldPath) return false;
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
			return true;
		},
	);
	await reconcileWifiAdapterPolicies({
		identities: wifiRadioIdentity.state.rows,
		active: new Map([["wlan0", PROFILE]]),
	});
	expect(await nm.nmDevices("device,type,state,con-uuid")).toEqual(foreign);
	expect(down.mock.calls).toEqual([[PROFILE, oldPath, RUN_ID, "wlan0"]]);
});

test("credential-only Prepare preserves a deferred Station choice and its persistence retry", async () => {
	f.persistMode(MAC, "hotspot");
	f.list([`wlan0:wifi:connected:${PROFILE}`]);
	await f.discover();
	const row = f.row();
	const alias = `${MAC}@${PORT}`;
	rememberHotspotCredentials(
		MAC,
		{
			ssid: "Policy AP",
			password: "fixture-password",
			conn: PROFILE,
		},
		alias,
	);
	const configPath = getConfigFilePath();
	f.failIntent();
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		f.list(["wlan0:wifi:disconnected:"]);
		return true;
	});
	expect(await wifiHotspotStop({ device: row.id })).toEqual({ success: true });
	const incarnation = projectWifiRadioIncarnation(
		row,
		wifiRadioIdentity.state.rows.get(row.ifname),
	);
	if (!incarnation) throw new Error("Missing radio token for Prepare");
	setConfigFilePath(configPath);
	const result = await call(
		hotspotPrepareProcedure,
		{
			device: String(row.id),
			incarnation,
		},
		{ context: wifiProtocolContext() },
	);

	expect(result.success).toBe(true);
	await f.restore();
	expect(f.activations).toEqual([]);
	await f.discover();
	expect(await Bun.file(configPath).json()).toMatchObject({
		wifi_modes: { [MAC]: "station", [alias]: "station" },
	});
});
