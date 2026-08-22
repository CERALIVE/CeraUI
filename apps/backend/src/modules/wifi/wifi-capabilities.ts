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
  Per-adapter Wi-Fi capability truth, read from nl80211 via `iw`.

  THE RULE, and it is the same one `regdomain.ts` states for channels: nothing
  here is inferred from a marketing name, a board model, a kernel version, or an
  adapter's POSITION in a list. Every value is read back out of the kernel's own
  answer for ONE wiphy. NetworkManager's WIFI-PROPERTIES is a cross-check and
  never the source — it carries no HE/EHT, no channel widths and no SAE proof.

  This module EXTENDS the `regdomain.ts` beachhead rather than forking it: every
  `iw` spawn goes through that module's `runIw`, so there is ONE injectable seam
  (`setRegdomainRunner`) for the binary and a test can never reach the host's
  radios.

  Three things are easy to get wrong here, and each has its own guard:

  1. WHICH ADAPTER a capability belongs to. Resolved through the stable
     `ifname → wiphy` link at /sys/class/net/<ifname>/phy80211, cross-checked
     against `iw dev`. A dual-wiphy board with a virtual AP interface is the case
     that makes a positional assumption silently cross-assign a radio's whole
     capability set to its neighbour.
  2. WHAT THE KERNEL ACTUALLY SAID. Every parser is named and fails LOUD (S2):
     a drifted or truncated dump yields a typed `ParseError`, never a partial
     object that flows downstream as if it were measured.
  3. WHETHER THE REGULATORY DOMAIN IS OURS TO SET. A self-managed wiphy
     (firmware-regulated Intel / MediaTek parts) intersects or ignores a user
     hint, so the regulatory block is READ AFTER WRITE and reports the OBSERVED
     domain for that phy — never the country that was requested.
*/

