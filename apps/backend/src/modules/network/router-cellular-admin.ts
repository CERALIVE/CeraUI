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
 * Router-mode dongle admin probe (todo 53).
 *
 * A dongle classified `router-cellular` runs its own embedded router, so
 * ModemManager sees nothing and this stack has no radio telemetry for it. What
 * it DOES have is the dongle's own LAN-side HTTP admin API, and that API is
 * reachable, unauthenticated and scriptable from the board — measured on the
 * bench, not assumed:
 *
 *   Huawei HiLink `12d1:*`  GET /api/webserver/SesTokInfo → session + token,
 *                           then /api/device/information, /api/monitoring/status,
 *                           /api/dialup/profiles (XML).
 *   ZTE            `19d2:*` GET /goform/goform_get_cmd_process?multi_data=1 (JSON).
 *   Qualcomm UFI   `05c6:9024` POST /himiapi/json (session login), then
 *                  getoverview, getsysinfo, getallstatus, getapninfo and
 *                  getnetworkmode (JSON). The root HTML is only the SPA shell.
 *
 * ── WHAT THIS MODULE WRITES, AND WHY ONLY THAT (todo 56) ────────────────────
 *
 * Todo 53 shipped this read-only, because at that point no write had been shown
 * to take effect. Todo 56 re-probed both vendors far more widely and the answer
 * came back SPLIT, so the shipped surface is split the same way:
 *
 *   HiLink `12d1:*` — TWO settings are PROVEN writable, by round-trip on both
 *     bench units: `/api/dialup/mobile-dataswitch` (`dataswitch` 1→0→1) and
 *     `/api/dialup/connection` (`RoamAutoConnectEnable` 0→1→0). Each write was
 *     re-READ afterwards and the device reported the new value. Better still,
 *     writing one twin left the other at its old value, so the control is
 *     per-unit and not a broadcast to whatever answers 192.168.8.1 first.
 *     `/api/net/net-mode` is NOT shipped as a WRITE: it answers error `112008`
 *     on a SIM-less unit, so its success could not be observed and it stays
 *     out. Todo 22 Stage A added the READ half beside it — `net-mode-list` plus
 *     `net-mode`, both GETs, published as `capabilities` so the operator is
 *     told what the firmware advertises and, when it refuses, that it refuses
 *     (`router-capabilities.ts`).
 *
 * ── THIS MODULE READS. `router-cellular-control.ts` WRITES (todo 22 Stage B) ──
 *
 * Stage B moved every write out: `applyRouterCellularControl`, the net-mode
 * write it added, and the LAN-subnet hygiene operation all live in
 * `router-cellular-control.ts` / `router-subnet-hygiene.ts`, over the shared
 * session helper in `hilink-session.ts`. That split is the extraction todos 20,
 * 23 and 22-Stage-A each recorded as owed and each deferred to whichever todo
 * touched the write path — this one. What is left here is the probe, the
 * parsers, and the cache; nothing in this file mutates a dongle.
 *
 *   ZTE `19d2:*` — NOTHING is writable on the bench firmware
 *     (`BD_XCBZHKMF79UV1.0.0B03`) and this is a measurement, not caution. Its
 *     `goform_set_cmd_process` accepts requests unauthenticated — proven, since
 *     `SET_WEB_LANGUAGE` round-trips en→es→en — yet every operator-meaningful
 *     verb (`SET_BEARER_PREFERENCE`, `SET_CONNECTION_MODE`, `SET_MAX_IDEL_TIME`,
 *     `SET_WIFI_SSID1_SETTINGS`, `CONNECT_NETWORK`) answers
 *     `{"result":"failure"}`, and every one of their read keys is an empty
 *     string on this OEM build. So the ZTE ships ZERO controls: shipping a web-UI
 *     LANGUAGE switch as a CeraLive "modem setting" would be the fabricated
 *     control this project refuses, just dressed as a real one.
 *
 * Qualcomm UFI was inspected against the linked manifest/vendor bundle on the
 * bench. It uses the `himiapi/json` command API rather than the common
 * `/api/...` or `/goform/...` dialects. The reader publishes the fields the
 * device actually returned: firmware, hardware revision, IMEI, SIM state,
 * connection state and current APN. Its USB-tether setter was also observed to
 * remove the bound RNDIS interface (`1` → successful `0` response → interface
 * disappeared), but the required post-write read-back could not be completed
 * after the device disabled its only management path. It therefore remains
 * deliberately absent from `controls`.
 *
 * A write is NEVER reported applied on the strength of the vendor's own
 * `<response>OK</response>`. It is applied when a subsequent READ of the same
 * field returns the requested value, and refused otherwise.
 *
 * ── WHY `curl`, AND WHY NOT `fetch` ──────────────────────────────────────────
 *
 * The two HiLink units ship ONE factory MAC and one factory LAN subnet, so the
 * host holds `192.168.8.100` twice and BOTH dongles answer on `192.168.8.1`.
 * Addressing one specifically therefore needs SO_BINDTODEVICE, which is what
 * `curl --interface <ifname>` does and which Node/Bun's HTTP client cannot
 * express — `localAddress` is identical for the pair. Proven on the bench: the
 * same request bound to each interface returned two DIFFERENT serials.
 *
 * Safety contract, identical in shape to `policy-route-check.ts`:
 *   - gated on `isRealDevice()`; a dev host never spawns anything;
 *   - EVERY failure (spawn error, timeout, non-200, malformed body) degrades to
 *     an absent or unreachable reading and never throws into a caller;
 *   - it runs on its OWN slow cadence, never inside the 5 s netif poll.
 *
 * The parsers are pure and exported so they can be tested over captured bench
 * bodies; the effectful surface is injected via {@link RouterAdminProbeDeps}.
 */

