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
  Regdomain-derived hotspot channels (device-quality-wave3 todo 17).

  Every channel assertion here is driven by a REAL-SHAPED `iw phy` transcript in
  `fixtures/wifi/` — there is deliberately no country→channel table anywhere in
  the module under test, so the only way these expectations can be satisfied is
  by parsing the kernel's own post-regdomain answer.

  NOTHING in this file executes `iw`. Every effectful path goes through the
  injected `setRegdomainRunner` seam, so a test run can never mutate the host's
  own regulatory domain.
*/

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import { ALLOWED } from "../helpers/run.ts";
import {
	applyRegulatoryDomain,
	buildRegdomainDisarmCommand,
	buildRegdomainRestoreCommand,
	checkWirelessRegdbSupport,
	deriveApChannels,
	LEGACY_CRDA_DB_PATH,
	offeredHotspotChannels,
	parseIwPhyChannels,
	parseRegulatoryDomain,
	planHotspotRegdomainChange,
	REGDOMAIN_RESTORE_DELAY,
	REGDOMAIN_RESTORE_UNIT,
	REGULATORY_DB_PATH,
	readRegulatoryDomain,
	refreshHotspotChannels,
	resetRegdomainStateForTest,
	setRegdomainRunner,
	WORLD_REGULATORY_DOMAIN,
} from "../modules/wifi/regdomain.ts";
import {
	channelFromNM,
	type DerivedApChannel,
	explicitChannelId,
	explicitChannelNumber,
	getWifiChannelMap,
	isChannelOffered,
	isWifiChannelName,
	nmSettingsForChannel,
	type WifiChannel,
} from "../modules/wifi/wifi-channels.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "wifi");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const IW_PHY_WORLD = fixture("iw-phy-world.txt");
const IW_PHY_ES = fixture("iw-phy-es.txt");
const IW_PHY_US = fixture("iw-phy-us.txt");
const IW_PHY_LEGACY = fixture("iw-phy-legacy-flags.txt");
const IW_PHY_6GHZ = fixture("iw-phy-6ghz.txt");
const IW_REG_GET_ES = fixture("iw-reg-get-es.txt");
const IW_REG_GET_WORLD = fixture("iw-reg-get-world.txt");

const channels = (output: string, phy?: string) =>
	deriveApChannels(output, phy).map((c) => c.channel);

beforeEach(() => {
	resetRegdomainStateForTest();
});

describe("iw phy derivation — the channel set comes from the kernel, never a table", () => {
	test("world ('00') yields only the conservative 2.4 GHz set", () => {
		// Every 5 GHz frequency in the world domain carries `no IR`, and 12/13 are
		// no-IR too — so an AP may legally start on 1-11 and nothing else.
		expect(channels(IW_PHY_WORLD)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});

	test("ES offers channel 13 and the four non-DFS 5 GHz channels", () => {
		const derived = channels(IW_PHY_ES);
		expect(derived).toContain(13);
		expect(derived).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 36, 40, 44, 48,
		]);
	});

	test("US does NOT offer channel 13, and does offer UNII-3", () => {
		const derived = channels(IW_PHY_US, "phy0");
		expect(derived).not.toContain(13);
		expect(derived).not.toContain(12);
		expect(derived).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 36, 40, 44, 48, 149, 153, 157, 161,
			165,
		]);
	});

	test("DFS (radar detection) channels are excluded for AP use in every domain", () => {
		for (const output of [IW_PHY_WORLD, IW_PHY_ES, IW_PHY_US]) {
			const derived = channels(output);
			for (const dfs of [52, 56, 60, 64, 100, 116, 132, 140]) {
				expect(derived).not.toContain(dfs);
			}
		}
	});

	test("a `disabled` frequency is never offered", () => {
		for (const output of [IW_PHY_WORLD, IW_PHY_ES, IW_PHY_US]) {
			expect(channels(output)).not.toContain(14);
		}
	});

	test("legacy `iw` flag spelling (passive scanning / no IBSS) is honoured", () => {
		// Pre-NO_IR kernels spelled the same restriction two ways; both must
		// exclude the channel, and the integer-MHz form must still parse.
		expect(channels(IW_PHY_LEGACY)).toEqual([1, 2]);
	});

	test("6 GHz frequencies are excluded (no NetworkManager AP band for them)", () => {
		const derived = deriveApChannels(IW_PHY_6GHZ);
		expect(derived.map((c) => c.channel)).toEqual([1, 6]);
		expect(derived.every((c) => c.band === "bg")).toBe(true);
	});

	test("each derived entry carries its frequency and NetworkManager band", () => {
		const derived = deriveApChannels(IW_PHY_ES);
		expect(derived.find((c) => c.channel === 13)).toEqual({
			channel: 13,
			freqMhz: 2472,
			band: "bg",
		});
		expect(derived.find((c) => c.channel === 36)).toEqual({
			channel: 36,
			freqMhz: 5180,
			band: "a",
		});
	});

	test("multiple wiphys are kept apart and selectable by name", () => {
		const byPhy = parseIwPhyChannels(IW_PHY_US);
		expect([...byPhy.keys()]).toEqual(["phy0", "phy1"]);
		// phy1 is a 2.4-only radio on the same board.
		expect(byPhy.get("phy1")?.map((c) => c.channel)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
		]);
		// An unknown phy name yields nothing rather than another radio's set.
		expect(channels(IW_PHY_US, "phy7")).toEqual([]);
		// With no name, the FIRST wiphy is used (never a union across radios).
		expect(channels(IW_PHY_US)).toEqual(channels(IW_PHY_US, "phy0"));
	});

	test("garbage input derives nothing instead of throwing", () => {
		expect(deriveApChannels("")).toEqual([]);
		expect(deriveApChannels("command not found: iw")).toEqual([]);
	});
});