import { readlink } from "node:fs/promises";
import { basename } from "node:path";
import type {
	WifiAdapterCapabilities,
	WifiBandMaxWidth,
	WifiCapabilityBand,
	WifiGeneration,
	WifiSaeSupport,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { argMatch, ID_RE, run } from "../../helpers/run.ts";
import { getms } from "../../helpers/time.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import { runIw } from "./regdomain.ts";

// ─── pure parsing: `iw phy` ──────────────────────────────────────────────────

const WIPHY_RE = /^Wiphy\s+(\S+)\s*$/;
const WIPHY_INDEX_RE = /^wiphy index:\s*(\d+)\s*$/;
const BAND_RE = /^Band\s+(\d+):\s*$/;
/** `* 5180 MHz [36] (20.0 dBm)` — the decimal is optional (older `iw`). */
const FREQUENCY_RE = /^\*\s*(\d+)(?:\.\d+)?\s*MHz\s*\[\d+\]/;
const IFTYPE_RE = /^\*\s*(\S+)\s*$/;
const HEX_CAPS_RE = /\(0x([0-9a-fA-F]*)\)/;

/** The one phy-level line every mac80211 driver prints when it advertises SAE. */
const SAE_AUTHENTICATE_LINE = "Device supports SAE with AUTHENTICATE command";
const SAE_OFFLOAD_RE = /\[\s*SAE_OFFLOAD(?:_AP)?\s*\]/;

export type WifiPhyCapabilities = {
	readonly phy: string;
	readonly wiphyIndex: number | undefined;
	readonly generation: WifiGeneration;
	readonly bands: readonly WifiCapabilityBand[];
	readonly maxWidthMhz: WifiBandMaxWidth;
	readonly apModes: readonly WifiCapabilityBand[];
	readonly staApCombo: {
		readonly supported: boolean;
		readonly sameChannelOnly: boolean;
	};
	readonly driverAdvertisesSae: boolean;
};

type BandBlock = {
	lines: string[];
	band: WifiCapabilityBand | undefined;
};

function tabDepth(line: string): number {
	let depth = 0;
	while (line[depth] === "\t") depth++;
	return depth;
}

/**
 * Which band a block describes, decided by the FREQUENCIES the kernel listed
 * rather than by the `Band N:` index. The index is an nl80211 enumeration
 * convention; the frequency is the device's own answer.
 */
function bandForFrequency(freqMhz: number): WifiCapabilityBand | undefined {
	if (freqMhz >= 2400 && freqMhz <= 2500) return "2.4";
	if (freqMhz >= 4900 && freqMhz < 5925) return "5";
	if (freqMhz >= 5925 && freqMhz <= 7125) return "6";
	return undefined;
}

/**
 * The widest channel the radio advertises for this band. Every rung is a token
 * the kernel printed — an unstated width is never rounded up from a neighbour.
 */
function bandMaxWidthMhz(text: string): number | undefined {
	let width: number | undefined;
	const widen = (candidate: number) => {
		if (width === undefined || candidate > width) width = candidate;
	};

	if (/\bHT20\/HT40\b/.test(text)) widen(40);
	else if (/\bHT20\b/.test(text)) widen(20);

	const vht = /Supported Channel Width:\s*(.+)/.exec(text)?.[1] ?? "";
	if (vht) widen(/160 MHz/.test(vht) ? 160 : 80);

	if (/\bHE160\b/.test(text)) widen(160);
	else if (/\bHE80\b/.test(text)) widen(80);
	else if (/\bHE40\b/.test(text)) widen(40);

	if (/\b320\s*MHz\b/.test(text) || /EHT bw=?\s*320/.test(text)) widen(320);

	return width;
}

/**
 * EHT structures are printed by every EHT-aware kernel, including for radios
 * that carry no usable EHT at all — the shipped RTL8852BE prints
 * `EHT MAC Capabilities (0x0000)` with every MCS/NSS at zero. An all-zero stub
 * is NOT a Wi-Fi 7 radio, so usability is decided by a non-zero capability word.
 */
function hasUsableEht(text: string): boolean {
	for (const line of text.split("\n")) {
		if (!/EHT (?:MAC|PHY) Capabilities/.test(line)) continue;
		const hex = HEX_CAPS_RE.exec(line)?.[1] ?? "";
		if (/[1-9a-fA-F]/.test(hex)) return true;
	}
	return false;
}

function deriveGeneration(
	bandTexts: readonly string[],
	bands: readonly WifiCapabilityBand[],
): WifiGeneration {
	const all = bandTexts.join("\n");
	if (hasUsableEht(all)) return "wifi7";
	if (/\bHE (?:Iftypes|MAC Capabilities|PHY Capabilities)/.test(all)) {
		return bands.includes("6") ? "wifi6e" : "wifi6";
	}
	if (/VHT Capabilities/.test(all)) return "wifi5";
	return "wifi4";
}

const COMBO_GROUP_RE = /#\{([^}]*)\}\s*<=\s*(\d+)/g;

/**
 * STA+AP concurrency from the wiphy's `valid interface combinations`.
 *
 * A combination qualifies only when `managed` and an AP-bearing group are
 * SEPARATE groups that can each be instantiated and the total permits both —
 * one group holding both at `<= 1` is a choice between them, not concurrency.
 * `#channels <= 1` is what pins the AP to the station's channel.
 */
export function parseInterfaceCombination(entry: string): {
	supported: boolean;
	sameChannelOnly: boolean;
} {
	COMBO_GROUP_RE.lastIndex = 0;
	let managed = false;
	let ap = false;
	for (const match of entry.matchAll(COMBO_GROUP_RE)) {
		const members = (match[1] ?? "").split(",").map((m) => m.trim());
		const limit = Number(match[2] ?? "0");
		if (limit < 1) continue;
		const hasManaged = members.includes("managed");
		const hasAp = members.includes("AP");
		if (hasManaged && hasAp) continue;
		if (hasManaged) managed = true;
		if (hasAp) ap = true;
	}

	const total = Number(/total\s*<=\s*(\d+)/.exec(entry)?.[1] ?? "0");
	const channels = Number(/#channels\s*<=\s*(\d+)/.exec(entry)?.[1] ?? "0");
	const supported = managed && ap && total >= 2;

	// When concurrency is refused, the channel constraint describes nothing, so
	// it reports the restrictive value rather than implying multi-channel.
	return { supported, sameChannelOnly: supported ? channels <= 1 : true };
}

type PhyBlock = { phy: string; lines: string[] };

function splitPhyBlocks(output: string): PhyBlock[] {
	const blocks: PhyBlock[] = [];
	let current: PhyBlock | undefined;
	for (const raw of output.split("\n")) {
		const header = WIPHY_RE.exec(raw.trim());
		if (header?.[1] && tabDepth(raw) === 0) {
			current = { phy: header[1], lines: [] };
			blocks.push(current);
			continue;
		}
		current?.lines.push(raw);
	}
	return blocks;
}

/**
 * Parse an `iw phy` dump into per-wiphy capabilities.
 *
 * Radios are kept APART: a dual-radio board's wiphys carry different bands,
 * widths and generations, and unioning them would attribute one radio's Wi-Fi 7
 * to its Wi-Fi 5 neighbour.
 *
 * EMPTY output is a first-class SUCCESS (a board with no Wi-Fi hardware — the
 * Orange Pi 5 Plus is exactly that). Non-empty output that does not carry a
 * `Wiphy` header, a phy with no interface modes, a phy with no bands, or a band
 * with no frequencies are all DRIFT and fail loud.
 */
export function parseIwPhyCapabilities(
	output: string,
): ParseResult<Map<string, WifiPhyCapabilities>> {
	const byPhy = new Map<string, WifiPhyCapabilities>();
	if (output.trim() === "") return parseOk(byPhy);

	const blocks = splitPhyBlocks(output);
	if (blocks.length === 0) {
		return parseFail(
			"parseIwPhyCapabilities",
			"no `Wiphy <name>` header in a non-empty dump",
			output,
		);
	}

	for (const block of blocks) {
		const parsed = parsePhyBlock(block);
		if (!parsed.ok) return parsed;
		byPhy.set(block.phy, parsed.value);
	}

	return parseOk(byPhy);
}

function parsePhyBlock(block: PhyBlock): ParseResult<WifiPhyCapabilities> {
	const bands: BandBlock[] = [];
	const iftypes: string[] = [];
	const comboLines: string[] = [];
	let wiphyIndex: number | undefined;
	let driverAdvertisesSae = false;

	let mode: "band" | "iftypes" | "combos" | "none" = "none";
	let currentBand: BandBlock | undefined;

	for (const raw of block.lines) {
		const depth = tabDepth(raw);
		const line = raw.trim();
		if (line === "") continue;

		if (depth <= 1) {
			const bandHeader = BAND_RE.exec(line);
			if (bandHeader) {
				currentBand = { lines: [], band: undefined };
				bands.push(currentBand);
				mode = "band";
				continue;
			}
			if (line === "Supported interface modes:") {
				mode = "iftypes";
				continue;
			}
			if (line === "valid interface combinations:") {
				mode = "combos";
				continue;
			}
			// `software interface modes` is deliberately NOT read as an AP claim:
			// it lists AP/VLAN and monitor, which are not an AP the radio can host.
			mode = "none";
			if (line === SAE_AUTHENTICATE_LINE) driverAdvertisesSae = true;
			const index = WIPHY_INDEX_RE.exec(line);
			if (index?.[1]) wiphyIndex = Number(index[1]);
			continue;
		}

		if (SAE_OFFLOAD_RE.test(line)) driverAdvertisesSae = true;

		if (mode === "band" && currentBand) {
			currentBand.lines.push(line);
			const freq = FREQUENCY_RE.exec(line);
			if (freq?.[1] && currentBand.band === undefined) {
				currentBand.band = bandForFrequency(Number(freq[1]));
			}
			continue;
		}
		if (mode === "iftypes") {
			const iftype = IFTYPE_RE.exec(line);
			if (iftype?.[1]) iftypes.push(iftype[1]);
			continue;
		}
		if (mode === "combos") comboLines.push(line);
	}

	if (iftypes.length === 0) {
		return parseFail(
			"parseIwPhyCapabilities",
			`wiphy ${block.phy} declared no supported interface modes`,
			block.lines.join("\n"),
		);
	}
	if (bands.length === 0) {
		return parseFail(
			"parseIwPhyCapabilities",
			`wiphy ${block.phy} declared no bands`,
			block.lines.join("\n"),
		);
	}
	for (const band of bands) {
		if (band.band === undefined) {
			return parseFail(
				"parseIwPhyCapabilities",
				`wiphy ${block.phy} has a band block with no recognisable frequency`,
				band.lines.join("\n"),
			);
		}
	}

	const supportedBands: WifiCapabilityBand[] = [];
	const maxWidthMhz: WifiBandMaxWidth = {};
	const bandTexts: string[] = [];
	for (const band of bands) {
		if (band.band === undefined) continue;
		const text = band.lines.join("\n");
		bandTexts.push(text);
		if (!supportedBands.includes(band.band)) supportedBands.push(band.band);
		const width = bandMaxWidthMhz(text);
		if (width !== undefined) {
			const previous = maxWidthMhz[band.band];
			if (previous === undefined || width > previous) {
				maxWidthMhz[band.band] = width;
			}
		}
	}

	const apCapable = iftypes.includes("AP");
	const combo = parseInterfaceCombination(comboLines.join(" "));

	return parseOk({
		phy: block.phy,
		wiphyIndex,
		generation: deriveGeneration(bandTexts, supportedBands),
		bands: supportedBands,
		maxWidthMhz,
		apModes: apCapable ? [...supportedBands] : [],
		staApCombo: combo,
		driverAdvertisesSae,
	});
}

// ─── pure parsing: `iw reg get` ──────────────────────────────────────────────

const REG_PHY_RE = /^phy#(\d+)(\s+\(self-managed\))?\s*$/;
const REG_COUNTRY_RE = /^country\s+([A-Z0-9]{2}):/;
const REG_RULE_RE = /^\(\s*(\d+)\s*-\s*(\d+)\s*@/;

/** The 6 GHz allocation. 60 GHz rules (57240-63720) are deliberately outside it. */
const SIX_GHZ_START_MHZ = 5925;
const SIX_GHZ_END_MHZ = 7125;

export type RegulatorySection = {
	readonly country: string;
	readonly selfManaged: boolean;
	readonly is6GhzLegal: boolean;
};

export type IwRegState = {
	readonly global: RegulatorySection | undefined;
	readonly byWiphyIndex: ReadonlyMap<number, RegulatorySection>;
};

/**
 * Parse `iw reg get` into the global domain plus every PER-PHY section.
 *
 * The per-phy section is the whole point: a self-managed wiphy carries its own
 * domain, so a device that applied `ES` can be sitting on `US` for that radio
 * and only this section says so.
 */
export function parseIwRegDomains(output: string): ParseResult<IwRegState> {
	let global: RegulatorySection | undefined;
	const byWiphyIndex = new Map<number, RegulatorySection>();

	let scope: { phyIndex: number | undefined; selfManaged: boolean } = {
		phyIndex: undefined,
		selfManaged: false,
	};
	let country: string | undefined;
	let sixGhz = false;
	let sawCountry = false;

	const commit = () => {
		if (country === undefined) return;
		const section: RegulatorySection = {
			country,
			selfManaged: scope.selfManaged,
			is6GhzLegal: sixGhz,
		};
		if (scope.phyIndex === undefined) global = section;
		else byWiphyIndex.set(scope.phyIndex, section);
		country = undefined;
		sixGhz = false;
	};

	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;

		if (line === "global") {
			commit();
			scope = { phyIndex: undefined, selfManaged: false };
			continue;
		}
		const phy = REG_PHY_RE.exec(line);
		if (phy?.[1]) {
			commit();
			scope = { phyIndex: Number(phy[1]), selfManaged: phy[2] !== undefined };
			continue;
		}
		const countryMatch = REG_COUNTRY_RE.exec(line);
		if (countryMatch?.[1]) {
			commit();
			country = countryMatch[1];
			sawCountry = true;
			continue;
		}
		const rule = REG_RULE_RE.exec(line);
		if (rule?.[1] && rule[2]) {
			const start = Number(rule[1]);
			const end = Number(rule[2]);
			if (start < SIX_GHZ_END_MHZ && end > SIX_GHZ_START_MHZ) sixGhz = true;
		}
	}
	commit();

	if (!sawCountry) {
		return parseFail(
			"parseIwRegDomains",
			"no `country <CC>:` line in the regulatory dump",
			output,
		);
	}

	return parseOk({ global, byWiphyIndex });
}

// ─── pure parsing: `iw dev` + nmcli cross-checks ─────────────────────────────

const IW_DEV_PHY_RE = /^phy#(\d+)\s*$/;
const IW_DEV_IFACE_RE = /^Interface\s+(\S+)\s*$/;

/**
 * `ifname → wiphy` as `iw dev` reports it. This is the CROSS-CHECK for the
 * sysfs link, never the primary: a virtual AP interface and its station sibling
 * live on ONE wiphy, and only a per-interface answer can attribute either.
 */
export function parseIwDevPhyMap(
	output: string,
): ParseResult<Map<string, string>> {
	const byIfname = new Map<string, string>();
	if (output.trim() === "") return parseOk(byIfname);

	let currentPhy: string | undefined;
	let sawPhy = false;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const phy = IW_DEV_PHY_RE.exec(line);
		if (phy?.[1]) {
			currentPhy = `phy${phy[1]}`;
			sawPhy = true;
			continue;
		}
		const iface = IW_DEV_IFACE_RE.exec(line);
		if (iface?.[1] && currentPhy !== undefined) {
			byIfname.set(iface[1], currentPhy);
		}
	}

	if (!sawPhy) {
		return parseFail(
			"parseIwDevPhyMap",
			"no `phy#<n>` section in a non-empty `iw dev` dump",
			output,
		);
	}

	return parseOk(byIfname);
}

/** `WIFI-PROPERTIES.AP:yes` lines from `nmcli --terse --fields WIFI-PROPERTIES`. */
export function parseNmcliWifiProperties(
	output: string,
): ParseResult<Map<string, string>> {
	const props = new Map<string, string>();
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).toUpperCase();
		// An nmcli ERROR line is also `<word>: <text>`, so the key must actually
		// name the block we asked for or a failure parses as one bogus property.
		if (!key.startsWith("WIFI-PROPERTIES.")) continue;
		props.set(key, line.slice(separator + 1));
	}
	if (props.size === 0) {
		return parseFail(
			"parseNmcliWifiProperties",
			"no `WIFI-PROPERTIES.<key>:<value>` lines",
			output,
		);
	}
	return parseOk(props);
}