import { logger } from "../../helpers/logger.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { SAFE_IFNAME_RE } from "./device-bound-probe.ts";
import {
	HILINK_CONNECTION_PATH,
	HILINK_DATA_SWITCH_PATH,
	HILINK_NET_MODE_LIST_PATH,
	HILINK_NET_MODE_PATH,
	HILINK_SIGNAL_PATH,
	hilinkHeaders,
	openHilinkSession,
} from "./hilink-session.ts";
import {
	parseHilinkCapabilities,
	type RouterAdminCapabilities,
} from "./router-capabilities.ts";
import {
	parseHilinkDetails,
	parseUfiDetails,
	parseZteDetails,
	type RouterAdminDetails,
	ZTE_DETAIL_KEYS,
} from "./router-details.ts";
import {
	carryForwardStaleSignals,
	hilinkAuthRefused,
	parseHilinkSignal,
	parseUfiSignal,
	parseZteSignal,
	type RouterSignalModel,
	unreachableSignal,
} from "./router-signal.ts";
import { xmlValue } from "./vendor-xml.ts";

export type RouterAdminSim = "absent" | "present" | "unknown";
export type RouterAdminConnection =
	| "connected"
	| "connecting"
	| "disconnected"
	| "unknown";

/**
 * The settings this build has PROVEN it can write on the device in front of it.
 *
 * Presence of this object is the capability claim, and it is only ever built
 * from values the device just reported — never defaulted. A dialect with no
 * proven write (the ZTE) omits it entirely, so "no controls" and "controls that
 * happen to be off" can never be confused by a reader.
 */
export type RouterAdminControls = {
	/** `/api/dialup/mobile-dataswitch` — the dongle's own mobile-data switch. */
	mobile_data: boolean;
	/** `/api/dialup/connection` `RoamAutoConnectEnable`. */
	roaming_autoconnect: boolean;
};

/** What the dongle's own admin API told us, normalized across vendors. */
export type RouterAdminReading = {
	/** The dongle's LAN-side web UI — its default gateway, read from `ip route`. */
	admin_url: string;
	/** MEASURED, never assumed: the probe got an HTTP response back. */
	reachable: boolean;
	model?: string;
	/** Vendor device serial — the only thing that tells two same-model twins apart. */
	serial?: string;
	/**
	 * The radio's IMEI as the dongle reports it. Unlike the serial this is
	 * globally unique and stamped on the hardware, so it is the identifier an
	 * operator can match against the physical unit in their hand.
	 */
	imei?: string;
	/** Vendor firmware build string (HiLink `SoftwareVersion`, ZTE `wa_inner_version`). */
	firmware?: string;
	/** Vendor hardware revision, where the device publishes one. */
	hardware?: string;
	sim?: RouterAdminSim;
	connection?: RouterAdminConnection;
	signal_bars?: number;
	signal_max_bars?: number;
	apn?: string;
	/**
	 * The normalized per-dialect signal model (todo 20). It supersedes the two
	 * bar scalars above for every new consumer: those can only carry a scale one
	 * of the three dialects publishes, and they cannot say WHY a number is
	 * missing. Both are kept because the shipped detail surface renders them.
	 */
	signal?: RouterSignalModel;
	/**
	 * The non-signal fields the device stated about itself (todo 23) — network
	 * type, operator, serving cell, band, and the UFI's WAN/SIM/product record.
	 * ABSENT when the device stated none of them, never an empty object.
	 */
	details?: RouterAdminDetails;
	/**
	 * What this firmware said it CAN discuss, DISCOVERED before anything is
	 * offered (todo 22 Stage A). Read-only: a capability is a reading, and this
	 * build ships no network-mode write for any firmware — see
	 * `router-capabilities.ts`.
	 */
	capabilities?: RouterAdminCapabilities;
	/** Absent unless this dialect has a write proven on real hardware. */
	controls?: RouterAdminControls;
};

