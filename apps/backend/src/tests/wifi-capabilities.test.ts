/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
  Per-adapter Wi-Fi capability truth (dynamic-wifi-bt-foundation todo 2).

  Every expectation is driven by an `iw` transcript in `fixtures/wifi/`. Two of
  them are VERBATIM board captures rather than hand-written shapes:

    - `iw-phy-rock5bplus-rtl8852be.txt` / `iw-reg-get-rock5bplus.txt` /
      `iw-dev-rock5bplus.txt` — Rock 5B+ (192.168.78.132), kernel
      7.1.7-ceralive-rk3588, RTL8852BE, captured 2026-08-21.
    - the no-Wi-Fi board case is the Orange Pi 5 Plus (192.168.78.151), whose
      `iw phy` and `iw dev` are BOTH empty and which carries no
      phy80211 link under /sys/class/net at all.

  NOTHING here executes `iw`, `nmcli` or touches /sys — every effectful path is
  injected, so a test run can never read or move the host's own radios.
*/

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { wifiInterfaceSchema } from "@ceraui/rpc/schemas";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	getWifiCapabilitiesForInterface,
	nmcliSaeClaim,
	parseInterfaceCombination,
	parseIwDevPhyMap,
	parseIwPhyCapabilities,
	parseIwRegDomains,
	parseNmcliWifiProperties,
	refreshWifiCapabilities,
	resetWifiCapabilitiesForTest,
	resolveWpa3Sae,
	setWifiCapabilityDepsForTest,
	WIFI_CAPABILITIES_TTL_MS,
	type WifiCapabilityDeps,
} from "../modules/wifi/wifi-capabilities.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "wifi");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const IW_PHY_ROCK = fixture("iw-phy-rock5bplus-rtl8852be.txt");
const IW_REG_ROCK = fixture("iw-reg-get-rock5bplus.txt");
const IW_DEV_ROCK = fixture("iw-dev-rock5bplus.txt");
const IW_PHY_MT7925 = fixture("iw-phy-mt7925-eht.txt");
const IW_REG_SELF_MANAGED = fixture("iw-reg-get-self-managed.txt");
const IW_PHY_DUAL = fixture("iw-phy-dual-wiphy.txt");
const IW_REG_DUAL = fixture("iw-reg-get-dual-wiphy.txt");
const IW_DEV_DUAL = fixture("iw-dev-dual-wiphy-virtual-ap.txt");
const IW_PHY_TRUNCATED = fixture("iw-phy-truncated.txt");

const IW_DEV_MT7925 = `phy#0\n\tInterface wlan0\n\t\tifindex 3\n\t\ttype managed\n`;

type IwAnswers = { phy: string; reg: string; dev: string };

let iwCalls: string[][] = [];

function installDeps(
	answers: IwAnswers,
	links: Record<string, string>,
	overrides: Partial<WifiCapabilityDeps> = {},
): void {
	iwCalls = [];
	setWifiCapabilityDepsForTest({
		runIw: async (args) => {
			iwCalls.push(args);
			if (args[0] === "phy") return answers.phy;
			if (args[0] === "reg") return answers.reg;
			if (args[0] === "dev") return answers.dev;
			throw new Error(`unexpected iw invocation: ${args.join(" ")}`);
		},
		readPhyName: async (ifname) => links[ifname],
		pathExists: async (path) => path === "/usr/sbin/wpa_supplicant",
		readNmcliWifiProperties: async () => undefined,
		now: () => 1_000,
		...overrides,
	});
}

function clearWifiInterfaces(): void {
	for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
		removeWifiInterface(mac);
	}
}