/**
 * NetworkManager's own SAE claim, when it makes one.
 *
 * Measured on the fleet's NM 1.42.4 (Rock 5B+, 2026-08-21): the WIFI-PROPERTIES
 * block publishes WEP/WPA/WPA2/TKIP/CCMP/AP/ADHOC/2GHZ/5GHZ/MESH/IBSS-RSN and
 * NO SAE or WPA3 key at all. So this answers `undefined` on every shipped
 * device today, and the tri-state below correctly refuses to conclude anything
 * from that. It is read rather than assumed so a newer NM lights it up for free.
 */
export function nmcliSaeClaim(
	props: ReadonlyMap<string, string> | undefined,
): boolean | undefined {
	if (props === undefined) return undefined;
	for (const key of ["WIFI-PROPERTIES.SAE", "WIFI-PROPERTIES.WPA3"]) {
		const value = props.get(key);
		if (value === "yes") return true;
		if (value === "no") return false;
	}
	return undefined;
}

/**
 * WPA3-SAE, and the reason it is a tri-state.
 *
 * A driver that advertises nothing has NOT said it lacks SAE — a full-MAC part
 * can offload SAE and print no feature at all — so absence resolves `unknown`.
 * Only an explicit NetworkManager `no` is evidence of absence, and a positive
 * claim additionally needs a supplicant on the image to act on it.
 */
