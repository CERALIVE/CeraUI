import { expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import {
	getNetifTopologyGeneration,
	handleNetifMonitorEvent,
} from "../modules/network/network-interfaces.ts";
import * as nm from "../modules/network/network-manager.ts";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import * as regdomain from "../modules/wifi/regdomain.ts";
import { getWifiState } from "../modules/wifi/state/wifi-state.ts";
import { wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import { observedWifiAdapterMode } from "../modules/wifi/wifi-adapter-mode.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	prepareHotspotForInterface,
	startHotspotForInterface,
	startHotspotLocked,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import { findHotspotConnForAdapter } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { readHotspotProfilePins } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { bindingForRow } from "../modules/wifi/wifi-operation-binding.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const OTHER = "dc:a6:32:aa:bb:cc";
const OLD_PORT = "usb-old-port";
const iwPhy = (index: number) =>
	`Wiphy phy${index}\n\twiphy index: ${index}\n\tSupported interface modes:\n\t\t * managed\n\t\t * AP\n\tBand 1:\n\t\tFrequencies:\n\t\t\t * 2412 MHz [1] (20.0 dBm)\n`;
const liveProfileDeps = {
	findHotspotConn: findHotspotConnForAdapter,
	readProfilePins: readHotspotProfilePins,
	wifiUpdateSavedConns,
};
const profile = () => {
	const value = f.profiles.get(PROFILE);
	if (!value) throw new Error("Missing fixture profile");
	return value;
};

test("verified hybrid boot preserves its saved physical port pin", async () => {
	f.seed(true);
	profile()["match.path"] = PORT;
	await f.sample();
	f.persistMode(MAC, "hybrid");
	await f.restore();
	expect(f.activations).toEqual([PROFILE]);
	expect(profile()["match.path"]).toBe(PORT);
});

test.each(["absent", "unreadable"] as const)(
	"verified boot recreates only a confirmed %s saved UUID",
	async (state) => {
		await f.sample();
		f.persistMode(MAC, "hotspot");
		f.profiles.delete(PROFILE);
		spyOn(f.deps, "readProfileInstance").mockResolvedValue(
			state === "absent" ? null : undefined,
		);
		const add = spyOn(f.deps, "nmApConnAdd").mockResolvedValue(undefined);
		await f.restore();
		expect(
			add.mock.calls.map(([device, identity]) => [
				device,
				identity.name,
				identity.password,
			]),
		).toEqual(
			state === "absent" ? [["wlan0", "Policy AP", "fixture-password"]] : [],
		);
	},
);

test("restoring an independent port preserves that profile's WPA3 despite a WPA2 plain cache", async () => {
	const owner = `${MAC}@${PORT}`;
	const uuid = "independent-port-wpa3";
	f.row().hotspot.security = "wpa2";
	f.profiles.set(uuid, {
		...profile(),
		"match.path": PORT,
		"802-11-wireless-security.key-mgmt": "sae",
		"802-11-wireless-security.pmf": "3",
	});
	rememberHotspotCredentials(owner, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: uuid,
	});
	spyOn(f.deps, "findHotspotConn").mockResolvedValue({
		uuid,
		ssid: "Policy AP",
		password: "fixture-password",
		channel: "auto",
		macAddress: MAC,
	});
	const row = f.row();
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "usb-twin:1.0",
	});
	removeWifiInterface(MAC);
	addWifiInterface(owner, row);
	delete row.hotspot.conn;
	await f.sample();
	const binding = bindingForRow(owner, row);
	if (!binding) throw new Error("Missing verified port binding");
	await startHotspotLocked(owner, row, f.deps, {
		binding: { ...binding, bootRestore: "verified" },
	});
	expect(f.activations).toEqual([uuid]);
	expect(f.profiles.get(uuid)?.["802-11-wireless-security.key-mgmt"]).toBe(
		"sae",
	);
	expect(f.profiles.get(uuid)?.["802-11-wireless-security.pmf"]).toBe("3");
});

test("verified boot does not prune saved profiles during radio restore", async () => {
	const stale = "1e333a43-b83e-4ecf-95f8-599fa4ddbf26";
	f.profiles.set(stale, {
		...profile(),
		"connection.id": "Hotspot",
	});
	const credentials = { ssid: "Policy AP", password: "fixture-password" };
	rememberHotspotCredentials(MAC, { ...credentials, conn: stale });
	rememberHotspotCredentials(MAC, { ...credentials, conn: PROFILE });
	await f.sample();
	f.persistMode(MAC, "hotspot");
	const prune = spyOn(f.deps, "pruneHotspotConns");
	prune.mockImplementation(defaultHotspotDeps.pruneHotspotConns);
	await f.restore();
	await Promise.all(prune.mock.results.map((result) => result.value));
	expect(f.profiles.has(stale)).toBe(true);
	expect(f.deletions).toEqual([]);
	expect(f.activations).toEqual([PROFILE]);
	expect(prune).not.toHaveBeenCalled();
	// Positive control: the same production pruner must delete this profile.
	await prune(MAC, PROFILE);
	expect(f.profiles.has(stale)).toBe(false);
	expect(f.deletions).toEqual([stale]);
});