/** Vendor dialects this module knows how to read. */
export type RouterAdminDialect = "hilink" | "zte" | "ufi";

const DIALECT_BY_VENDOR_ID: Readonly<Record<string, RouterAdminDialect>> = {
	"12d1": "hilink",
	"19d2": "zte",
	"05c6": "ufi",
};

/**
 * Kernel interface names only — this value reaches an argv. Shared with the
 * WAN-side device-bound probe so the two `curl --interface` sites can never
 * disagree about what a name may be.
 */
const IFNAME_RE = SAFE_IFNAME_RE;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Written by `curl -w` after EVERY transfer, so one spawn can carry N URLs. */
const BODY_SEPARATOR = "<<<CERA-ADMIN-SPLIT>>>";

const UFI_API_PATH = "/himiapi/json";
const UFI_DEFAULT_LOGIN = JSON.stringify({
	cmdid: "login",
	username: "admin",
	password: "admin",
});

export const UFI_READ_COMMANDS = [
	"getoverview",
	"getsysinfo",
	"getallstatus",
	"getapninfo",
	"getnetworkmode",
	"gethimiusbtether",
	"getproduceinfo",
] as const;

/**
 * Every key the ZTE dialect reads, in one `multi_data` request. `model_name`,
 * `imei` and `wa_inner_version` are what let this device be NAMED per unit —
 * without them two MF79Us are the same word on screen. The four radio keys and
 * todo 23's detail keys are READS that ride this SAME request rather than one
 * of their own; this dialect ships no writes at all (see the module header).
 */
export const ZTE_READ_KEYS = [
	"modem_main_state",
	"ppp_status",
	"signalbar",
	"apn_name",
	"model_name",
	"imei",
	"wa_inner_version",
	"rssi",
	"lte_rsrp",
	"lte_rsrq",
	"lte_snr",
	...ZTE_DETAIL_KEYS,
].join(",");

export function dialectForVidPid(
	vidPid: string,
): RouterAdminDialect | undefined {
	const vendor = vidPid.split(":")[0]?.toLowerCase();
	return vendor === undefined ? undefined : DIALECT_BY_VENDOR_ID[vendor];
}

/**
 * `ip -4 route show default` → interface name → gateway address.
 *
 * The gateway IS the dongle's admin address — deriving it from the routing
 * table rather than hardcoding `192.168.8.1` is what keeps this working for a
 * vendor, firmware or user-reconfigured subnet nobody here has seen.
 */
export function parseDefaultGateways(
	stdout: string,
): ReadonlyMap<string, string> {
	const gateways = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const match = /^default\s+via\s+(\S+)\s+dev\s+(\S+)/.exec(line.trim());
		const gateway = match?.[1];
		const ifname = match?.[2];
		if (gateway === undefined || ifname === undefined) continue;
		if (!IPV4_RE.test(gateway) || gateways.has(ifname)) continue;
		gateways.set(ifname, gateway);
	}
	return gateways;
}

/**
 * Huawei `SimStatus`. Only the codes this project can justify are mapped: `1` is
 * the documented valid-SIM value, and `0`/`255` were BOTH observed on bench
 * units with the tray physically empty. Anything else stays `unknown` rather
 * than being folded into the nearest neighbour.
 */
function hilinkSim(code: string | undefined): RouterAdminSim {
	if (code === "1") return "present";
	if (code === "0" || code === "255") return "absent";
	return "unknown";
}