export function resolveWpa3Sae(evidence: {
	driverAdvertisesSae: boolean;
	supplicantPresent: boolean;
	nmcliSae: boolean | undefined;
}): WifiSaeSupport {
	if (evidence.nmcliSae === false) return "unsupported";
	if (!evidence.supplicantPresent) return "unknown";
	if (evidence.driverAdvertisesSae || evidence.nmcliSae === true) {
		return "supported";
	}
	return "unknown";
}

// ─── effectful surface (injectable) ──────────────────────────────────────────

/** Paths the shipped image may carry `wpa_supplicant` at. */
export const WPA_SUPPLICANT_PATHS = [
	"/usr/sbin/wpa_supplicant",
	"/sbin/wpa_supplicant",
	"/usr/bin/wpa_supplicant",
] as const;

/**
 * How long a computed capability set is served before the next ask re-reads it.
 * A wiphy's bands and widths are hardware, but its REGULATORY state is not: a
 * self-managed wiphy can move domain with no user action at all, so a board
 * carrying one is re-read on a much shorter bound.
 */
export const WIFI_CAPABILITIES_TTL_MS = 5 * 60_000;
export const WIFI_SELF_MANAGED_TTL_MS = 60_000;

export type WifiCapabilityDeps = {
	readonly runIw: (args: string[]) => Promise<string>;
	readonly readPhyName: (ifname: string) => Promise<string | undefined>;
	readonly pathExists: (path: string) => Promise<boolean>;
	readonly readNmcliWifiProperties: (
		ifname: string,
	) => Promise<Map<string, string> | undefined>;
	readonly now: () => number;
};