function stationInterface(id: number, ifname: string): WifiInterface {
	return {
		id,
		ifname,
		conn: null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
}

beforeEach(() => {
	resetWifiCapabilitiesForTest();
	clearWifiInterfaces();
});

// ─── (a) the shipped board: a REAL RTL8852BE capture ─────────────────────────

describe("Rock 5B+ RTL8852BE — the shipped adapter, read verbatim", () => {
	test("parses into the exact capability set the kernel described", async () => {
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);

		await refreshWifiCapabilities(["wlan0"]);

		expect(getWifiCapabilitiesForInterface("wlan0")).toEqual({
			phy: "phy0",
			// HE on both bands and NO Band 4 ⇒ Wi-Fi 6, never 6E.
			generation: "wifi6",
			bands: ["2.4", "5"],
			// VHT says "neither 160 nor 80+80" and HE says HE40/HE80 — 80 MHz is the
			// widest thing this radio actually claimed on 5 GHz.
			maxWidthMhz: { "2.4": 40, "5": 80 },
			apModes: ["2.4", "5"],
			staApCombo: { supported: true, sameChannelOnly: true },
			// `Device supports SAE with AUTHENTICATE command` + wpa_supplicant on
			// the image. NM 1.42.4 publishes no SAE key at all, so it abstains.
			wpa3Sae: "supported",
			regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
		});
	});

	test("the EHT structures it prints are an all-zero KERNEL STUB, not Wi-Fi 7", () => {
		// Non-vacuity: the dump really does carry EHT blocks. If a future parser
		// keyed generation on their PRESENCE this radio would claim Wi-Fi 7.
		expect(IW_PHY_ROCK).toContain("EHT MAC Capabilities (0x0000)");
		expect(IW_PHY_ROCK).toContain("EHT PHY Capabilities: (0x0000000000000000)");

		const parsed = parseIwPhyCapabilities(IW_PHY_ROCK);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.get("phy0")?.generation).toBe("wifi6");
	});

	test("its 60 GHz regulatory rule is NOT read as 6 GHz legality", () => {
		expect(IW_REG_ROCK).toContain("(57240 - 63720 @ 2160)");

		const parsed = parseIwRegDomains(IW_REG_ROCK);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.global).toEqual({
			country: "00",
			selfManaged: false,
			is6GhzLegal: false,
		});
	});
});

// ─── (b) a Wi-Fi 7 radio: MT7925-class, EHT + 6 GHz + self-managed ───────────

describe("MT7925-class EHT radio — generation, 320 MHz and a self-managed domain", () => {
	test("parses into the exact capability set, with the OBSERVED per-phy domain", async () => {
		installDeps(
			{
				phy: IW_PHY_MT7925,
				reg: IW_REG_SELF_MANAGED,
				dev: IW_DEV_MT7925,
			},
			{ wlan0: "phy0" },
		);

		await refreshWifiCapabilities(["wlan0"]);

		expect(getWifiCapabilitiesForInterface("wlan0")).toEqual({
			phy: "phy0",
			generation: "wifi7",
			bands: ["2.4", "5", "6"],
			maxWidthMhz: { "2.4": 40, "5": 160, "6": 320 },
			apModes: ["2.4", "5", "6"],
			// `#{managed} <= 2, #{AP} <= 1, total <= 4, #channels <= 2`
			staApCombo: { supported: true, sameChannelOnly: false },
			// No `AUTHENTICATE` line here — the SAE_OFFLOAD extended feature is the
			// full-MAC spelling of the same claim.
			wpa3Sae: "supported",
			// The device applied nothing: `global` still reads world `00` with no
			// 6 GHz rule, and only the per-phy section says US + 5945-7125.
			regulatory: { country: "US", is6GhzLegal: true, self_managed: true },
		});
	});

	test("a self-managed wiphy's domain OUTRANKS the global one", () => {
		const parsed = parseIwRegDomains(IW_REG_SELF_MANAGED);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		expect(parsed.value.global?.country).toBe("00");
		expect(parsed.value.global?.is6GhzLegal).toBe(false);
		expect(parsed.value.byWiphyIndex.get(0)).toEqual({
			country: "US",
			selfManaged: true,
			is6GhzLegal: true,
		});
	});

	test("`self_managed` is an EXPLICIT false when it is false", async () => {
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);

		const regulatory = getWifiCapabilitiesForInterface("wlan0")?.regulatory;
		expect(regulatory).toBeDefined();
		expect(Object.hasOwn(regulatory ?? {}, "self_managed")).toBe(true);
		expect(regulatory?.self_managed).toBe(false);
	});
});

