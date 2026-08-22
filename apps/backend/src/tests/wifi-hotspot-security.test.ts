/*
  The hotspot's capability-driven SECURITY offering, its READ-ONLY width truth,
  and the two Must-NOT-Haves that bound both.

  The offering is derived on exactly the terms the CHANNEL offering already is:
  the device answers with what it can honour, and anything absent from that
  answer is rejected. The evidence differs — a per-adapter capability read rather
  than the regulatory domain — so the tests below drive the REAL derivation
  against the REAL `iw phy` capture of an MT7925-class radio, which is the
  hardest adversary available: it reports Wi-Fi 7, three bands including 6 GHz,
  `apModes` covering all three, a 320 MHz width, a self-managed US domain that
  says 6 GHz is legal, AND SAE offload. Every one of those is true, and the
  hotspot offering must still contain ZERO 6 GHz entries.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WifiAdapterCapabilities } from "@ceraui/rpc/schemas";

import {
	deriveApChannels,
	offeredHotspotChannels,
} from "../modules/wifi/regdomain.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	getWifiCapabilitiesForInterface,
	refreshWifiCapabilities,
	resetWifiCapabilitiesForTest,
	setWifiCapabilityDepsForTest,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import {
	type HotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import {
	DEFAULT_HOTSPOT_SECURITY,
	getHotspotSecurityMap,
	HOTSPOT_BANDS,
	HOTSPOT_SECURITY,
	type HotspotSecurityId,
	isSecurityOffered,
	nmSettingsForSecurity,
	offeredHotspotMaxWidth,
	offeredHotspotSecurity,
	securityFromNM,
} from "../modules/wifi/wifi-hotspot-security.ts";
import {
	hotspotBindingFields,
	type WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "wifi");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** A Wi-Fi 7 / 6E radio: three bands, 320 MHz, SAE offload, 6 GHz legal. */
const IW_PHY_MT7925 = fixture("iw-phy-mt7925-eht.txt");
const IW_REG_SELF_MANAGED = fixture("iw-reg-get-self-managed.txt");
const IW_DEV_MT7925 = `phy#0\n\tInterface wlan0\n\t\tifindex 3\n\t\ttype managed\n`;

const MAC = "58:02:05:e1:79:1c";

function caps(
	over: Partial<WifiAdapterCapabilities> = {},
): WifiAdapterCapabilities {
	return {
		phy: "phy0",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "unknown",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
		...over,
	};
}

function hotspotIface(
	over: Partial<WifiInterfaceWithHotspot["hotspot"]> = {},
): WifiInterfaceWithHotspot {
	return {
		id: 0,
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "MediaTek MT7925",
		available: new Map(),
		saved: {},
		hotspot: {
			conn: "hotspot-uuid",
			name: "CERALIVE_791c",
			password: "correcthorse",
			channel: "auto",
			availableChannels: ["auto", "auto_24", "auto_50"],
			warnings: {},
			...over,
		},
	};
}

type Recorder = {
	deps: HotspotConfigDeps;
	setFields: Array<[string, Record<string, string>]>;
	connected: string[];
};

function makeConfigDeps(
	capabilities: WifiAdapterCapabilities | undefined,
	over: Partial<HotspotConfigDeps> = {},
): Recorder {
	const setFields: Recorder["setFields"] = [];
	const connected: string[] = [];
	const deps: HotspotConfigDeps = {
		nmConnSetFields: async (uuid, fields) => {
			setFields.push([uuid, fields]);
			return true;
		},
		nmConnect: async (uuid) => {
			connected.push(uuid);
			return true;
		},
		wifiUpdateSavedConns: async () => {},
		broadcastState: () => {},
		rememberCredentials: () => {},
		getCapabilities: () => capabilities,
		...over,
	};
	return { deps, setFields, connected };
}

function fakeSocket() {
	const sent: string[] = [];
	return {
		sent,
		socket: { send: (message: string) => sent.push(message) },
		errors: () =>
			sent
				.map((raw) => JSON.parse(raw))
				.map((frame) => frame?.wifi?.hotspot?.config)
				.filter((config) => config !== undefined),
	};
}

/*
  `bun test` runs every file in ONE process, so the interface registry, the
  id→MAC map and the capability cache are process-wide. Leaving an entry behind
  puts a hotspot adapter into every LATER file's `status` snapshot, which is a
  failure with no relationship to whatever that file is testing — so this file
  tears its own state down as well as setting it up.
*/
function resetWifiGlobals(): void {
	setWifiState({});
	onWifiChange(() => {});
	for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
		removeWifiInterface(mac);
	}
	const idToMac = getWifiIdToMacAddress();
	for (const id of Object.keys(idToMac)) delete idToMac[Number(id)];
	resetWifiCapabilitiesForTest();
}