function hilinkConnection(code: string | undefined): RouterAdminConnection {
	if (code === "901") return "connected";
	if (code === "900") return "connecting";
	if (code === "902" || code === "903") return "disconnected";
	return "unknown";
}

function toBars(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The vendor spells every boolean as the STRING `"1"`/`"0"`. Only those two are
 * accepted: an absent or unparsable field means the device did not report the
 * setting, and defaulting it to `false` would render a toggle that claims the
 * device said "off" when it said nothing at all.
 */
function hilinkFlag(raw: string | undefined): boolean | undefined {
	if (raw === "1") return true;
	if (raw === "0") return false;
	return undefined;
}

export function parseHilinkControls(
	dataSwitch: string,
	connection: string,
): RouterAdminControls | undefined {
	const mobileData = hilinkFlag(xmlValue(dataSwitch, "dataswitch"));
	const roaming = hilinkFlag(xmlValue(connection, "RoamAutoConnectEnable"));
	if (mobileData === undefined || roaming === undefined) return undefined;
	return { mobile_data: mobileData, roaming_autoconnect: roaming };
}

/**
 * The bodies one HiLink read cycle collects. They arrive as one object rather
 * than six positional strings because six same-typed arguments in a row is a
 * silent mis-ordering waiting to happen — and adding `signal` to the tail is
 * exactly the edit that would have caused one.
 */
export type HilinkBodies = {
	readonly information: string;
	readonly status: string;
	readonly profiles?: string;
	readonly dataSwitch?: string;
	readonly connection?: string;
	readonly signal?: string;
	/** `/api/net/net-mode-list` — the firmware's own network-mode catalog. */
	readonly netModeList?: string;
	/** `/api/net/net-mode` — which entry of that catalog is selected. */
	readonly netMode?: string;
};

export function parseHilink(
	adminUrl: string,
	bodies: HilinkBodies,
): RouterAdminReading {
	const { information, status } = bodies;
	const profiles = bodies.profiles ?? "";
	const reading: RouterAdminReading = {
		admin_url: adminUrl,
		reachable: true,
		sim: hilinkSim(xmlValue(status, "SimStatus")),
		connection: hilinkConnection(xmlValue(status, "ConnectionStatus")),
		signal: parseHilinkSignal({ status, signal: bodies.signal ?? "" }),
	};
	const model = xmlValue(information, "DeviceName");
	if (model !== undefined) reading.model = model;
	const serial = xmlValue(information, "SerialNumber");
	if (serial !== undefined) reading.serial = serial;
	const imei = xmlValue(information, "Imei");
	if (imei !== undefined) reading.imei = imei;
	const firmware = xmlValue(information, "SoftwareVersion");
	if (firmware !== undefined) reading.firmware = firmware;
	const hardware = xmlValue(information, "HardwareVersion");
	if (hardware !== undefined) reading.hardware = hardware;
	const bars = toBars(xmlValue(status, "SignalIcon"));
	if (bars !== undefined) reading.signal_bars = bars;
	const maxBars = toBars(xmlValue(status, "maxsignal"));
	if (maxBars !== undefined) reading.signal_max_bars = maxBars;
	const apn = parseHilinkActiveApn(profiles);
	if (apn !== undefined) reading.apn = apn;
	const details = parseHilinkDetails({
		information,
		signal: bodies.signal ?? "",
	});
	if (details !== undefined) reading.details = details;
	// Discovery lands in the SAME reading as `controls`, so no consumer can ever
	// render a control for a setting whose capability had not been read yet.
	if (bodies.netModeList !== undefined) {
		reading.capabilities = parseHilinkCapabilities({
			netModeList: bodies.netModeList,
			netMode: bodies.netMode ?? "",
		});
	}
	const controls = parseHilinkControls(
		bodies.dataSwitch ?? "",
		bodies.connection ?? "",
	);
	if (controls !== undefined) reading.controls = controls;
	return reading;
}

/**
 * The APN of the profile the dongle says is CURRENT — a device may hold several
 * and reporting the first would name one it is not using.
 */
export function parseHilinkActiveApn(profiles: string): string | undefined {
	const current = xmlValue(profiles, "CurrentProfile");
	for (const block of profiles.split("<Profile>").slice(1)) {
		const index = xmlValue(block, "Index");
		if (current !== undefined && index !== current) continue;
		return xmlValue(block, "ApnName");
	}
	return undefined;
}

function zteSim(state: string | undefined): RouterAdminSim {
	if (state === undefined) return "unknown";
	if (state === "modem_sim_undetected" || state === "modem_sim_destroy")
		return "absent";
	if (
		state === "modem_init_complete" ||
		state === "modem_waitpin" ||
		state === "modem_waitpuk"
	)
		return "present";
	return "unknown";
}

function zteConnection(state: string | undefined): RouterAdminConnection {
	if (state === "ppp_connected") return "connected";
	if (state === "ppp_connecting") return "connecting";
	if (state === "ppp_disconnected") return "disconnected";
	return "unknown";
}

export function parseZte(adminUrl: string, body: string): RouterAdminReading {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return {
			admin_url: adminUrl,
			reachable: true,
			signal: parseZteSignal(body),
		};
	}
	const read = (key: string): string | undefined => {
		const value = parsed[key];
		return typeof value === "string" && value.trim() !== ""
			? value.trim()
			: undefined;
	};

	const reading: RouterAdminReading = {
		admin_url: adminUrl,
		reachable: true,
		sim: zteSim(read("modem_main_state")),
		connection: zteConnection(read("ppp_status")),
		signal: parseZteSignal(body),
	};
	const bars = toBars(read("signalbar"));
	if (bars !== undefined) reading.signal_bars = bars;
	if (bars !== undefined) reading.signal_max_bars = 5;
	const apn = read("apn_name");
	if (apn !== undefined) reading.apn = apn;
	const model = read("model_name");
	if (model !== undefined) reading.model = model;
	const imei = read("imei");
	if (imei !== undefined) reading.imei = imei;
	const firmware = read("wa_inner_version");
	if (firmware !== undefined) reading.firmware = firmware;
	const details = parseZteDetails(body);
	if (details !== undefined) reading.details = details;
	// NO `controls` here, ever — see this module's header. Every ZTE `set` verb
	// worth an operator's attention answered `{"result":"failure"}` on the bench
	// firmware, so this dialect has no proven write to claim.
	return reading;
}