// ─── (c) a board with NO Wi-Fi hardware at all ───────────────────────────────

describe("a board with no wiphy — the Orange Pi 5 Plus answer", () => {
	test("empty `iw phy` is a SUCCESS, not drift", () => {
		const parsed = parseIwPhyCapabilities("");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.size).toBe(0);
	});

	test("no adapters ⇒ nothing cached, nothing spawned, no capabilities", async () => {
		installDeps({ phy: "", reg: IW_REG_ROCK, dev: "" }, {});

		await refreshWifiCapabilities([]);

		expect(iwCalls).toEqual([]);
		expect(getWifiCapabilitiesForInterface("wlan0")).toBeUndefined();
	});

	test("an empty `iw dev` is likewise a success with an empty map", () => {
		const parsed = parseIwDevPhyMap("");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.size).toBe(0);
	});
});

// ─── (d) DUAL WIPHY + a virtual AP interface ─────────────────────────────────

describe("dual wiphy with a virtual AP — capabilities can never cross-assign", () => {
	const links = { wlan0: "phy0", wlan1: "phy1", ap0: "phy1" };
	// Only the MediaTek half (phy1) is firmware-regulated; the Realtek half falls
	// back to the global domain. Two radios, two DIFFERENT effective domains, on
	// one board — which is the whole reason regulatory is resolved per wiphy.
	const answers = {
		phy: IW_PHY_DUAL,
		reg: IW_REG_DUAL,
		dev: IW_DEV_DUAL,
	};

	test("each interface gets ITS OWN radio's capability set", async () => {
		installDeps(answers, links);
		await refreshWifiCapabilities(["wlan0", "wlan1", "ap0"]);

		const wlan0 = getWifiCapabilitiesForInterface("wlan0");
		const wlan1 = getWifiCapabilitiesForInterface("wlan1");
		const ap0 = getWifiCapabilitiesForInterface("ap0");

		expect(wlan0?.phy).toBe("phy0");
		expect(wlan0?.generation).toBe("wifi6");
		expect(wlan0?.bands).toEqual(["2.4", "5"]);

		expect(wlan1?.phy).toBe("phy1");
		expect(wlan1?.generation).toBe("wifi7");
		expect(wlan1?.bands).toEqual(["2.4", "5", "6"]);

		// The virtual AP shares wlan1's RADIO, so it shares its capabilities —
		// and must never inherit the other radio's.
		expect(ap0).toEqual(wlan1);
		expect(ap0?.phy).not.toBe("phy0");
	});

	test("the two radios really do differ — the assertion above is not vacuous", async () => {
		installDeps(answers, links);
		await refreshWifiCapabilities(["wlan0", "wlan1", "ap0"]);

		const wlan0 = getWifiCapabilitiesForInterface("wlan0");
		const wlan1 = getWifiCapabilitiesForInterface("wlan1");
		expect(wlan0).not.toEqual(wlan1);
		expect(wlan0?.regulatory).toEqual({
			country: "00",
			is6GhzLegal: false,
			self_managed: false,
		});
		expect(wlan1?.regulatory).toEqual({
			country: "US",
			is6GhzLegal: true,
			self_managed: true,
		});
	});

	test("`iw dev` ORDER cannot decide the binding — sysfs does", async () => {
		// The dump lists phy#1 FIRST. A positional reading would hand wlan0 the
		// Wi-Fi 7 radio.
		expect(IW_DEV_DUAL.indexOf("phy#1")).toBeLessThan(
			IW_DEV_DUAL.indexOf("phy#0"),
		);

		installDeps(answers, links);
		await refreshWifiCapabilities(["wlan0", "wlan1", "ap0"]);
		expect(getWifiCapabilitiesForInterface("wlan0")?.generation).toBe("wifi6");
	});

	test("a sysfs link that DISAGREES with `iw dev` resolves to sysfs", async () => {
		installDeps(answers, { ...links, wlan0: "phy1" });
		await refreshWifiCapabilities(["wlan0"]);
		expect(getWifiCapabilitiesForInterface("wlan0")?.phy).toBe("phy1");
	});

	test("an interface with no sysfs link falls back to `iw dev`", async () => {
		installDeps(answers, {});
		await refreshWifiCapabilities(["wlan0", "wlan1", "ap0"]);
		expect(getWifiCapabilitiesForInterface("ap0")?.phy).toBe("phy1");
	});

	test("`iw dev` maps every interface, virtual AP included", () => {
		const parsed = parseIwDevPhyMap(IW_DEV_DUAL);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect([...parsed.value.entries()].sort()).toEqual([
			["ap0", "phy1"],
			["wlan0", "phy0"],
			["wlan1", "phy1"],
		]);
	});
});