test("verified restore refuses a saved UUID now used for a station profile", async () => {
	await f.sample();
	f.persistMode(MAC, "hotspot");
	profile()["802-11-wireless.mode"] = "infrastructure";
	await f.restore();
	expect(f.activations).toEqual([]);
	expect(f.effects).toEqual([]);
});

test.each(["first probe", "repeat probe"] as const)(
	"discovery publishes both radios and preserves the armed AP on a PHY inventory timeout at %s",
	async (timeout) => {
		profile()["match.path"] = PORT;
		profile()["connection.autoconnect"] = "yes";
		listOtherRadio("independent-port");
		const before = { ...profile() };
		const inventory = spyOn(
			radioIdentityReaders,
			"readPhyInventory",
		).mockRejectedValue(new Error("iw phy timed out"));
		if (timeout === "repeat probe")
			inventory.mockResolvedValueOnce("Wiphy phy0\nWiphy phy1\n");

		await f.discover();

		expect(profile()["connection.autoconnect"]).toBe("yes");
		expect(
			Object.values(getWifiState())
				.map(({ ifname }) => ifname)
				.sort(),
		).toEqual(["wlan0", "wlan1"]);
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(inventory).toHaveBeenCalledTimes(1);
	},
);

test("a proven vacant old port permits disarm with one inventory probe through dispatch", async () => {
	profile()["match.path"] = OLD_PORT;
	listOtherRadio("independent-port");
	const inventory = spyOn(radioIdentityReaders, "readPhyInventory")
		.mockRejectedValue(new Error("iw phy timed out"))
		.mockResolvedValueOnce("Wiphy phy0\nWiphy phy1\n");

	await f.discover();

	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(profile()["match.path"]).toBe(OLD_PORT);
	expect(
		Object.values(getWifiState())
			.map(({ ifname }) => ifname)
			.sort(),
	).toEqual(["wlan0", "wlan1"]);
	expect(inventory).toHaveBeenCalledTimes(1);
});

test.each(["vacant-port disarm", "later owner's legacy repair"] as const)(
	"discovery publishes its roster without %s after an observed hotplug",
	async (action) => {
		const legacy = action === "later owner's legacy repair";
		const uuid = legacy ? "later-legacy-ap" : PROFILE;
		const staleMac = "02:00:00:00:00:33";
		const hotplug = "wlan-test-r11";
		listOtherRadio("independent-port");
		const saved = profile();
		saved["match.path"] = legacy ? PORT : OLD_PORT;
		if (legacy) {
			const pair = { ssid: "Later AP", password: "later-test-password" };
			f.profiles.set(uuid, {
				...saved,
				"802-11-wireless.ssid": pair.ssid,
				"802-11-wireless-security.psk": pair.password,
				"802-11-wireless.mac-address": staleMac,
				"connection.interface-name": "wlan1",
				"connection.autoconnect": "no",
				"match.path": "",
			});
			rememberHotspotCredentials(OTHER, { ...pair, conn: uuid });
			f.list(["wlan0:wifi:disconnected:", `wlan1:wifi:connected:${uuid}`]);
		}
		const before = { ...f.profiles.get(uuid) };
		let sample = -1;
		let topology = -1;
		let event:
			| { readonly sample: number; readonly topology: number }
			| undefined;
		const inventory = spyOn(
			radioIdentityReaders,
			"readPhyInventory",
		).mockImplementation(async () => {
			if (event) return "Wiphy phy0\nWiphy phy1\nWiphy phy2\n";
			sample = wifiRadioIdentity.publishedObservation;
			topology = getNetifTopologyGeneration();
			return "Wiphy phy0\nWiphy phy1\n";
		});
		const readFields = nm.nmConnGetFields;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (...args) => {
			const result = await readFields(...args);
			if (
				!event &&
				sample >= 0 &&
				args[0] === uuid &&
				args[1].length === 3 &&
				args[1].includes("match.path")
			) {
				f.witnesses.set(hotplug, {
					ifindex: 6,
					phy: "/sys/devices/policy/phy2",
					mac: staleMac,
					path: OLD_PORT,
				});
				handleNetifMonitorEvent({
					type: "device-state",
					device: hotplug,
					state: "connected",
				});
				event = {
					sample: wifiRadioIdentity.publishedObservation,
					topology: getNetifTopologyGeneration(),
				};
			}
			return result;
		});

		try {
			await f.discover();

			expect(topology).toBeGreaterThanOrEqual(0);
			expect(event).toEqual({ sample, topology: topology + 1 });
			expect(wifiRadioIdentity.publishedObservation).toBe(sample);
			expect(
				Object.values(getWifiState())
					.map(({ ifname }) => ifname)
					.sort(),
			).toEqual(["wlan0", "wlan1"]);
			expect(inventory).toHaveBeenCalledTimes(1);
			expect(f.profiles.get(uuid)).toEqual(before);
			expect(f.effects).toEqual([]);
		} finally {
			if (event)
				handleNetifMonitorEvent({
					type: "device-state",
					device: hotplug,
					state: "disconnected",
				});
		}
	},
);