beforeEach(resetWifiGlobals);
afterEach(resetWifiGlobals);

// ─── 1. the derivation: WPA3 only on PROVEN SAE ──────────────────────────────

describe("offeredHotspotSecurity — proof, never assumption", () => {
	test("WPA2 is offered to every adapter, including one that proved nothing", () => {
		expect(offeredHotspotSecurity(undefined)).toEqual(["wpa2"]);
		expect(DEFAULT_HOTSPOT_SECURITY).toBe("wpa2");
	});

	test("WPA3-SAE is offered ONLY on a `supported` tri-state", () => {
		expect(offeredHotspotSecurity(caps({ wpa3Sae: "supported" }))).toEqual([
			"wpa2",
			"wpa3-sae",
		]);
		// `unknown` is the shipped fleet's answer — NM 1.42.4 publishes no SAE key
		// at all — so treating it as a yes would offer WPA3 on unproven hardware.
		expect(offeredHotspotSecurity(caps({ wpa3Sae: "unknown" }))).toEqual([
			"wpa2",
		]);
		expect(offeredHotspotSecurity(caps({ wpa3Sae: "unsupported" }))).toEqual([
			"wpa2",
		]);
	});

	test("the offered set is the acceptance oracle, exactly like channels", () => {
		const offered = offeredHotspotSecurity(caps({ wpa3Sae: "unknown" }));

		expect(isSecurityOffered("wpa2", offered)).toBe(true);
		expect(isSecurityOffered("wpa3-sae", offered)).toBe(false);
		expect(isSecurityOffered("open", offered)).toBe(false);
		// An unoffered mode has no NetworkManager mapping BY CONSTRUCTION.
		expect(nmSettingsForSecurity("wpa3-sae", offered)).toBeUndefined();
	});
});

// ─── 2. no mixed mode, structurally ──────────────────────────────────────────

describe("wpa2-wpa3-mixed is unrepresentable", () => {
	test("the security table holds exactly the two proven modes", () => {
		expect(Object.keys(HOTSPOT_SECURITY).sort()).toEqual(["wpa2", "wpa3-sae"]);
	});

	test("no derivation, mapping, or NM read can produce a mixed mode", () => {
		const everything = offeredHotspotSecurity(
			caps({ wpa3Sae: "supported", generation: "wifi7" }),
		);
		for (const mode of everything) {
			expect(mode).not.toContain("mixed");
		}
		expect(isSecurityOffered("wpa2-wpa3-mixed", everything)).toBe(false);
		expect(
			nmSettingsForSecurity("wpa2-wpa3-mixed", everything),
		).toBeUndefined();
		// NM's transition-mode spelling adopts nothing.
		expect(securityFromNM("sae wpa-psk")).toBeUndefined();
	});
});

// ─── 3. 2.4/5 GHz ONLY — the hard Must-NOT-Have ──────────────────────────────