// ─── malformed input: a named parse error, never a partial object (S2) ───────

describe("drifted CLI output fails LOUD", () => {
	test("a truncated `iw phy` yields a named parse error", () => {
		const parsed = parseIwPhyCapabilities(IW_PHY_TRUNCATED);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.kind).toBe("parse-error");
		expect(parsed.parser).toBe("parseIwPhyCapabilities");
		expect(parsed.reason).toContain("phy0");
	});

	test("a dump with no `Wiphy` header at all is drift, not an empty board", () => {
		const parsed = parseIwPhyCapabilities("nl80211 not found.\n");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseIwPhyCapabilities");
	});

	test("a band block with no frequencies is drift", () => {
		const dump = [
			"Wiphy phy0",
			"\twiphy index: 0",
			"\tSupported interface modes:",
			"\t\t * managed",
			"\tBand 1:",
			"\t\tCapabilities: 0x19ef",
			"\t\t\tHT20/HT40",
			"",
		].join("\n");
		const parsed = parseIwPhyCapabilities(dump);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.reason).toContain("frequency");
	});

	test("a regulatory dump with no country line is drift", () => {
		const parsed = parseIwRegDomains("global\n\tsomething else entirely\n");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseIwRegDomains");
	});

	test("an `iw dev` dump with no phy section is drift", () => {
		const parsed = parseIwDevPhyMap("command failed: No such device (-19)\n");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseIwDevPhyMap");
	});

	test("nmcli output with no KEY:VALUE line is drift", () => {
		const parsed = parseNmcliWifiProperties("Error: Device 'wlan9' not found.");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseNmcliWifiProperties");
	});
});

// ─── the wire: getStatus carries the truth, and OMITS it on drift ────────────

describe("wifi.getStatus — the capability block on the wire", () => {
	test("a healthy read rides the wire and validates against the schema", async () => {
		addWifiInterface("aa:bb:cc:dd:ee:ff", stationInterface(0, "wlan0"));
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);

		const entry = wifiBuildMsg()["0"];
		expect(entry).toBeDefined();
		expect(entry?.capabilities?.generation).toBe("wifi6");
		expect(wifiInterfaceSchema.safeParse(entry).success).toBe(true);
	});

	test("it is emitted on EVERY tick once computed, not only on change", async () => {
		addWifiInterface("aa:bb:cc:dd:ee:ff", stationInterface(0, "wlan0"));
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);

		const first = wifiBuildMsg()["0"]?.capabilities;
		const second = wifiBuildMsg()["0"]?.capabilities;
		expect(first).toBeDefined();
		expect(second).toEqual(first);
	});

	// The QA failure control: a malformed dump must not put a half-read object on
	// the wire, and must not take the broadcast loop down with it.
	test("a malformed dump OMITS capabilities and never throws", async () => {
		addWifiInterface("aa:bb:cc:dd:ee:ff", stationInterface(0, "wlan0"));
		installDeps(
			{ phy: IW_PHY_TRUNCATED, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);

		await expect(refreshWifiCapabilities(["wlan0"])).resolves.toBeUndefined();

		const entry = wifiBuildMsg()["0"];
		expect(entry).toBeDefined();
		expect(entry?.capabilities).toBeUndefined();
		expect(Object.hasOwn(entry ?? {}, "capabilities")).toBe(false);
		expect(wifiInterfaceSchema.safeParse(entry).success).toBe(true);
	});

	test("drift DROPS a previously-good answer rather than serving a stale claim", async () => {
		addWifiInterface("aa:bb:cc:dd:ee:ff", stationInterface(0, "wlan0"));
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);
		expect(wifiBuildMsg()["0"]?.capabilities).toBeDefined();

		installDeps(
			{ phy: IW_PHY_TRUNCATED, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"], { force: true });
		expect(wifiBuildMsg()["0"]?.capabilities).toBeUndefined();
	});

	test("a SPAWN failure RETAINS the last derivation — the hardware did not change", async () => {
		addWifiInterface("aa:bb:cc:dd:ee:ff", stationInterface(0, "wlan0"));
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);

		setWifiCapabilityDepsForTest({
			runIw: async () => {
				throw new Error("iw: command not found");
			},
			readPhyName: async () => "phy0",
			pathExists: async () => true,
			readNmcliWifiProperties: async () => undefined,
			now: () => 1_000,
		});
		await refreshWifiCapabilities(["wlan0"], { force: true });

		expect(wifiBuildMsg()["0"]?.capabilities?.generation).toBe("wifi6");
	});
});

