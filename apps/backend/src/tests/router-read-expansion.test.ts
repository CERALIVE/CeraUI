/*
 * Expanded READ-ONLY telemetry for the ZTE and UFI dialects (todo 23).
 *
 * Todo 20 normalized the SIGNAL; this covers the rest of what those two vendor
 * APIs state about themselves — network type, operator, serving cell, band,
 * the UFI's WAN/SIM identifiers, its radio mode and its product record.
 *
 * Two properties are the point of the file, and both are asserted rather than
 * described:
 *
 *  1. THE ZTE READS STAY ONE REQUEST. `goform_get_cmd_process` takes a
 *     `multi_data` key list, so every field this dialect publishes arrives in a
 *     single GET on a 30 s cadence. A per-field request would multiply the
 *     slowest probe in the module by the number of fields for no new
 *     information.
 *  2. NEITHER DIALECT GAINS A WRITE. The fence is behavioural AND structural:
 *     every request each probe issues is inspected, the exported surface is
 *     enumerated, and the module source is greped (comment-stripped, so the
 *     prose may name the verbs it refuses).
 *
 * Fixture provenance: the bodies are the phase-B captures recorded in
 * `.omo/notepads/modem-stack-phase-b/learnings.md` (the ZTE `multi_data` reply
 * with and without its `Referer`, and the UFI `getoverview`/`getallstatus`/
 * `getapninfo`/`getnetworkmode` payloads read over `curl --interface`). Keys the
 * bench units answered EMPTY are carried verbatim; where a bench unit could not
 * state a value at all — every unit on that bench arrived SIM-less, so no
 * capture exists in which a serving cell is reported — the fixture is labelled
 * SHAPE-DERIVED and only the values are supplied.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	parseUfi,
	parseZte,
	probeRouterCellularAdmin,
	type RouterAdminProbeDeps,
	UFI_READ_COMMANDS,
	ZTE_READ_KEYS,
} from "../modules/network/router-cellular-admin.ts";
import * as routerDetails from "../modules/network/router-details.ts";
import {
	parseUfiDetails,
	parseZteDetails,
} from "../modules/network/router-details.ts";

const BACKEND_SRC = join(import.meta.dir, "..");

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * The bench MF79U's reply, with the four detail keys added. SHAPE-DERIVED: the
 * captured unit is SIM-less and answered every one of these as `""` (the
 * blank-field capture below is the real one), so the key names and their
 * envelope come from the device and the values do not.
 */
const ZTE_REGISTERED = JSON.stringify({
	modem_main_state: "modem_init_complete",
	ppp_status: "ppp_connected",
	signalbar: "4",
	apn_name: "internet",
	network_type: "LTE",
	network_provider: "Claro",
	cell_id: "134318388",
	lte_band: "B4",
});

/** VERBATIM: the SIM-less bench unit's reply WITH the required `Referer`. */
const ZTE_BLANK = JSON.stringify({
	modem_main_state: "modem_sim_undetected",
	ppp_status: "ppp_disconnected",
	signalbar: "",
	apn_name: "",
	network_type: "",
	network_provider: "",
	cell_id: "",
	lte_band: "",
});

const UFI_SHELL =
	"<!DOCTYPE html><html><head><title>4G UFI</title></head><body></body></html>";

/**
 * VERBATIM (phase-B): `getoverview` on `enx020754023235`. `WANIP`/`IMSI`/
 * `ICCID` are the device's own `-` placeholder for "not set", which is exactly
 * what must NOT reach an operator as a reading.
 */
const UFI_OVERVIEW = JSON.stringify({
	reply: "ok",
	params: {
		SYSVER: "UFI_HM_SIM1_V020_251125",
		HWVER: "HW1.0",
		IMEI: "868837088254863",
		SSID: "4G-UFI-611A",
		WANIP: "-",
		IMSI: "-",
		ICCID: "-",
		WEBVER: "WEB1.1",
		SIGNAL: -96,
	},
});

/** VERBATIM (phase-B): `getallstatus`. */
const UFI_STATUS = JSON.stringify({
	reply: "ok",
	params: {
		signalStrength: -96,
		carrier: "无服务。",
		internetState: "disconnected",
		imsi: "-",
		simCardState: "invalid",
		wifiapstatus: "on",
	},
});

/** VERBATIM (phase-B): `getnetworkmode`. */
const UFI_NETWORK_MODE = JSON.stringify({
	reply: "ok",
	params: { netmode: "1" },
});

/** VERBATIM (phase-B): `getapninfo`. */
const UFI_APN = JSON.stringify({
	reply: "ok",
	params: {
		apnlist: [{ apn: "none", apnname: "none", auth: "none" }],
		apncurrent: 0,
	},
});

/**
 * SHAPE-DERIVED: phase-B recorded that `getproduceinfo` "returned a well-formed
 * command response" without transcribing its keys, so the reader tries the
 * plausible spellings and this fixture exercises one of them.
 */