const defaultDeps: WifiCapabilityDeps = {
	runIw: (args) => runIw(args),
	readPhyName: async (ifname) => {
		try {
			const target = await readlink(`/sys/class/net/${ifname}/phy80211`);
			return basename(target);
		} catch {
			return undefined;
		}
	},
	pathExists: async (path) => {
		try {
			return await Bun.file(path).exists();
		} catch {
			return false;
		}
	},
	readNmcliWifiProperties: async (ifname) => {
		try {
			const stdout = await run("nmcli", [
				"--terse",
				"--fields",
				"WIFI-PROPERTIES",
				"device",
				"show",
				argMatch(ID_RE, ifname),
			]);
			const parsed = parseNmcliWifiProperties(stdout);
			if (!parsed.ok) {
				logParseError(parsed);
				return undefined;
			}
			return parsed.value;
		} catch (err) {
			logger.debug(`wifi capabilities: nmcli properties unavailable: ${err}`);
			return undefined;
		}
	},
	now: () => getms(),
};

let deps: WifiCapabilityDeps = defaultDeps;

type CapabilityCache = {
	byPhy: Map<string, WifiAdapterCapabilities>;
	byIfname: Map<string, string>;
	ifnameKey: string;
	computedAtMs: number;
	selfManaged: boolean;
};