function ufiString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

function parseUfiJson(body: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return undefined;
		}
		return value as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function ufiParams(body: string): Record<string, unknown> | undefined {
	const parsed = parseUfiJson(body);
	const params = parsed?.params;
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		return undefined;
	}
	return params as Record<string, unknown>;
}

/**
 * `getallstatus`'s `simCardState`. `"ok"` is what the firmware answers for a
 * seated card — board-measured on `UFI_HM_SIM1_V016_240828` beside a real IMSI
 * and ICCID — so knowing only `"valid"` reported a present SIM as `unknown`,
 * i.e. no SIM segment on the row at all. `"invalid"` is the vendor's own failure
 * value (its bundled UI is a single `"invalid" === simCardState` test).
 *
 * That UI treats every OTHER value as a good card; this does not, so a firmware
 * that grows a distinct locked state reads as unread rather than as healthy —
 * the positive-evidence rule the HiLink and ZTE parsers already follow.
 */
function ufiSim(value: string | undefined): RouterAdminSim {
	if (value === "invalid") return "absent";
	if (value === "ok" || value === "valid") return "present";
	return "unknown";
}

function ufiConnection(value: string | undefined): RouterAdminConnection {
	if (value === "connected") return "connected";
	if (value === "connecting") return "connecting";
	if (value === "disconnected") return "disconnected";
	return "unknown";
}

/** One UFI read cycle's command responses, keyed by the command that made them. */
export type UfiBodies = {
	readonly shell: string;
	readonly overview?: string;
	readonly sysinfo?: string;
	readonly status?: string;
	readonly apn?: string;
	readonly networkMode?: string;
	readonly usbTether?: string;
	readonly produceInfo?: string;
};