describe("offered channel set = adapter autos + derived explicit channels", () => {
	test("ES offers ch_13; US does not", () => {
		const autos = ["auto", "auto_24", "auto_50"] as const;
		const es = offeredHotspotChannels(autos, deriveApChannels(IW_PHY_ES));
		const us = offeredHotspotChannels(autos, deriveApChannels(IW_PHY_US));

		expect(es).toContain("ch_13");
		expect(us).not.toContain("ch_13");
		expect(us).toContain("ch_149");
	});

	test("the auto entries always lead the list and survive an empty derivation", () => {
		const autos = ["auto", "auto_24"] as const;
		expect(offeredHotspotChannels(autos, [])).toEqual(["auto", "auto_24"]);
		expect(
			offeredHotspotChannels(autos, deriveApChannels(IW_PHY_ES)).slice(0, 2),
		).toEqual(["auto", "auto_24"]);
	});

	test("an explicit channel is dropped when its band has no auto entry", () => {
		// A 2.4-only adapter must never be offered a 5 GHz channel the derivation
		// saw on another radio's regdomain dump.
		const offered = offeredHotspotChannels(
			["auto", "auto_24"],
			deriveApChannels(IW_PHY_US, "phy0"),
		);
		expect(offered).toContain("ch_11");
		expect(offered).not.toContain("ch_36");
	});
});

describe("re-deriving an adapter's offered set", () => {
	test("a country change REPLACES the previous explicit channels", () => {
		const hotspot = {
			availableChannels: ["auto", "auto_24", "auto_50"] as WifiChannel[],
		};

		refreshHotspotChannels(hotspot, deriveApChannels(IW_PHY_ES));
		expect(hotspot.availableChannels).toContain("ch_13");

		refreshHotspotChannels(hotspot, deriveApChannels(IW_PHY_US, "phy0"));
		// Accumulating instead of replacing would keep ES's channel 13 offered
		// under US — the exact illegal-channel bug this ordering prevents.
		expect(hotspot.availableChannels).not.toContain("ch_13");
		expect(hotspot.availableChannels).toContain("ch_149");
	});

	test("the adapter's own band capability survives every re-derivation", () => {
		const hotspot = {
			availableChannels: ["auto", "auto_24"] as WifiChannel[],
		};

		refreshHotspotChannels(hotspot, deriveApChannels(IW_PHY_ES));
		refreshHotspotChannels(hotspot, deriveApChannels(IW_PHY_US, "phy0"));

		expect(hotspot.availableChannels.slice(0, 2)).toEqual(["auto", "auto_24"]);
		// A 2.4-only adapter is never handed a 5 GHz channel by a re-derivation.
		expect(hotspot.availableChannels).not.toContain("ch_36");
	});

	test("the derived list is retained for the NetworkManager mapping", () => {
		const hotspot: {
			availableChannels: WifiChannel[];
			derivedChannels?: DerivedApChannel[];
		} = { availableChannels: ["auto", "auto_24", "auto_50"] };

		refreshHotspotChannels(hotspot, deriveApChannels(IW_PHY_ES));
		expect(
			nmSettingsForChannel("ch_13", hotspot.derivedChannels ?? []),
		).toEqual({ nmBand: "bg", nmChannel: "13" });
	});
});