describe("a 6E / Wi-Fi 7 adapter is STILL offered zero 6 GHz entries", () => {
	test("the hotspot band set is 2.4/5 and nothing else", () => {
		expect([...HOTSPOT_BANDS]).toEqual(["2.4", "5"]);
	});

	test("max_width_mhz drops the 6 GHz band the radio really does carry", async () => {
		setWifiCapabilityDepsForTest({
			runIw: async (args) => {
				if (args[0] === "phy") return IW_PHY_MT7925;
				if (args[0] === "reg") return IW_REG_SELF_MANAGED;
				if (args[0] === "dev") return IW_DEV_MT7925;
				throw new Error(`unexpected iw invocation: ${args.join(" ")}`);
			},
			readPhyName: async () => "phy0",
			pathExists: async (path) => path === "/usr/sbin/wpa_supplicant",
			readNmcliWifiProperties: async () => undefined,
			now: () => 1_000,
		});
		await refreshWifiCapabilities(["wlan0"]);

		const capability = getWifiCapabilitiesForInterface("wlan0");
		// Non-vacuity: the radio genuinely reports 6 GHz at 320 MHz.
		expect(capability?.bands).toEqual(["2.4", "5", "6"]);
		expect(capability?.apModes).toContain("6");
		expect(capability?.maxWidthMhz["6"]).toBe(320);
		expect(capability?.regulatory.is6GhzLegal).toBe(true);

		const widths = offeredHotspotMaxWidth(capability);
		expect(widths).toEqual({ "2.4": 40, "5": 160 });
		expect("6" in widths).toBe(false);
	});

	test("a band the radio does not carry is OMITTED, never zero-filled", () => {
		const twoFourOnly = caps({ bands: ["2.4"], maxWidthMhz: { "2.4": 40 } });
		expect(offeredHotspotMaxWidth(twoFourOnly)).toEqual({ "2.4": 40 });
		expect(offeredHotspotMaxWidth(undefined)).toEqual({});
	});

	test("the channel derivation drops every 6 GHz frequency the dump lists", () => {
		const derived = deriveApChannels(IW_PHY_MT7925);
		// Non-vacuity: the dump really does enumerate 6 GHz frequencies.
		expect(IW_PHY_MT7925).toContain("Band 4:");
		expect(derived.length).toBeGreaterThan(0);
		for (const channel of derived) {
			expect(channel.freqMhz).toBeLessThan(5925);
			expect(["bg", "a"]).toContain(channel.band);
		}

		const offered = offeredHotspotChannels(
			["auto", "auto_24", "auto_50"],
			derived,
		);
		const sixGhzChannels = derived.filter((c) => c.freqMhz >= 5925);
		expect(sixGhzChannels).toHaveLength(0);
		expect(offered).toContain("auto");
	});

	test("the SERIALIZED hotspot wire block carries no 6 GHz anything", async () => {
		setWifiCapabilityDepsForTest({
			runIw: async (args) => {
				if (args[0] === "phy") return IW_PHY_MT7925;
				if (args[0] === "reg") return IW_REG_SELF_MANAGED;
				if (args[0] === "dev") return IW_DEV_MT7925;
				throw new Error(`unexpected iw invocation: ${args.join(" ")}`);
			},
			readPhyName: async () => "phy0",
			pathExists: async (path) => path === "/usr/sbin/wpa_supplicant",
			readNmcliWifiProperties: async () => undefined,
			now: () => 1_000,
		});
		await refreshWifiCapabilities(["wlan0"]);

		const derived = deriveApChannels(IW_PHY_MT7925);
		const iface = hotspotIface({
			availableChannels: offeredHotspotChannels(
				["auto", "auto_24", "auto_50"],
				derived,
			),
			derivedChannels: derived,
		});
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;

		const hotspot = wifiBuildMsg()[0]?.hotspot;
		expect(hotspot).toBeDefined();
		// Non-vacuity: concrete channels really are on the wire.
		const channelIds = Object.keys(hotspot?.available_channels ?? {});
		expect(
			channelIds.filter((id) => id.startsWith("ch_")).length,
		).toBeGreaterThan(0);

		// The adapter PROVED SAE, so WPA3 is offered — and 6 GHz still is not.
		expect(Object.keys(hotspot?.available_security ?? {}).sort()).toEqual([
			"wpa2",
			"wpa3-sae",
		]);
		expect(hotspot?.max_width_mhz).toEqual({ "2.4": 40, "5": 160 });

		// Every offered channel maps to a 2.4/5 GHz NetworkManager band, so none of
		// them can be a 6 GHz channel wearing a re-used IEEE number.
		for (const channel of iface.hotspot.derivedChannels ?? []) {
			expect(channel.freqMhz).toBeLessThan(5925);
		}
		const wire = JSON.stringify(hotspot);
		expect(wire).not.toContain('"6"');
		expect(wire).not.toContain("320");
	});
});

// ─── 4. the NetworkManager field set ─────────────────────────────────────────

describe("nmcli field set", () => {
	test("WPA2 keeps the field set the shipped hotspot already had", () => {
		expect(hotspotBindingFields(MAC)).toEqual({
			"connection.interface-name": "",
			"802-11-wireless.mac-address": MAC,
			"802-11-wireless-security.key-mgmt": "wpa-psk",
			"802-11-wireless-security.pmf": "disable",
		});
	});

	test("WPA3-SAE moves key-mgmt AND pmf together", () => {
		const offered: HotspotSecurityId[] = ["wpa2", "wpa3-sae"];
		expect(nmSettingsForSecurity("wpa3-sae", offered)).toEqual({
			"802-11-wireless-security.key-mgmt": "sae",
			"802-11-wireless-security.pmf": "required",
		});
		// SAE forbids pmf `disable`, so the per-start binding must follow the mode.
		expect(hotspotBindingFields(MAC, "wpa3-sae")).toMatchObject({
			"802-11-wireless-security.key-mgmt": "sae",
			"802-11-wireless-security.pmf": "required",
		});
	});

	test("a profile's own key-mgmt is what names its mode on read-back", () => {
		expect(securityFromNM("wpa-psk")).toBe("wpa2");
		expect(securityFromNM("sae")).toBe("wpa3-sae");
		expect(securityFromNM("wpa-eap")).toBeUndefined();
	});

	test("the offered map is rendered with operator-facing names", () => {
		expect(getHotspotSecurityMap(["wpa2", "wpa3-sae"])).toEqual({
			wpa2: { name: HOTSPOT_SECURITY.wpa2.name },
			"wpa3-sae": { name: HOTSPOT_SECURITY["wpa3-sae"].name },
		});
	});
});