/** Parse the JSON command responses from the bench's HiMI UFI firmware. */
export function parseUfi(
	adminUrl: string,
	bodies: UfiBodies,
): RouterAdminReading {
	const status = bodies.status ?? "";
	const title = /<title>\s*([^<]+?)\s*<\/title>/i
		.exec(bodies.shell)?.[1]
		?.trim();
	const overviewData = ufiParams(bodies.overview ?? "");
	const statusData = ufiParams(status);
	const apnData = ufiParams(bodies.apn ?? "");
	const reading: RouterAdminReading = {
		admin_url: adminUrl,
		reachable: true,
		sim: ufiSim(ufiString(statusData?.simCardState)),
		connection: ufiConnection(ufiString(statusData?.internetState)),
		signal: parseUfiSignal({
			sysinfo: bodies.sysinfo ?? "",
			overview: bodies.overview ?? "",
			status,
		}),
	};
	const model = title;
	if (model !== undefined && model !== "") reading.model = model;
	const imei = ufiString(overviewData?.IMEI);
	if (imei !== undefined) reading.imei = imei;
	const firmware = ufiString(overviewData?.SYSVER);
	if (firmware !== undefined) reading.firmware = firmware;
	const hardware = ufiString(overviewData?.HWVER);
	if (hardware !== undefined) reading.hardware = hardware;
	const details = parseUfiDetails({
		overview: bodies.overview ?? "",
		status,
		networkMode: bodies.networkMode ?? "",
		produceInfo: bodies.produceInfo ?? "",
		sysinfo: bodies.sysinfo ?? "",
	});
	if (details !== undefined) reading.details = details;
	const currentApn = ufiString(apnData?.apn);
	if (currentApn !== undefined) {
		reading.apn = currentApn;
	} else {
		const profiles = apnData?.apnlist;
		if (Array.isArray(profiles)) {
			const index = apnData?.apncurrent;
			const profile = profiles[index === 0 ? 0 : -1];
			if (
				typeof profile === "object" &&
				profile !== null &&
				!Array.isArray(profile)
			) {
				const profileApn = ufiString(profile.apn);
				if (profileApn !== undefined) reading.apn = profileApn;
			}
		}
	}
	return reading;
}

export type RouterAdminProbeDeps = {
	isRealDevice: () => Promise<boolean>;
	/** `ip -4 route show default` → stdout. MAY reject. */
	runIpRouteShowDefault: () => Promise<string>;
	/**
	 * Fetch one or more URLs bound to `ifname`, resolving the bodies in order.
	 * Rejects on spawn failure; a non-2xx transfer resolves an empty body.
	 */
	fetchViaInterface: (
		ifname: string,
		urls: readonly string[],
		headers?: readonly string[],
	) => Promise<readonly string[]>;
	/** POST one body to one URL, bound to `ifname`. Same failure posture. */
	postViaInterface: (
		ifname: string,
		url: string,
		body: string,
		headers?: readonly string[],
	) => Promise<string>;
};

async function spawnCurl(
	ifname: string,
	urls: readonly string[],
	headers: readonly string[] = [],
): Promise<readonly string[]> {
	if (!IFNAME_RE.test(ifname)) {
		throw new Error(`refusing to bind curl to a suspect ifname: ${ifname}`);
	}
	const argv = [
		"curl",
		"--silent",
		"--interface",
		ifname,
		"--max-time",
		"5",
		"--write-out",
		`\n${BODY_SEPARATOR}\n`,
	];
	for (const header of headers) argv.push("--header", header);
	argv.push(...urls);

	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`curl exited with code ${proc.exitCode}`);
	}
	return stdout
		.split(BODY_SEPARATOR)
		.slice(0, urls.length)
		.map((body) => body.trim());
}

async function spawnCurlPost(
	ifname: string,
	url: string,
	body: string,
	headers: readonly string[] = [],
): Promise<string> {
	if (!IFNAME_RE.test(ifname)) {
		throw new Error(`refusing to bind curl to a suspect ifname: ${ifname}`);
	}
	const argv = [
		"curl",
		"--silent",
		"--interface",
		ifname,
		"--max-time",
		"8",
		"--header",
		"Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
	];
	for (const header of headers) argv.push("--header", header);
	argv.push("--data-raw", body, url);

	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`curl exited with code ${proc.exitCode}`);
	}
	return stdout.trim();
}