test("Start with an unknown inventory activates the AP but skips the post-Up policy write", async () => {
	const inventory = spyOn(
		radioIdentityReaders,
		"readPhyInventory",
	).mockRejectedValue(new Error("iw phy timed out"));

	expect(await f.start()).toEqual({ success: true });

	expect(f.activations).toEqual([PROFILE]);
	expect(profile()["match.path"]).toBe(PORT);
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(
		f.effects.filter(
			({ fields }) => fields["connection.autoconnect"] !== undefined,
		),
	).toHaveLength(1);
	expect(inventory).toHaveBeenCalledTimes(1);
});

test.each(["saved AP", "new AP"] as const)(
	"Start keeps the %s up without arming after a hotplug during the post-Up pin read",
	async (kind) => {
		const hotplug = "wlan-test-r12";
		const uuid = kind === "saved AP" ? PROFILE : "new-post-up-ap";
		listOtherRadio("independent-port");
		profile()["connection.autoconnect"] = "no";
		await f.discover();
		if (kind === "new AP") {
			f.profiles.delete(PROFILE);
			delete f.row().hotspot.conn;
		}
		let sampledTopology: number | undefined;
		let sampledObservation = -1;
		let observedHotplug = false;
		const inventory = spyOn(
			radioIdentityReaders,
			"readPhyInventory",
		).mockImplementation(async () => {
			sampledTopology = getNetifTopologyGeneration();
			sampledObservation = wifiRadioIdentity.publishedObservation;
			return "Wiphy phy0\nWiphy phy1\n";
		});
		try {
			expect(
				await f.start({
					nmApConnAdd: async (_ifname, identity, fields) => {
						f.profiles.set(uuid, {
							...fields,
							"802-11-wireless.mode": "ap",
							"802-11-wireless.ssid": identity.name,
							"802-11-wireless-security.psk": identity.password,
						});
						return uuid;
					},
					readProfilePins: async (id) => {
						const pins = await readHotspotProfilePins(id);
						if (
							id === uuid &&
							sampledTopology !== undefined &&
							!observedHotplug
						) {
							expect(f.activations).toEqual([uuid]);
							f.witnesses.set(hotplug, {
								ifindex: 6,
								phy: "/sys/devices/policy/phy2",
								mac: MAC,
								path: OLD_PORT,
							});
							handleNetifMonitorEvent({
								type: "device-state",
								device: hotplug,
								state: "connected",
							});
							observedHotplug = true;
						}
						return pins;
					},
				}),
			).toEqual({ success: true });
			expect(observedHotplug).toBe(true);
			expect(getNetifTopologyGeneration()).toBe((sampledTopology ?? -2) + 1);
			expect(wifiRadioIdentity.publishedObservation).toEqual(
				sampledObservation,
			);
			expect(inventory).toHaveBeenCalledTimes(1);
			expect(f.activations).toEqual([uuid]);
			expect(f.row().hotspot.conn).toBe(uuid);
			expect(
				Object.values(getWifiState())
					.map(({ ifname }) => ifname)
					.sort(),
			).toEqual(["wlan0", "wlan1"]);
			expect(f.profiles.get(uuid)).toMatchObject({
				"connection.autoconnect": "no",
				"connection.interface-name": "",
				"match.path": PORT,
				"802-11-wireless.mac-address": MAC,
				"802-11-wireless.ssid": "Policy AP",
				"802-11-wireless-security.psk": "fixture-password",
			});
			expect(
				f.effects.filter(
					({ fields }) => fields["connection.autoconnect"] === "yes",
				),
			).toEqual([]);
		} finally {
			if (observedHotplug)
				handleNetifMonitorEvent({
					type: "device-state",
					device: hotplug,
					state: "disconnected",
				});
		}
	},
);