let cache: CapabilityCache | undefined;
let inFlight: Promise<void> | undefined;
let lastIfnames: readonly string[] = [];

/** Test seam — mirrors `setRegdomainRunner` / `setSshServiceRunner`. */
export function setWifiCapabilityDepsForTest(
	next: Partial<WifiCapabilityDeps> | null,
): void {
	deps = next === null ? defaultDeps : { ...defaultDeps, ...next };
}

/** Test seam: drop every cached capability set and the recorded adapter set. */
export function resetWifiCapabilitiesForTest(): void {
	cache = undefined;
	inFlight = undefined;
	lastIfnames = [];
	deps = defaultDeps;
}

function ifnameKeyOf(ifnames: readonly string[]): string {
	return [...ifnames].sort().join(",");
}

function isStale(entry: CapabilityCache, nowMs: number): boolean {
	const ttl = entry.selfManaged
		? WIFI_SELF_MANAGED_TTL_MS
		: WIFI_CAPABILITIES_TTL_MS;
	return nowMs - entry.computedAtMs >= ttl;
}

async function resolveSupplicantPresent(): Promise<boolean> {
	for (const path of WPA_SUPPLICANT_PATHS) {
		if (await deps.pathExists(path)) return true;
	}
	return false;
}

/**
 * The `ifname → wiphy` map, sysfs FIRST.
 *
 * The /sys link is the kernel's own statement about which radio backs this
 * netdev; `iw dev` is asked only as a cross-check and as the fallback for an
 * interface whose sysfs entry could not be read. A disagreement is LOGGED and
 * resolved in favour of sysfs rather than silently averaged.
 */
async function resolvePhyByIfname(
	ifnames: readonly string[],
	fromIwDev: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
	const byIfname = new Map<string, string>();
	for (const ifname of ifnames) {
		const linked = await deps.readPhyName(ifname);
		const reported = fromIwDev.get(ifname);
		if (linked !== undefined && reported !== undefined && linked !== reported) {
			logger.warn(
				`wifi capabilities: ${ifname} links to ${linked} but \`iw dev\` reports ${reported}; trusting the sysfs link`,
			);
		}
		const phy = linked ?? reported;
		if (phy !== undefined) byIfname.set(ifname, phy);
	}
	return byIfname;
}

function regulatoryFor(
	reg: IwRegState,
	wiphyIndex: number | undefined,
): WifiAdapterCapabilities["regulatory"] {
	const perPhy =
		wiphyIndex === undefined ? undefined : reg.byWiphyIndex.get(wiphyIndex);
	const section = perPhy ?? reg.global;
	return {
		country: section?.country ?? "",
		is6GhzLegal: section?.is6GhzLegal ?? false,
		// EXPLICIT false — a recoverable field that is present-only-when-true can
		// be raised and never lowered by a merging consumer.
		self_managed: section?.selfManaged ?? false,
	};
}