export const defaultRouterAdminProbeDeps: RouterAdminProbeDeps = {
	isRealDevice: () => isRealDevice(),
	runIpRouteShowDefault: async () => {
		const proc = Bun.spawn(["ip", "-4", "route", "show", "default"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		if (proc.exitCode !== 0) {
			throw new Error(`ip route show default exited ${proc.exitCode}`);
		}
		return stdout;
	},
	fetchViaInterface: spawnCurl,
	postViaInterface: spawnCurlPost,
};

type DialectProbe = {
	readonly ifname: string;
	readonly adminUrl: string;
	readonly deps: RouterAdminProbeDeps;
};

/**
 * How many times ONE read cycle may authenticate. This is the module's existing
 * canon written down rather than a new policy: every cycle already opens its own
 * session, because a HiLink verification token is single-use and the UFI session
 * expires server-side. So a cycle whose reads come back REFUSED re-authenticates
 * exactly once and retries — a second refusal is a statement about the device,
 * not about a token, and retrying past it is how a 30 s poll becomes a loop.
 */
const AUTH_ATTEMPTS_PER_CYCLE = 2;

async function openUfiSession(
	probe: DialectProbe,
): Promise<string | undefined> {
	const login = await probe.deps.postViaInterface(
		probe.ifname,
		`${probe.adminUrl}${UFI_API_PATH}`,
		UFI_DEFAULT_LOGIN,
		["Content-Type: application/json;charset=UTF-8"],
	);
	const data = parseUfiJson(login);
	return ufiString(data?.reply) === "ok" ? ufiString(data?.session) : undefined;
}

function ufiSessionExpired(body: string): boolean {
	return ufiString(parseUfiJson(body)?.reply) === "SessionOut";
}

async function probeUfi(
	probe: DialectProbe,
): Promise<RouterAdminReading | undefined> {
	let shell: string | undefined;
	let responses: readonly string[] | undefined;

	for (let attempt = 0; attempt < AUTH_ATTEMPTS_PER_CYCLE; attempt += 1) {
		const session = await openUfiSession(probe);
		if (session === undefined) return undefined;
		if (shell === undefined) {
			[shell] = await probe.deps.fetchViaInterface(probe.ifname, [
				`${probe.adminUrl}/`,
			]);
			if (shell === undefined || shell === "") return undefined;
		}
		responses = await Promise.all(
			UFI_READ_COMMANDS.map((cmdid) =>
				probe.deps.postViaInterface(
					probe.ifname,
					`${probe.adminUrl}${UFI_API_PATH}`,
					JSON.stringify({ cmdid, sessionId: session }),
					[
						`Authorization: ${session}`,
						"Content-Type: application/json;charset=UTF-8",
					],
				),
			),
		);
		if (!responses.some(ufiSessionExpired)) break;
	}
	if (shell === undefined || responses === undefined) return undefined;

	const [overview, sysinfo, status, apn, networkMode, usbTether, produceInfo] =
		responses;
	return parseUfi(probe.adminUrl, {
		shell,
		overview: overview ?? "",
		sysinfo: sysinfo ?? "",
		status: status ?? "",
		apn: apn ?? "",
		networkMode: networkMode ?? "",
		usbTether: usbTether ?? "",
		produceInfo: produceInfo ?? "",
	});
}

async function probeZte(
	probe: DialectProbe,
): Promise<RouterAdminReading | undefined> {
	const [body] = await probe.deps.fetchViaInterface(
		probe.ifname,
		[
			`${probe.adminUrl}/goform/goform_get_cmd_process?isTest=false&multi_data=1&cmd=${ZTE_READ_KEYS}`,
		],
		// The Referer is REQUIRED, not decorative. Measured on the bench MF79U:
		// without it the endpoint answers 200 with every field an empty string —
		// a well-formed reply that says nothing, which reads as a device with
		// nothing to report rather than as a refused request.
		[`Referer: ${probe.adminUrl}/index.html`],
	);
	return body === undefined || body === ""
		? undefined
		: parseZte(probe.adminUrl, body);
}

async function probeHilink(
	probe: DialectProbe,
): Promise<RouterAdminReading | undefined> {
	const urls = [
		`${probe.adminUrl}/api/device/information`,
		`${probe.adminUrl}/api/monitoring/status`,
		`${probe.adminUrl}/api/dialup/profiles`,
		`${probe.adminUrl}${HILINK_DATA_SWITCH_PATH}`,
		`${probe.adminUrl}${HILINK_CONNECTION_PATH}`,
		`${probe.adminUrl}${HILINK_SIGNAL_PATH}`,
		`${probe.adminUrl}${HILINK_NET_MODE_LIST_PATH}`,
		`${probe.adminUrl}${HILINK_NET_MODE_PATH}`,
	];
	let bodies: readonly (string | undefined)[] | undefined;
	for (let attempt = 0; attempt < AUTH_ATTEMPTS_PER_CYCLE; attempt += 1) {
		const session = await openHilinkSession(
			probe.ifname,
			probe.adminUrl,
			probe.deps,
		);
		if (session === undefined) return undefined;
		bodies = await probe.deps.fetchViaInterface(
			probe.ifname,
			urls,
			hilinkHeaders(session),
		);
		const refused = bodies.some(
			(body) => body !== undefined && hilinkAuthRefused(body),
		);
		if (!refused) break;
	}

	const [
		information,
		status,
		profiles,
		dataSwitch,
		connection,
		signal,
		netModeList,
		netMode,
	] = bodies ?? [];
	if (information === undefined || status === undefined) return undefined;
	return parseHilink(probe.adminUrl, {
		information,
		status,
		profiles: profiles ?? "",
		dataSwitch: dataSwitch ?? "",
		connection: connection ?? "",
		signal: signal ?? "",
		netModeList: netModeList ?? "",
		netMode: netMode ?? "",
	});
}

async function probeDialect(
	probe: DialectProbe,
	dialect: RouterAdminDialect,
): Promise<RouterAdminReading | undefined> {
	if (dialect === "ufi") return probeUfi(probe);
	if (dialect === "zte") return probeZte(probe);
	return probeHilink(probe);
}

/**
 * A reading for a dongle whose admin API said nothing. The signal model is
 * still built, because "unreachable" is an answer an operator can act on and an
 * ABSENT model is not — and it is built PER DIALECT, so a quantity the vendor
 * API could never express stays `unsupported` rather than being blamed on the
 * outage.
 */
function unreadableReading(
	adminUrl: string,
	dialect: RouterAdminDialect | undefined,
): RouterAdminReading {
	return dialect === undefined
		? { admin_url: adminUrl, reachable: false }
		: {
				admin_url: adminUrl,
				reachable: false,
				signal: unreachableSignal(dialect),
			};
}

/**
 * Probe every classified dongle once.
 *
 * A device whose vendor dialect is unknown still yields a reading: the admin
 * URL is a routing fact, and "its own web interface is at <address>" is the
 * honest answer for a vendor whose API nobody here has read.
 */
export async function probeRouterCellularAdmin(
	targets: ReadonlyMap<string, string>,
	deps: RouterAdminProbeDeps = defaultRouterAdminProbeDeps,
): Promise<ReadonlyMap<string, RouterAdminReading>> {
	const readings = new Map<string, RouterAdminReading>();
	if (targets.size === 0) return readings;
	if (!(await deps.isRealDevice())) return readings;

	let gateways: ReadonlyMap<string, string>;
	try {
		gateways = parseDefaultGateways(await deps.runIpRouteShowDefault());
	} catch (error) {
		logger.debug("router-cellular admin probe: no default routes", { error });
		return readings;
	}

	for (const [ifname, vidPid] of targets) {
		const gateway = gateways.get(ifname);
		if (gateway === undefined) continue;
		const adminUrl = `http://${gateway}`;
		const dialect = dialectForVidPid(vidPid);
		try {
			const reading =
				dialect === undefined
					? undefined
					: await probeDialect({ ifname, adminUrl, deps }, dialect);
			readings.set(ifname, reading ?? unreadableReading(adminUrl, dialect));
		} catch (error) {
			logger.debug("router-cellular admin probe failed", { ifname, error });
			readings.set(ifname, unreadableReading(adminUrl, dialect));
		}
	}
	return readings;
}

let cachedReadings: ReadonlyMap<string, RouterAdminReading> = new Map();

export async function refreshRouterCellularAdmin(
	targets: ReadonlyMap<string, string>,
	deps: RouterAdminProbeDeps = defaultRouterAdminProbeDeps,
): Promise<boolean> {
	const before = signatureOf(cachedReadings);
	cachedReadings = carryForwardStaleSignals(
		cachedReadings,
		await probeRouterCellularAdmin(targets, deps),
	);
	return signatureOf(cachedReadings) !== before;
}

function signatureOf(
	readings: ReadonlyMap<string, RouterAdminReading>,
): string {
	return [...readings]
		.map(([ifname, reading]) => `${ifname}:${JSON.stringify(reading)}`)
		.sort()
		.join("|");
}

export function getRouterCellularAdmin(
	ifname: string,
): RouterAdminReading | undefined {
	return cachedReadings.get(ifname);
}

export function resetRouterCellularAdmin(): void {
	cachedReadings = new Map();
}