describe("validation accepts exactly the derived set", () => {
	test("a channel outside the derived set is rejected", () => {
		const usOffered = offeredHotspotChannels(
			["auto", "auto_24", "auto_50"],
			deriveApChannels(IW_PHY_US, "phy0"),
		);
		expect(isChannelOffered("ch_13", usOffered)).toBe(false);
		expect(isChannelOffered("ch_11", usOffered)).toBe(true);
		expect(isChannelOffered("auto", usOffered)).toBe(true);
	});

	test("a well-formed-but-underived channel is still rejected", () => {
		const esOffered = offeredHotspotChannels(
			["auto", "auto_24", "auto_50"],
			deriveApChannels(IW_PHY_ES),
		);
		// ch_140 is DFS in ES — shape-valid, never offered.
		expect(isWifiChannelName("ch_140")).toBe(true);
		expect(isChannelOffered("ch_140", esOffered)).toBe(false);
	});

	test("a malformed channel id is refused by shape alone", () => {
		for (const bad of [
			"ch_0",
			"ch_",
			"ch_abc",
			"13",
			"chan_13",
			"ch_1000",
			"",
		]) {
			expect(isWifiChannelName(bad)).toBe(false);
		}
	});

	test("explicit channel ids round-trip", () => {
		expect(explicitChannelId(13)).toBe("ch_13");
		expect(explicitChannelNumber("ch_13")).toBe(13);
		expect(explicitChannelNumber("auto")).toBeUndefined();
	});
});

describe("NetworkManager mapping for a derived channel", () => {
	const derivedEs = deriveApChannels(IW_PHY_ES);

	test("an explicit channel maps to its real band + number", () => {
		expect(nmSettingsForChannel("ch_13", derivedEs)).toEqual({
			nmBand: "bg",
			nmChannel: "13",
		});
		expect(nmSettingsForChannel("ch_36", derivedEs)).toEqual({
			nmBand: "a",
			nmChannel: "36",
		});
	});

	test("an underived channel has NO NetworkManager mapping", () => {
		expect(
			nmSettingsForChannel("ch_13", deriveApChannels(IW_PHY_US, "phy0")),
		).toBeUndefined();
	});

	test("auto entries keep their existing mapping byte-for-byte", () => {
		expect(nmSettingsForChannel("auto", derivedEs)).toEqual({
			nmBand: "",
			nmChannel: "",
		});
		expect(nmSettingsForChannel("auto_24", derivedEs)).toEqual({
			nmBand: "bg",
			nmChannel: "",
		});
		expect(nmSettingsForChannel("auto_50", derivedEs)).toEqual({
			nmBand: "a",
			nmChannel: "",
		});
	});

	test("channelFromNM recognises an explicit channel and still recognises the autos", () => {
		expect(channelFromNM("bg", 13)).toBe("ch_13");
		expect(channelFromNM("a", "36")).toBe("ch_36");
		expect(channelFromNM("bg", 0)).toBe("auto_24");
		expect(channelFromNM("", 0)).toBe("auto");
	});

	test("the channel map names explicit channels with their band", () => {
		const map = getWifiChannelMap(["auto", "ch_13", "ch_36"], derivedEs);
		expect(map.auto?.name).toBe("Auto (any band)");
		expect(map.ch_13?.name).toBe("Channel 13 (2.4 GHz)");
		expect(map.ch_36?.name).toBe("Channel 36 (5 GHz)");
	});
});