// ─── caching, invalidation and the read-after-write bound ────────────────────

describe("cache invalidation", () => {
	test("an unchanged adapter set inside the TTL spawns nothing further", async () => {
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
		);
		await refreshWifiCapabilities(["wlan0"]);
		const afterFirst = iwCalls.length;

		await refreshWifiCapabilities(["wlan0"]);
		expect(iwCalls.length).toBe(afterFirst);
	});

	test("an ADAPTER-SET change re-reads", async () => {
		installDeps(
			{ phy: IW_PHY_DUAL, reg: IW_REG_DUAL, dev: IW_DEV_DUAL },
			{ wlan0: "phy0", wlan1: "phy1" },
		);
		await refreshWifiCapabilities(["wlan0"]);
		const afterFirst = iwCalls.length;

		await refreshWifiCapabilities(["wlan0", "wlan1"]);
		expect(iwCalls.length).toBeGreaterThan(afterFirst);
		expect(getWifiCapabilitiesForInterface("wlan1")?.phy).toBe("phy1");
	});

	test("a COUNTRY change re-reads, and reports the domain OBSERVED afterwards", async () => {
		const applied = IW_REG_ROCK.replace("country 00:", "country ES:");
		let reg = IW_REG_ROCK;
		installDeps(
			{ phy: IW_PHY_ROCK, reg: IW_REG_ROCK, dev: IW_DEV_ROCK },
			{ wlan0: "phy0" },
			{
				runIw: async (args) => {
					iwCalls.push(args);
					if (args[0] === "phy") return IW_PHY_ROCK;
					if (args[0] === "reg") return reg;
					return IW_DEV_ROCK;
				},
			},
		);
		await refreshWifiCapabilities(["wlan0"]);
		expect(getWifiCapabilitiesForInterface("wlan0")?.regulatory.country).toBe(
			"00",
		);

		reg = applied;
		await refreshWifiCapabilities(["wlan0"], { force: true });
		expect(getWifiCapabilitiesForInterface("wlan0")?.regulatory.country).toBe(
			"ES",
		);
	});

	test("a self-managed wiphy that MOVED is picked up on the bounded TTL", async () => {
		let reg = IW_REG_SELF_MANAGED;
		let clock = 1_000;
		installDeps(
			{ phy: IW_PHY_MT7925, reg: IW_REG_SELF_MANAGED, dev: IW_DEV_MT7925 },
			{ wlan0: "phy0" },
			{
				runIw: async (args) => {
					iwCalls.push(args);
					if (args[0] === "phy") return IW_PHY_MT7925;
					if (args[0] === "reg") return reg;
					return IW_DEV_MT7925;
				},
				now: () => clock,
			},
		);
		await refreshWifiCapabilities(["wlan0"]);
		expect(getWifiCapabilitiesForInterface("wlan0")?.regulatory.country).toBe(
			"US",
		);

		// The firmware moved the radio with no user action at all.
		reg = IW_REG_SELF_MANAGED.replace(
			"country US: DFS-FCC",
			"country JP: DFS-JP",
		);
		clock += WIFI_CAPABILITIES_TTL_MS;
		await refreshWifiCapabilities(["wlan0"]);
		expect(getWifiCapabilitiesForInterface("wlan0")?.regulatory.country).toBe(
			"JP",
		);
	});
});