test.each(["Start", "discovery"] as const)(
	"%s leaves a saved old port alone when an unlisted same-MAC PHY can still occupy it",
	async (entry) => {
		f.witnesses.set("radio1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			mac: MAC,
			path: OLD_PORT,
		});
		f.list(["wlan0:wifi:disconnected:", "radio1:wifi:disconnected:"]);
		if (entry === "discovery") {
			f.witnesses.set("wlan2", {
				ifindex: 6,
				phy: "/sys/devices/policy/phy2",
				mac: OTHER,
				path: "independent-port",
			});
			f.list([
				"wlan0:wifi:disconnected:",
				"radio1:wifi:disconnected:",
				"wlan2:wifi:disconnected:",
			]);
		}
		profile()["match.path"] = OLD_PORT;
		profile()["connection.autoconnect"] = entry === "Start" ? "no" : "yes";
		const runIw = regdomain.runIw;
		spyOn(regdomain, "runIw").mockImplementation(async (args) =>
			args[0] === "phy"
				? iwPhy(0) + iwPhy(1) + (entry === "discovery" ? iwPhy(2) : "")
				: runIw(args),
		);
		const before = { ...profile() };
		await f.discover();
		expect([...wifiRadioIdentity.state.rows.keys()]).toEqual(
			entry === "discovery" ? ["wlan0", "wlan2"] : ["wlan0"],
		);
		expect(wifiRadioIdentity.state.rows.get("wlan0")?.devicePath).toBe(PORT);
		if (entry === "Start")
			expect(
				await startHotspotForInterface(MAC, f.row(), {
					...f.deps,
					...liveProfileDeps,
				}),
			).toEqual({
				success: false,
				error: "activation-failed",
			});
		else
			expect(
				Object.values(getWifiState())
					.map(({ ifname }) => ifname)
					.sort(),
			).toEqual(["wlan0", "wlan2"]);
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(f.activations).toEqual([]);
	},
);

test("(1 / M1) a confirmed unique radio with both pins can autoconnect; clap shares its phy", async () => {
	f.witnesses.set("clap-wlan0", {
		ifindex: 4,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: PORT,
	});
	expect(await f.start()).toEqual({ success: true });
	expect(profile()?.["802-11-wireless.mac-address"]).toBe(MAC);
	expect(profile()?.["match.path"]).toBe(PORT);
	expect(profile()?.["connection.autoconnect"]).toBe("yes");
});