describe("`iw reg get` parsing", () => {
	test("reads the active global country code", () => {
		expect(parseRegulatoryDomain(IW_REG_GET_ES)).toBe("ES");
		expect(parseRegulatoryDomain(IW_REG_GET_WORLD)).toBe(
			WORLD_REGULATORY_DOMAIN,
		);
	});

	test("an unreadable answer yields undefined, never a guess", () => {
		expect(parseRegulatoryDomain("")).toBeUndefined();
		expect(
			parseRegulatoryDomain("Failed to connect to nl80211"),
		).toBeUndefined();
	});
});

describe("`iw reg set` apply wrapper (injected runner — never a real iw)", () => {
	test("issues exactly `iw reg set <CC>`", async () => {
		const calls: Array<{ bin: string; args: string[] }> = [];
		setRegdomainRunner(async (bin, args) => {
			calls.push({ bin, args });
			return "";
		});

		await expect(applyRegulatoryDomain("ES")).resolves.toBe(true);
		expect(calls).toEqual([{ bin: "iw", args: ["reg", "set", "ES"] }]);
	});

	test("normalises to upper case and accepts the world domain", async () => {
		const calls: string[][] = [];
		setRegdomainRunner(async (_bin, args) => {
			calls.push(args);
			return "";
		});

		await applyRegulatoryDomain("es");
		await applyRegulatoryDomain(WORLD_REGULATORY_DOMAIN);
		expect(calls).toEqual([
			["reg", "set", "ES"],
			["reg", "set", "00"],
		]);
	});

	test("refuses a malformed country WITHOUT spawning anything", async () => {
		const runner = mock(async () => "");
		setRegdomainRunner(runner);

		for (const bad of ["", "E", "ESP", "E1", "../etc", "-X"]) {
			await expect(applyRegulatoryDomain(bad)).resolves.toBe(false);
		}
		expect(runner).not.toHaveBeenCalled();
	});

	test("a failing `iw` is reported, never thrown", async () => {
		setRegdomainRunner(async () => {
			throw new Error("nl80211 not found");
		});
		await expect(applyRegulatoryDomain("ES")).resolves.toBe(false);
	});

	test("readRegulatoryDomain routes through the same seam", async () => {
		const calls: Array<{ bin: string; args: string[] }> = [];
		setRegdomainRunner(async (bin, args) => {
			calls.push({ bin, args });
			return IW_REG_GET_ES;
		});

		await expect(readRegulatoryDomain()).resolves.toBe("ES");
		expect(calls).toEqual([{ bin: "iw", args: ["reg", "get"] }]);
	});

	test("`iw` and `systemd-run` are allowlisted for the real runner", () => {
		expect(ALLOWED.has("iw")).toBe(true);
		expect(ALLOWED.has("systemd-run")).toBe(true);
	});
});

describe("wireless-regdb / CRDA precheck", () => {
	const present = (...paths: string[]) => ({
		exists: async (p: string) => paths.includes(p),
	});

	test("a modern image shipping regulatory.db is supported", async () => {
		const verdict = await checkWirelessRegdbSupport(
			present(REGULATORY_DB_PATH, `${REGULATORY_DB_PATH}.p7s`),
		);
		expect(verdict).toEqual({
			supported: true,
			regulatoryDb: true,
			regulatoryDbSignature: true,
			legacyCrdaDb: false,
		});
	});

	test("a legacy CRDA image is supported too", async () => {
		const verdict = await checkWirelessRegdbSupport(
			present(LEGACY_CRDA_DB_PATH),
		);
		expect(verdict.supported).toBe(true);
		expect(verdict.legacyCrdaDb).toBe(true);
		expect(verdict.regulatoryDb).toBe(false);
	});

	test("an image with neither database is NOT supported", async () => {
		const verdict = await checkWirelessRegdbSupport(present());
		expect(verdict).toEqual({
			supported: false,
			regulatoryDb: false,
			regulatoryDbSignature: false,
			legacyCrdaDb: false,
		});
	});

	test("a throwing probe fails closed rather than crashing the caller", async () => {
		const verdict = await checkWirelessRegdbSupport({
			exists: async () => {
				throw new Error("EACCES");
			},
		});
		expect(verdict.supported).toBe(false);
	});
});