async function computeCapabilities(ifnames: readonly string[]): Promise<void> {
	const nowMs = deps.now();

	const phyDump = await deps.runIw(["phy"]);
	const phyParsed = parseIwPhyCapabilities(phyDump);
	if (!phyParsed.ok) {
		logParseError(phyParsed);
		// Drift means we can no longer vouch for ANY value read this way. The
		// cache is dropped so the wire omits `capabilities` rather than serving a
		// stale claim under a shape we can no longer read.
		cache = undefined;
		return;
	}

	const regDump = await deps.runIw(["reg", "get"]);
	const regParsed = parseIwRegDomains(regDump);
	if (!regParsed.ok) {
		logParseError(regParsed);
		cache = undefined;
		return;
	}

	const devDump = await deps.runIw(["dev"]);
	const devParsed = parseIwDevPhyMap(devDump);
	if (!devParsed.ok) {
		logParseError(devParsed);
		cache = undefined;
		return;
	}

	const byIfname = await resolvePhyByIfname(ifnames, devParsed.value);
	const supplicantPresent = await resolveSupplicantPresent();

	const byPhy = new Map<string, WifiAdapterCapabilities>();
	let selfManaged = false;
	for (const [ifname, phy] of byIfname) {
		const phyCaps = phyParsed.value.get(phy);
		if (phyCaps === undefined) continue;
		if (byPhy.has(phy)) continue;

		const nmcliSae = nmcliSaeClaim(await deps.readNmcliWifiProperties(ifname));
		const regulatory = regulatoryFor(regParsed.value, phyCaps.wiphyIndex);
		if (regulatory.self_managed) selfManaged = true;

		byPhy.set(phy, {
			phy: phyCaps.phy,
			generation: phyCaps.generation,
			bands: [...phyCaps.bands],
			maxWidthMhz: phyCaps.maxWidthMhz,
			apModes: [...phyCaps.apModes],
			staApCombo: { ...phyCaps.staApCombo },
			wpa3Sae: resolveWpa3Sae({
				driverAdvertisesSae: phyCaps.driverAdvertisesSae,
				supplicantPresent,
				nmcliSae,
			}),
			regulatory,
		});
	}

	cache = {
		byPhy,
		byIfname,
		ifnameKey: ifnameKeyOf(ifnames),
		computedAtMs: nowMs,
		selfManaged,
	};
}

/**
 * Re-read the per-adapter capability set.
 *
 * Single-flight and never throws: this runs inside the Wi-Fi device sweep, and
 * a failed read is a statement about the READ. A SPAWN failure therefore leaves
 * the previous derivation standing (the hardware did not change), while a PARSE
 * failure drops it (the shape we knew how to read is gone).
 */
export async function refreshWifiCapabilities(
	ifnames: readonly string[],
	opts?: { force?: boolean },
): Promise<void> {
	lastIfnames = [...ifnames];
	if (ifnames.length === 0) {
		cache = undefined;
		return;
	}

	const nowMs = deps.now();
	const key = ifnameKeyOf(ifnames);
	if (
		opts?.force !== true &&
		cache !== undefined &&
		cache.ifnameKey === key &&
		!isStale(cache, nowMs)
	) {
		return;
	}

	if (inFlight !== undefined) return inFlight;

	inFlight = computeCapabilities(ifnames)
		.catch((err) => {
			logger.debug(`wifi capabilities: refresh failed: ${err}`);
		})
		.finally(() => {
			inFlight = undefined;
		});
	return inFlight;
}

/**
 * The capability set for ONE interface, resolved through its wiphy — never
 * through its position in any list.
 *
 * Synchronous because the wire builder is (`policy-route-check.ts` precedent).
 * A stale answer schedules the next read in the background instead of blocking
 * a broadcast, which is what bounds a self-managed wiphy's drift.
 */
export function getWifiCapabilitiesForInterface(
	ifname: string,
): WifiAdapterCapabilities | undefined {
	if (cache === undefined) return undefined;
	if (isStale(cache, deps.now())) {
		void refreshWifiCapabilities(lastIfnames);
	}
	const phy = cache.byIfname.get(ifname);
	if (phy === undefined) return undefined;
	return cache.byPhy.get(phy);
}

/**
 * READ-AFTER-WRITE hook for a regulatory change.
 *
 * `iw reg set` is a HINT. A self-managed wiphy intersects or ignores it, so the
 * only honest report is the domain observed afterwards — which means a forced
 * re-read rather than stamping the requested country onto the cached values.
 */
export async function refreshWifiCapabilitiesAfterRegulatoryChange(): Promise<void> {
	await refreshWifiCapabilities(lastIfnames, { force: true });
}