// ─── 5. configure: the offered map is the acceptance oracle ──────────────────

describe("wifiHotspotConfig — security acceptance", () => {
	test("an out-of-map security is REJECTED and nothing is written", async () => {
		const iface = hotspotIface();
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;

		// This adapter never proved SAE, so WPA3 is not in its offering.
		const rec = makeConfigDeps(caps({ wpa3Sae: "unknown" }));
		const sock = fakeSocket();

		await wifiHotspotConfig(
			sock.socket,
			{
				device: 0,
				name: "CERALIVE_791c",
				password: "correcthorse",
				channel: "auto",
				security: "wpa3-sae",
			},
			rec.deps,
		);

		expect(sock.errors()).toEqual([{ device: 0, error: "security" }]);
		expect(rec.setFields).toHaveLength(0);
		expect(rec.connected).toHaveLength(0);
		expect(iface.hotspot.security).toBeUndefined();
	});

	test("a well-formed but unknown security token is rejected the same way", async () => {
		addWifiInterface(MAC, hotspotIface());
		getWifiIdToMacAddress()[0] = MAC;

		const rec = makeConfigDeps(caps({ wpa3Sae: "supported" }));
		const sock = fakeSocket();

		await wifiHotspotConfig(
			sock.socket,
			{
				device: 0,
				name: "CERALIVE_791c",
				password: "correcthorse",
				channel: "auto",
				security: "wpa2-wpa3-mixed",
			},
			rec.deps,
		);

		expect(sock.errors()).toEqual([{ device: 0, error: "security" }]);
		expect(rec.setFields).toHaveLength(0);
	});

	test("a PROVEN WPA3 selection writes `wifi-sec.key-mgmt sae` and is retained", async () => {
		const iface = hotspotIface();
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;

		const rec = makeConfigDeps(caps({ wpa3Sae: "supported" }));
		const sock = fakeSocket();

		await wifiHotspotConfig(
			sock.socket,
			{
				device: 0,
				name: "CERALIVE_791c",
				password: "correcthorse",
				channel: "auto",
				security: "wpa3-sae",
			},
			rec.deps,
		);

		expect(sock.errors()).toEqual([{ device: 0, success: true }]);
		expect(rec.setFields).toHaveLength(1);
		expect(rec.setFields[0]?.[0]).toBe("hotspot-uuid");
		expect(rec.setFields[0]?.[1]).toMatchObject({
			"802-11-wireless.ssid": "CERALIVE_791c",
			"802-11-wireless-security.psk": "correcthorse",
			"802-11-wireless-security.key-mgmt": "sae",
			"802-11-wireless-security.pmf": "required",
		});
		expect(iface.hotspot.security).toBe("wpa3-sae");
	});

	test("an omitted security leaves the current selection alone", async () => {
		const iface = hotspotIface({ security: "wpa3-sae" });
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;

		const rec = makeConfigDeps(caps({ wpa3Sae: "supported" }));
		const sock = fakeSocket();

		await wifiHotspotConfig(
			sock.socket,
			{
				device: 0,
				name: "CERALIVE_791c",
				password: "newpassword",
				channel: "auto",
			},
			rec.deps,
		);

		expect(sock.errors()).toEqual([{ device: 0, success: true }]);
		expect(rec.setFields[0]?.[1]).toMatchObject({
			"802-11-wireless-security.key-mgmt": "sae",
		});
		expect(iface.hotspot.security).toBe("wpa3-sae");
	});

	test("an adapter that proved nothing still configures WPA2 unchanged", async () => {
		const iface = hotspotIface();
		addWifiInterface(MAC, iface);
		getWifiIdToMacAddress()[0] = MAC;

		const rec = makeConfigDeps(undefined);
		const sock = fakeSocket();

		await wifiHotspotConfig(
			sock.socket,
			{
				device: 0,
				name: "CERALIVE_791c",
				password: "correcthorse",
				channel: "auto",
				security: "wpa2",
			},
			rec.deps,
		);

		expect(sock.errors()).toEqual([{ device: 0, success: true }]);
		expect(rec.setFields[0]?.[1]).toMatchObject({
			"802-11-wireless-security.key-mgmt": "wpa-psk",
			"802-11-wireless-security.pmf": "disable",
		});
	});
});