const UFI_PRODUCE_INFO = JSON.stringify({
	reply: "ok",
	params: { product: "HM-UFI-01", sn: "c6125db3" },
});

const UFI_SESSION_OUT = JSON.stringify({ reply: "SessionOut" });
const UFI_LOGIN_OK = JSON.stringify({ reply: "ok", session: "sess-1" });

// ── ZTE: one batched request, and the fields it brings back ─────────────────

describe("the ZTE reads stay ONE multi_data request", () => {
	it("asks for every detail key on the single existing GET", async () => {
		const urls: string[][] = [];
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				"default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103",
			fetchViaInterface: async (_ifname, requested) => {
				urls.push([...requested]);
				return [ZTE_REGISTERED];
			},
			postViaInterface: async () => {
				throw new Error("the ZTE dialect must never POST");
			},
		};

		await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "19d2:1405"]]),
			deps,
		);

		expect(urls).toHaveLength(1);
		expect(urls[0]).toHaveLength(1);
		const url = urls[0]?.[0] ?? "";
		expect(url).toContain("multi_data=1");
		for (const key of [
			"network_type",
			"network_provider",
			"cell_id",
			"lte_band",
		]) {
			expect(ZTE_READ_KEYS.split(",")).toContain(key);
			expect(url).toContain(key);
		}
	});

	it("reads the detail fields the device stated", () => {
		expect(parseZteDetails(ZTE_REGISTERED)).toEqual({
			network_type: "LTE",
			provider: "Claro",
			cell_id: "134318388",
			band: "B4",
		});
	});

	it("accepts the alternate spellings without inventing a second request", () => {
		const alternate = JSON.stringify({ provider: "Movistar", band: "B28" });
		expect(parseZteDetails(alternate)).toEqual({
			provider: "Movistar",
			band: "B28",
		});
	});

	it("reports NOTHING for the SIM-less capture, rather than empty strings", () => {
		expect(parseZteDetails(ZTE_BLANK)).toBeUndefined();
	});

	it("reports nothing for a body this dialect cannot read", () => {
		expect(parseZteDetails("<html>login</html>")).toBeUndefined();
		expect(parseZteDetails("")).toBeUndefined();
	});

	it("hangs the block off the reading, and omits it when the device said nothing", () => {
		expect(parseZte("http://192.168.0.1", ZTE_REGISTERED).details).toEqual({
			network_type: "LTE",
			provider: "Claro",
			cell_id: "134318388",
			band: "B4",
		});
		expect(parseZte("http://192.168.0.1", ZTE_BLANK).details).toBeUndefined();
	});
});

// ── UFI: the four catalog commands, read on the existing session ────────────

describe("the UFI reads cover the catalog commands", () => {
	it("asks for getproduceinfo beside the commands it already read", () => {
		for (const cmd of [
			"getoverview",
			"getapninfo",
			"getnetworkmode",
			"getproduceinfo",
		]) {
			expect(UFI_READ_COMMANDS as readonly string[]).toContain(cmd);
		}
	});

	it("reads what the device stated and drops its `-` placeholder", () => {
		expect(
			parseUfiDetails({
				overview: UFI_OVERVIEW,
				status: UFI_STATUS,
				networkMode: UFI_NETWORK_MODE,
				produceInfo: UFI_PRODUCE_INFO,
			}),
		).toEqual({
			provider: "无服务。",
			network_mode: "1",
			ssid: "4G-UFI-611A",
			product: "HM-UFI-01",
		});
	});

	it("carries the WAN and SIM identifiers once the device states them", () => {
		const overview = JSON.stringify({
			reply: "ok",
			params: {
				SSID: "4G-UFI-611A",
				WANIP: "10.64.12.9",
				IMSI: "732101234567890",
				ICCID: "8957011234567890123",
			},
		});
		expect(parseUfiDetails({ overview })).toEqual({
			ssid: "4G-UFI-611A",
			wan_ip: "10.64.12.9",
			imsi: "732101234567890",
			iccid: "8957011234567890123",
		});
	});

	it("reports nothing for a refused session or an unreadable body", () => {
		expect(
			parseUfiDetails({ overview: UFI_SESSION_OUT, status: UFI_SESSION_OUT }),
		).toBeUndefined();
		expect(parseUfiDetails({ overview: "<html>404</html>" })).toBeUndefined();
		expect(parseUfiDetails({})).toBeUndefined();
	});

	it("hangs the block off the reading", () => {
		const reading = parseUfi("http://192.168.100.1", {
			shell: UFI_SHELL,
			overview: UFI_OVERVIEW,
			status: UFI_STATUS,
			apn: UFI_APN,
			networkMode: UFI_NETWORK_MODE,
			produceInfo: UFI_PRODUCE_INFO,
		});
		expect(reading.details).toEqual({
			provider: "无服务。",
			network_mode: "1",
			ssid: "4G-UFI-611A",
			product: "HM-UFI-01",
		});
	});
});

// ── the auth flows are the ones already established ─────────────────────────