// ─── the pure sub-rules ──────────────────────────────────────────────────────

describe("interface combinations", () => {
	test("the board's own combination allows STA+AP on ONE channel", () => {
		expect(
			parseInterfaceCombination(
				"* #{ managed } <= 1, #{ AP, P2P-client, P2P-GO } <= 1, total <= 2, #channels <= 1",
			),
		).toEqual({ supported: true, sameChannelOnly: true });
	});

	test("`#channels <= 2` is genuine multi-channel concurrency", () => {
		expect(
			parseInterfaceCombination(
				"* #{ managed } <= 2, #{ AP } <= 1, total <= 4, #channels <= 2",
			),
		).toEqual({ supported: true, sameChannelOnly: false });
	});

	test("ONE group holding both is a CHOICE, not concurrency", () => {
		expect(
			parseInterfaceCombination(
				"* #{ managed, AP } <= 1, total <= 1, #channels <= 1",
			),
		).toEqual({ supported: false, sameChannelOnly: true });
	});

	test("a total that cannot hold both refuses", () => {
		expect(
			parseInterfaceCombination(
				"* #{ managed } <= 1, #{ AP } <= 1, total <= 1, #channels <= 1",
			),
		).toEqual({ supported: false, sameChannelOnly: true });
	});

	test("no combinations section at all refuses", () => {
		expect(parseInterfaceCombination("")).toEqual({
			supported: false,
			sameChannelOnly: true,
		});
	});
});

describe("WPA3-SAE is a tri-state and never a guess", () => {
	test("driver SAE + a supplicant is the only positive from `iw` alone", () => {
		expect(
			resolveWpa3Sae({
				driverAdvertisesSae: true,
				supplicantPresent: true,
				nmcliSae: undefined,
			}),
		).toBe("supported");
	});

	test("a driver that advertises nothing is UNKNOWN, never unsupported", () => {
		expect(
			resolveWpa3Sae({
				driverAdvertisesSae: false,
				supplicantPresent: true,
				nmcliSae: undefined,
			}),
		).toBe("unknown");
	});

	test("no supplicant on the image is UNKNOWN even with a driver claim", () => {
		expect(
			resolveWpa3Sae({
				driverAdvertisesSae: true,
				supplicantPresent: false,
				nmcliSae: undefined,
			}),
		).toBe("unknown");
	});

	test("only an explicit NetworkManager `no` proves absence", () => {
		expect(
			resolveWpa3Sae({
				driverAdvertisesSae: true,
				supplicantPresent: true,
				nmcliSae: false,
			}),
		).toBe("unsupported");
	});

	test("a NetworkManager `yes` is a positive on its own", () => {
		expect(
			resolveWpa3Sae({
				driverAdvertisesSae: false,
				supplicantPresent: true,
				nmcliSae: true,
			}),
		).toBe("supported");
	});

	test("the fleet's NM 1.42.4 publishes NO SAE key, so it abstains", () => {
		const parsed = parseNmcliWifiProperties(
			[
				"WIFI-PROPERTIES.WEP:yes",
				"WIFI-PROPERTIES.WPA:yes",
				"WIFI-PROPERTIES.WPA2:yes",
				"WIFI-PROPERTIES.TKIP:yes",
				"WIFI-PROPERTIES.CCMP:yes",
				"WIFI-PROPERTIES.AP:yes",
				"WIFI-PROPERTIES.ADHOC:no",
				"WIFI-PROPERTIES.2GHZ:yes",
				"WIFI-PROPERTIES.5GHZ:yes",
				"WIFI-PROPERTIES.MESH:no",
				"WIFI-PROPERTIES.IBSS-RSN:no",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(nmcliSaeClaim(parsed.value)).toBeUndefined();
	});

	test("a newer NM that DOES publish it is read", () => {
		const parsed = parseNmcliWifiProperties("WIFI-PROPERTIES.SAE:no");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(nmcliSaeClaim(parsed.value)).toBe(false);
	});
});