test("(2 / M2) an unreadable port stays off and restores through saved intent", async () => {
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	f.row().conn = null;
	f.row().activeConn = null;
	await f.restore();
	expect(f.activations).toEqual([PROFILE, PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test.each([
	["yes", "cached"],
	["no", "cached"],
	["yes", "cold"],
	["no", "cold"],
] as const)(
	"sole verified radio starts its saved AP without writing its unreadable port (autoconnect=%s, %s)",
	async (autoconnect, start) => {
		f.witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
		});
		profile()["match.path"] = PORT;
		profile()["connection.autoconnect"] = autoconnect;
		if (start === "cold") {
			const { hotspot } = f.row();
			delete hotspot.conn;
			delete hotspot.name;
			delete hotspot.password;
		}
		spyOn(regdomain, "runIw").mockResolvedValue(
			"Wiphy phy0\n\twiphy index: 0\n",
		);
		const dispatch = spyOn(nm, "nmConnect").mockImplementation(
			async (...args) => Boolean(await f.deps.nmConnect(...args)),
		);
		const before = { ...profile() };

		expect(
			await f.start({ ...liveProfileDeps, nmConnect: nm.nmConnect }),
		).toEqual({ success: true });

		expect(wifiRadioIdentity.state.rows.get("wlan0")).toMatchObject({
			classification: "verified",
			permanentMac: MAC,
		});
		expect(
			wifiRadioIdentity.state.rows.get("wlan0")?.devicePath,
		).toBeUndefined();
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(f.activations).toEqual([PROFILE]);
		expect(dispatch).toHaveBeenCalledWith(
			PROFILE,
			expect.any(Number),
			expect.any(Function),
			undefined,
			"wlan0",
		);
		expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
	},
);

test.each(["hidden radio", "incomplete dump", "iw unavailable"] as const)(
	"unreadable own port requires complete kernel inventory before Start: %s",
	async (inventory) => {
		f.witnesses.set("wlan0", {
			ifindex: 3,
			phy: "/sys/devices/policy/phy0",
			mac: MAC,
		});
		if (inventory === "hidden radio") {
			f.witnesses.set("radio1", {
				ifindex: 5,
				phy: "/sys/devices/policy/phy1",
				mac: OTHER,
			});
			f.list(["wlan0:wifi:disconnected:", "radio1:wifi:disconnected:"]);
		}
		profile()["match.path"] = PORT;
		profile()["connection.autoconnect"] = "no";
		await f.discover();
		expect([...wifiRadioIdentity.state.rows.keys()]).toEqual(["wlan0"]);
		const runIw = regdomain.runIw;
		spyOn(regdomain, "runIw").mockImplementation(async (argv) => {
			if (argv[0] !== "phy") return runIw(argv);
			switch (inventory) {
				case "hidden radio":
					return iwPhy(0) + iwPhy(1);
				case "incomplete dump":
					return `${iwPhy(0)}Wiphy phy1\n`;
				case "iw unavailable":
					throw new Error("kernel inventory unavailable");
			}
		});
		const before = { ...profile() };

		expect(
			await startHotspotForInterface(MAC, f.row(), {
				...f.deps,
				...liveProfileDeps,
			}),
		).toEqual({
			success: false,
			error: "activation-failed",
		});
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(f.activations).toEqual([]);
	},
);

for (const source of ["credentials", "wifi_modes"] as const) {
	test(`(3 / M3) an absent persisted twin in ${source} prevents autoconnect`, async () => {
		const twin = `${MAC}@usb-other-port`;
		if (source === "credentials")
			rememberHotspotCredentials(twin, {
				ssid: "Twin",
				password: "twin-password",
			});
		else f.persistMode(twin, "station");
		await f.start();
		expect(profile()?.["connection.autoconnect"]).toBe("no");
	});
}

test("(4 / M4) a newly present twin quiesces current and historical owned profiles before publication", async () => {
	profile()["match.path"] = PORT;
	rememberHotspotCredentials(MAC, {
		ssid: "Policy AP",
		password: "fixture-password",
		conn: "current-ap",
	});
	f.profiles.set("current-ap", { ...profile() });
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "usb-other-port",
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(f.profiles.get("current-ap")?.["connection.autoconnect"]).toBe("no");
	expect(f.publications).not.toContain("yes");
});

test("a matching saved pin can Start when the kernel inventory is unavailable", async () => {
	profile()["match.path"] = PORT;
	const probe = spyOn(regdomain, "runIw").mockRejectedValue(
		new Error("kernel inventory unavailable"),
	);
	expect(await f.start(liveProfileDeps)).toEqual({ success: true });
	expect(probe).not.toHaveBeenCalled();
	expect(profile()["match.path"]).toBe(PORT);
	expect(f.activations).toEqual([PROFILE]);
});

for (const source of ["credentials", "wifi_modes"] as const) {
	test(`(3 / M3) persisting a second ${source} owner quiesces a previously safe profile`, async () => {
		profile()["match.path"] = PORT;
		await f.discover();
		expect(profile()["connection.autoconnect"]).toBe("yes");
		const key = `${MAC}@usb-second-port`;
		if (source === "credentials")
			rememberHotspotCredentials(key, {
				ssid: "Twin",
				password: "twin-password",
			});
		else f.persistMode(key, "station");
		await f.discover();
		expect(profile()["connection.autoconnect"]).toBe("no");
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	});
}

test("(5 / M5) hybrid restore uses intent and never arms autonomous activation", async () => {
	f.seed(true);
	await f.start();
	f.row().conn = null;
	delete f.row().concurrentHotspot;
	await f.restore();
	expect(observedWifiAdapterMode(f.row())).toBe("hybrid");
	expect(profile()?.["connection.autoconnect"]).toBe("no");
});

test("(6 / M6) boot does not rebind a quiesced profile with a contradictory port pin", async () => {
	profile()["match.path"] = "usb-old-port";
	await f.discover();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	await f.restore();
	expect(profile()?.["match.path"]).toBe("usb-old-port");
	expect(profile()?.["802-11-wireless.ssid"]).toBe("Policy AP");
	expect(observedWifiAdapterMode(f.row())).toBe("station");
	expect(f.activations).toEqual([]);
});

test("boot activates an eligible pathless profile without adding a physical pin", async () => {
	profile()["match.path"] = "";
	profile()["connection.autoconnect"] = "no";
	await f.sample();
	f.persistMode(MAC, "hotspot");
	await f.restore();
	expect(f.activations).toEqual([PROFILE]);
	expect(profile()["match.path"]).toBe("");
	expect(profile()["connection.autoconnect"]).toBe("no");
});

test("explicit Start can rebind a quiesced profile after proving its old port vacant", async () => {
	profile()["match.path"] = "usb-old-port";
	await f.discover();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	await f.start({ readProfilePins: readHotspotProfilePins });
	expect(profile()?.["match.path"]).toBe(PORT);
	expect(profile()?.["802-11-wireless.ssid"]).toBe("Policy AP");
	expect(profile()?.["802-11-wireless-security.psk"]).toBe("fixture-password");
	expect(f.activations).toEqual([PROFILE]);
	expect(observedWifiAdapterMode(f.row())).toBe("hotspot");
});

test("bound restore leaves a recorded profile alone when another radio occupies its old port", async () => {
	const oldPort = "usb-old-port";
	profile()["match.path"] = oldPort;
	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: "dc:a6:32:aa:bb:cc",
		path: oldPort,
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	const before = { ...profile() };
	const effects = [...f.effects];

	await f.restore();

	expect(profile()).toEqual(before);
	expect(f.effects).toEqual(effects);
	expect(f.activations).toEqual([]);
});

function listOtherRadio(path?: string, mac = OTHER): void {
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac,
		...(path !== undefined ? { path } : {}),
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
}

test("bound Start refuses a moved profile when a live radio's port is unknown", async () => {
	profile()["match.path"] = OLD_PORT;
	profile()["connection.autoconnect"] = "no";
	listOtherRadio();
	await f.sample();
	expect(wifiRadioIdentity.state.rows.get("wlan1")).toMatchObject({
		classification: "verified",
		permanentMac: OTHER,
	});
	expect(wifiRadioIdentity.state.rows.get("wlan1")?.devicePath).toBeUndefined();
	const before = { ...profile() };

	expect(await f.start(liveProfileDeps)).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(profile()).toEqual(before);
	expect(f.effects).toEqual([]);
	expect(f.activations).toEqual([]);
});

const pinCases = [
	{
		name: "recorded legacy MAC",
		pin: OTHER,
		port: "",
		other: "different-port",
		otherMac: "02:00:00:00:00:33",
		owner: MAC,
		armed: true,
		repair: true,
	},
	{
		name: "moved, known empty old port",
		pin: MAC,
		port: OLD_PORT,
		other: "different-port",
		owner: MAC,
		armed: false,
		repair: true,
	},
	{
		name: "moved, occupied old port",
		pin: MAC,
		port: OLD_PORT,
		other: OLD_PORT,
		owner: MAC,
		armed: false,
		repair: false,
	},
	{
		name: "moved, unknown old port occupancy",
		pin: MAC,
		port: OLD_PORT,
		other: undefined,
		owner: MAC,
		armed: false,
		repair: false,
	},
	{
		name: "moved, occupied and armed old port",
		pin: MAC,
		port: OLD_PORT,
		other: OLD_PORT,
		owner: MAC,
		armed: true,
		repair: false,
	},
	{
		name: "foreign UUID, matching MAC, other radio reports the legacy MAC",
		pin: MAC,
		port: "",
		other: "different-port",
		owner: OTHER,
		armed: true,
		repair: false,
	},
	{
		name: "foreign UUID, saved legacy MAC belongs to the other live radio",
		pin: OTHER,
		port: "",
		other: "different-port",
		owner: OTHER,
		armed: false,
		repair: false,
	},
	{
		name: "foreign UUID, saved port matches the requested radio",
		pin: MAC,
		port: PORT,
		other: "different-port",
		owner: OTHER,
		armed: true,
		repair: false,
	},
	{
		name: "foreign UUID, matching old port, other radio occupies it",
		pin: MAC,
		port: OLD_PORT,
		other: OLD_PORT,
		owner: OTHER,
		armed: true,
		repair: false,
	},
] as const;

for (const scenario of pinCases) {
	test.each([
		"cold Start",
		"cached Start",
		"Prepare",
		"restore",
		"discovery",
	] as const)(`pin matrix: ${scenario.name} / %s`, async (entry) => {
		const settings = profile();
		settings["802-11-wireless.mac-address"] = scenario.pin;
		settings["match.path"] = scenario.port;
		settings["connection.autoconnect"] =
			scenario.armed ||
			(entry === "discovery" &&
				(scenario.name === "moved, known empty old port" ||
					scenario.name === "moved, unknown old port occupancy"))
				? "yes"
				: "no";
		settings["connection.interface-name"] = "wlan0";
		listOtherRadio(
			scenario.other,
			"otherMac" in scenario ? scenario.otherMac : OTHER,
		);
		const iface = f.row();
		if (scenario.owner === OTHER) {
			rememberHotspotCredentials(MAC, {
				ssid: "Local AP",
				password: "local-test-password",
			});
			rememberHotspotCredentials(OTHER, {
				ssid: "Policy AP",
				password: "fixture-password",
				conn: PROFILE,
			});
		}
		if (entry === "cold Start" || entry === "discovery") {
			delete iface.hotspot.conn;
			delete iface.hotspot.name;
			delete iface.hotspot.password;
		}
		const deps = {
			...liveProfileDeps,
			nmApConnAdd: async (
				_device: string,
				identity: Parameters<typeof nm.nmApConnAdd>[1],
				fields: Record<string, string>,
			) => {
				const uuid = "distinct-local-ap";
				f.profiles.set(uuid, {
					...fields,
					"802-11-wireless.ssid": identity.name,
					"802-11-wireless-security.psk": identity.password,
				});
				return uuid;
			},
		};
		if (
			scenario.name === "recorded legacy MAC" &&
			(entry === "cached Start" || entry === "restore")
		) {
			// A credential preview reads and caches the exact legacy pin without writing.
			delete iface.hotspot.conn;
			delete iface.hotspot.name;
			delete iface.hotspot.password;
			await f.sample();
			expect(
				await prepareHotspotForInterface(
					MAC,
					iface,
					{},
					{ ...f.deps, ...deps },
				),
			).toMatchObject({ success: true });
			expect(iface.hotspot).toMatchObject({ conn: PROFILE });
		}
		const before = { ...settings };
		if (entry === "discovery") {
			await f.discover();
			await wifiUpdateSavedConns();
			expect(
				Object.values(getWifiState())
					.map(({ ifname }) => ifname)
					.sort(),
			).toEqual(["wlan0", "wlan1"]);
			if (scenario.name === "recorded legacy MAC") {
				expect(profile()["802-11-wireless.mac-address"]).toBe(MAC);
				expect(profile()["802-11-wireless-security.psk"]).toBe(
					"fixture-password",
				);
			} else if (scenario.name === "moved, known empty old port") {
				expect(profile()).toEqual({
					...before,
					"connection.autoconnect": "no",
				});
			} else {
				expect(profile()).toEqual(before);
				expect(f.effects).toEqual([]);
			}
			expect(f.activations).toEqual([]);
			return;
		}
		if (entry === "Prepare") {
			await f.sample();
			expect(
				await prepareHotspotForInterface(
					MAC,
					iface,
					{ name: "New name", password: "new-passphrase" },
					{ ...f.deps, ...deps },
				),
			).toEqual({ success: false, error: "activation-failed" });
		} else if (entry === "restore") {
			f.persistMode(MAC, "hotspot");
			await f.sample();
			await f.restore(deps);
		} else {
			expect(await f.start(deps)).toEqual(
				scenario.repair || (entry === "cold Start" && scenario.owner === OTHER)
					? { success: true }
					: { success: false, error: "activation-failed" },
			);
		}
		if (scenario.repair && entry !== "Prepare" && entry !== "restore") {
			expect(profile()["802-11-wireless.mac-address"]).toBe(MAC);
			expect(profile()["match.path"]).toBe(PORT);
			expect(profile()["802-11-wireless-security.psk"]).toBe(
				"fixture-password",
			);
			expect(f.activations).toEqual([PROFILE]);
		} else {
			expect(profile()).toEqual(before);
			expect(f.effects.filter(({ uuid }) => uuid === PROFILE)).toEqual([]);
			expect(f.activations).toEqual(
				entry === "cold Start" && scenario.owner === OTHER
					? ["distinct-local-ap"]
					: [],
			);
		}
	});
}

test("discovery publishes both radios without disarming an AP pinned to the other radio's port", async () => {
	profile()["match.path"] = OLD_PORT;
	profile()["802-11-wireless.ssid"] = "policy-skip-private-ssid";
	profile()["802-11-wireless-security.psk"] = "policy-skip-private-passphrase";
	expect(profile()["connection.autoconnect"]).toBe("yes");
	listOtherRadio(OLD_PORT);
	const before = { ...profile() };
	const warn = spyOn(logger, "warn");
	const error = spyOn(logger, "error");

	for (let pass = 0; pass < 2; pass++) {
		await f.discover();
		expect(Object.keys(getWifiInterfacesByMacAddress()).sort()).toEqual(
			[MAC, OTHER].sort(),
		);
		expect(
			Object.values(getWifiState())
				.map(({ ifname }) => ifname)
				.sort(),
		).toEqual(["wlan0", "wlan1"]);
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
	}
	expect(error).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(expect.any(String), {
		code: "wifi-hotspot-policy-pin-conflict",
	});
	const messages = JSON.stringify(warn.mock.calls);
	expect(messages).not.toContain("policy-skip-private-ssid");
	expect(messages).not.toContain("policy-skip-private-passphrase");
});

test("a refused NetworkManager disarm is retried rather than reported as a safe pin skip", async () => {
	profile()["match.path"] = OLD_PORT;
	listOtherRadio("different-port");
	const write = nm.nmConnSetFields;
	const disarm = spyOn(nm, "nmConnSetFields").mockImplementation(
		async (uuid, fields, permit) =>
			fields["connection.autoconnect"] === "no"
				? false
				: write(uuid, fields, permit),
	);

	await f.discover();

	expect(disarm).toHaveBeenCalled();
	expect(profile()["connection.autoconnect"]).toBe("yes");
	expect(
		Object.values(getWifiState()).map(({ ifname }) => ifname),
	).not.toContain("wlan1");

	disarm.mockRestore();
	await f.discover();
	expect(profile()["connection.autoconnect"]).toBe("no");
	expect(
		Object.values(getWifiState())
			.map(({ ifname }) => ifname)
			.sort(),
	).toEqual(["wlan0", "wlan1"]);
});

test("bound Start treats an ambiguous old port as unknown occupancy", async () => {
	profile()["match.path"] = OLD_PORT;
	profile()["connection.autoconnect"] = "no";
	listOtherRadio(OLD_PORT);
	f.witnesses.set("wlan2", {
		ifindex: 6,
		phy: "/sys/devices/policy/phy2",
		mac: "02:00:00:00:00:33",
		path: OLD_PORT,
	});
	await f.sample();
	for (const ifname of ["wlan1", "wlan2"]) {
		expect(wifiRadioIdentity.state.rows.get(ifname)).toBeDefined();
		expect(
			wifiRadioIdentity.state.rows.get(ifname)?.devicePath,
		).toBeUndefined();
	}
	const before = { ...profile() };
	expect(await f.start(liveProfileDeps)).toEqual({
		success: false,
		error: "activation-failed",
	});
	expect(profile()).toEqual(before);
	expect(f.effects).toEqual([]);
	expect(f.activations).toEqual([]);
});

test.each(["Start", "discovery"] as const)(
	"%s does not repin a legacy MAC while another physical radio's MAC is unresolved",
	async (entry) => {
		profile()["802-11-wireless.mac-address"] = OTHER;
		profile()["connection.interface-name"] = "wlan0";
		f.witnesses.set("wlan1", {
			ifindex: 5,
			phy: "/sys/devices/policy/phy1",
			path: "different-port",
		});
		f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
		delete f.row().hotspot.conn;
		const before = { ...profile() };
		if (entry === "Start")
			expect(await f.start(liveProfileDeps)).toEqual({
				success: false,
				error: "activation-failed",
			});
		else {
			await f.discover();
			await wifiUpdateSavedConns();
			expect(
				Object.values(getWifiState())
					.map(({ ifname }) => ifname)
					.sort(),
			).toEqual(["wlan0", "wlan1"]);
		}
		expect(profile()).toEqual(before);
		expect(f.effects).toEqual([]);
		expect(f.activations).toEqual([]);
	},
);

test("(7) a confirmed hybrid start explicitly leaves autoconnect no", async () => {
	f.seed(true);
	expect(await f.start()).toEqual({ success: true });
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(
		f.effects.some((e) => e.fields["connection.autoconnect"] === "yes"),
	).toBe(false);
});

test("(8) startup leaves owned station and unowned AP profiles untouched", async () => {
	f.profiles.set("station-profile", {
		"802-11-wireless.mode": "infrastructure",
		"connection.autoconnect": "yes",
	});
	rememberHotspotCredentials("dc:a6:32:aa:bb:cc", {
		ssid: "Station",
		password: "station-password",
		conn: "station-profile",
	});
	f.profiles.set("foreign-ap", {
		"802-11-wireless.mode": "ap",
		"connection.autoconnect": "yes",
		"connection.interface-name": "clap-foreign",
	});
	const station = structuredClone(f.profiles.get("station-profile"));
	const foreign = structuredClone(f.profiles.get("foreign-ap"));
	await f.discover();
	expect(f.profiles.get("station-profile")).toEqual(station);
	expect(f.profiles.get("foreign-ap")).toEqual(foreign);
	expect(
		f.effects.filter(
			(e) => e.uuid === "station-profile" || e.uuid === "foreign-ap",
		),
	).toEqual([]);
});

test("(9) colon-bearing PCI paths keep exact bytes inside the ifindex bracket", async () => {
	await f.start();
	expect(profile()?.["match.path"]).toBe(PORT);
	const pathAt = f.reads.indexOf("path:wlan0");
	expect(pathAt).toBeGreaterThan(
		f.reads.indexOf("/sys/class/net/wlan0/ifindex"),
	);
	expect(f.reads.slice(pathAt + 1)).toContain("/sys/class/net/wlan0/ifindex");
});

test.each([
	"*",
	"?",
	"[",
	"!",
	"|",
	"&",
	"`",
	" ",
	"\t",
	"\n",
	"\r",
	"\0",
	"\x7f",
])("(10) unsafe path byte %j never arms autoconnect", async (byte) => {
	f.witnesses.set("wlan0", {
		ifindex: 3,
		phy: "/sys/devices/policy/phy0",
		mac: MAC,
		path: `usb${byte}port`,
	});
	await f.start();
	expect(profile()?.["connection.autoconnect"]).toBe("no");
	expect(profile()?.["match.path"] ?? "").toBe("");
});