describe("a UFI session expiry re-authenticates ONCE, then answers honestly", () => {
	function ufiDeps(logins: string[], commands: string[]): RouterAdminProbeDeps {
		return {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				"default via 192.168.100.1 dev enx020754023235 proto dhcp src 192.168.100.100 metric 100",
			fetchViaInterface: async () => [UFI_SHELL],
			postViaInterface: async (_ifname, _url, body) => {
				const parsed = JSON.parse(body) as { cmdid: string };
				if (parsed.cmdid === "login") {
					logins.push(body);
					return UFI_LOGIN_OK;
				}
				commands.push(parsed.cmdid);
				return UFI_SESSION_OUT;
			},
		};
	}

	it("opens exactly two sessions and reports no fabricated detail", async () => {
		const logins: string[] = [];
		const commands: string[] = [];
		const readings = await probeRouterCellularAdmin(
			new Map([["enx020754023235", "05c6:9024"]]),
			ufiDeps(logins, commands),
		);

		expect(logins).toHaveLength(2);
		const reading = readings.get("enx020754023235");
		expect(reading?.reachable).toBe(true);
		expect(reading?.details).toBeUndefined();
		expect(reading?.signal?.dbm).toEqual({
			state: "unknown",
			reason: "auth-expired",
		});
	});

	it("reports an unreachable dongle when the re-auth itself fails", async () => {
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				"default via 192.168.100.1 dev enx020754023235 proto dhcp src 192.168.100.100 metric 100",
			fetchViaInterface: async () => [UFI_SHELL],
			postViaInterface: async () => JSON.stringify({ reply: "failed" }),
		};

		const readings = await probeRouterCellularAdmin(
			new Map([["enx020754023235", "05c6:9024"]]),
			deps,
		);
		const reading = readings.get("enx020754023235");
		expect(reading?.reachable).toBe(false);
		expect(reading?.details).toBeUndefined();
	});
});

// ── the read-only fence ─────────────────────────────────────────────────────

describe("the ZTE and UFI dialects stay read-only", () => {
	/** Scan CODE, never prose — the module header names the verbs it refuses. */
	function stripComments(source: string): string {
		return source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^[ \t]*\/\/.*$/gm, "");
	}

	const SCANNED = ["router-cellular-admin.ts", "router-details.ts"].map(
		(name) => [name, join(BACKEND_SRC, "modules", "network", name)] as const,
	);

	const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
		{ label: "the ZTE set endpoint", re: /goform_set_cmd_process/ },
		{ label: "a ZTE SET_ verb", re: /SET_[A-Z_]+/ },
		{ label: "the ZTE connect verb", re: /CONNECT_NETWORK/ },
		{ label: "the UFI usb-tether setter", re: /sethimiusbtether/ },
		{ label: "any UFI set* command", re: /["'`]set[a-z]+["'`]/ },
	];

	for (const [name, path] of SCANNED) {
		it(`names no write verb in ${name}`, () => {
			const code = stripComments(readFileSync(path, "utf8"));
			for (const { label, re } of FORBIDDEN) {
				expect({ file: name, hit: re.test(code), label }).toEqual({
					file: name,
					hit: false,
					label,
				});
			}
		});
	}

	it("exports nothing that could mutate a dongle", () => {
		const exported = Object.keys(routerDetails).sort();
		expect(exported.length).toBeGreaterThan(0);
		for (const name of exported) {
			expect({
				name,
				mutating:
					/^(set|write|apply|send|post|configure|enable|disable|update|reset)/i.test(
						name,
					),
			}).toEqual({ name, mutating: false });
		}
	});

	it("issues only reads for the UFI, and only a GET for the ZTE", async () => {
		const posted: string[] = [];
		const fetched: string[] = [];
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				[
					"default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103",
					"default via 192.168.100.1 dev enx020754023235 proto dhcp src 192.168.100.100 metric 104",
				].join("\n"),
			fetchViaInterface: async (_ifname, urls) => {
				fetched.push(...urls);
				return urls.map(() =>
					urls[0]?.includes("goform") ? ZTE_REGISTERED : UFI_SHELL,
				);
			},
			postViaInterface: async (_ifname, _url, body) => {
				const parsed = JSON.parse(body) as { cmdid: string };
				posted.push(parsed.cmdid);
				return parsed.cmdid === "login"
					? UFI_LOGIN_OK
					: JSON.stringify({ reply: "ok", params: {} });
			},
		};

		await probeRouterCellularAdmin(
			new Map([
				["enx344b50000000", "19d2:1405"],
				["enx020754023235", "05c6:9024"],
			]),
			deps,
		);

		for (const cmdid of posted) {
			expect({
				cmdid,
				read: cmdid === "login" || cmdid.startsWith("get"),
			}).toEqual({
				cmdid,
				read: true,
			});
		}
		for (const url of fetched) {
			expect({ url, write: url.includes("goform_set_cmd_process") }).toEqual({
				url,
				write: false,
			});
		}
	});
});