describe("board-safety armed restore timer (argv only — never executed here)", () => {
	test("constructs the exact systemd-run invocation the drill arms", () => {
		expect(buildRegdomainRestoreCommand({ country: "00" })).toEqual({
			bin: "systemd-run",
			args: [
				`--unit=${REGDOMAIN_RESTORE_UNIT}`,
				`--on-active=${REGDOMAIN_RESTORE_DELAY}`,
				"--collect",
				"--description=CeraUI regulatory-domain restore",
				"iw",
				"reg",
				"set",
				"00",
			],
		});
	});

	test("restores the captured PRE-STATE country, upper-cased", () => {
		const cmd = buildRegdomainRestoreCommand({ country: "es", delay: "5min" });
		expect(cmd.args).toContain("--on-active=5min");
		expect(cmd.args.slice(-4)).toEqual(["iw", "reg", "set", "ES"]);
	});

	test("refuses to build a timer for a malformed pre-state", () => {
		for (const bad of ["", "ESP", "-X", "; reboot"]) {
			expect(() => buildRegdomainRestoreCommand({ country: bad })).toThrow();
		}
	});

	test("disarm stops the transient timer unit, not the service", () => {
		expect(buildRegdomainDisarmCommand()).toEqual({
			bin: "systemctl",
			args: ["stop", `${REGDOMAIN_RESTORE_UNIT}.timer`],
		});
	});
});

describe("hotspot restart semantics on a country/channel change", () => {
	const esOffered = offeredHotspotChannels(
		["auto", "auto_24", "auto_50"],
		deriveApChannels(IW_PHY_ES),
	);
	const usOffered = offeredHotspotChannels(
		["auto", "auto_24", "auto_50"],
		deriveApChannels(IW_PHY_US, "phy0"),
	);

	test("an inactive AP is not restarted — the next start picks up the new set", () => {
		expect(
			planHotspotRegdomainChange(
				{ active: false, channel: "ch_13" },
				usOffered,
			),
		).toEqual({ kind: "none" });
	});

	test("a live AP on a still-legal channel restarts cleanly to re-apply the domain", () => {
		expect(
			planHotspotRegdomainChange({ active: true, channel: "ch_13" }, esOffered),
		).toEqual({ kind: "restart" });
		expect(
			planHotspotRegdomainChange(
				{ active: true, channel: "auto_24" },
				usOffered,
			),
		).toEqual({ kind: "restart" });
		expect(
			planHotspotRegdomainChange(
				{ active: true, channel: undefined },
				usOffered,
			),
		).toEqual({ kind: "restart" });
	});

	test("a live AP on a now-illegal channel is clamped to `auto` before restarting", () => {
		// ES→US retires channel 13. Clamping to `auto` (not `auto_24`) is
		// deliberate: the whole BAND can be withdrawn by a regdomain change, so
		// the only always-legal fallback is letting the kernel choose.
		expect(
			planHotspotRegdomainChange({ active: true, channel: "ch_13" }, usOffered),
		).toEqual({ kind: "clamp-and-restart", channel: "auto" });
	});

	test("an empty derivation never clamps a live AP off the air", () => {
		// A failed `iw phy` probe proves nothing about legality — leave the AP be.
		expect(
			planHotspotRegdomainChange({ active: true, channel: "ch_13" }, []),
		).toEqual({ kind: "none" });
	});
});

describe("persisted country config field", () => {
	test("accepts an ISO-3166-1 alpha-2 code and the world domain", () => {
		for (const cc of ["ES", "US", "GB", WORLD_REGULATORY_DOMAIN]) {
			expect(runtimeConfigSchema.parse({ country: cc }).country).toBe(cc);
		}
	});

	test("is optional — an existing config without it still parses", () => {
		expect(runtimeConfigSchema.parse({}).country).toBeUndefined();
	});

	test("rejects anything that is not a country code", () => {
		for (const bad of ["esp", "e", "1A", "E1", "", "ES ", "us"]) {
			expect(runtimeConfigSchema.safeParse({ country: bad }).success).toBe(
				false,
			);
		}
	});
});
