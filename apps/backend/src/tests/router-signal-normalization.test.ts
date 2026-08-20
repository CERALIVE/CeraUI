/**
 * Normalized router-dongle signal model (todo 20).
 *
 * ── WHERE THE FIXTURES COME FROM ────────────────────────────────────────────
 *
 * Every payload marked CAPTURED below is a verbatim body one of the bench
 * dongles returned to `curl --interface` from the board, recorded in phase-B's
 * RB-9 fleet inventory and in this phase's todo-2 hardware sweep. Nothing about
 * a vendor dialect is defensible from anything else.
 *
 * The bench's three HiLink/ZTE units are ALL SIM-LESS (`SimStatus 255`,
 * `modem_sim_undetected`), so no capture exists in which a radio metric carries
 * a value — every captured `<rsrp>` is an EMPTY element. That is exactly the
 * degraded case this todo exists to report honestly, so it is tested verbatim.
 * The handful of POPULATED bodies below are marked SHAPE-DERIVED: element/key
 * names, nesting and unit suffixes are taken from the captured envelope, only
 * the numbers are supplied. They are never presented as bench readings.
 *
 * ── WHAT THE SUITE IS FOR ───────────────────────────────────────────────────
 *
 * One rule, asserted from every angle: a metric is `known` only when the device
 * stated it. A field the dialect cannot express, a field the device left blank,
 * a body that would not parse, a refused session, and an admin API that never
 * answered are FIVE distinct `unknown` reasons — and none of them is ever `0`.
 */
import { describe, expect, it } from "bun:test";
import {
	parseHilink,
	parseUfi,
	parseZte,
	probeRouterCellularAdmin,
	type RouterAdminProbeDeps,
	type RouterAdminReading,
} from "../modules/network/router-cellular-admin.ts";
import { applyRouterCellularControl } from "../modules/network/router-cellular-control.ts";
import {
	authExpiredSignal,
	carryForwardStaleSignals,
	markSignalStale,
	parseHilinkSignal,
	parseUfiSignal,
	parseZteSignal,
	type RouterSignalMetric,
	type RouterSignalModel,
	unreachableSignal,
} from "../modules/network/router-signal.ts";

// ── CAPTURED — HiLink twin via `eth1`, todo-2 sweep §8 ──────────────────────
const HILINK_STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<ConnectionStatus>902</ConnectionStatus>
<WifiConnectionStatus></WifiConnectionStatus>
<SignalStrength>0</SignalStrength>
<SignalIcon>0</SignalIcon>
<CurrentNetworkType>19</CurrentNetworkType>
<ServiceStatus>1</ServiceStatus>
<SimStatus>255</SimStatus>
<CurrentNetworkTypeEx>101</CurrentNetworkTypeEx>
<maxsignal>5</maxsignal>
<classify>hilink</classify>
</response>`;

// CAPTURED — every radio element is present and EMPTY on the SIM-less unit.
const HILINK_SIGNAL_BLANK = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<pci></pci>
<sc></sc>
<cell_id></cell_id>
<rsrq></rsrq>
<rsrp></rsrp>
<rssi></rssi>
<sinr></sinr>
<rscp></rscp>
<ecio></ecio>
<psatt></psatt>
<mode></mode>
<lte_bandwidth></lte_bandwidth>
<lte_bandinfo></lte_bandinfo>
</response>`;

// CAPTURED — what every HiLink endpoint answers without a session token.
const HILINK_AUTH_REFUSED = `<?xml version="1.0" encoding="UTF-8"?>
<error>
<code>125002</code>
<message></message>
</error>`;

// SHAPE-DERIVED from HILINK_SIGNAL_BLANK: same elements, same vendor unit
// suffixes, numbers supplied. NOT a bench reading — both twins are SIM-less.
const HILINK_SIGNAL_REGISTERED = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<pci>142</pci>
<cell_id>134318388</cell_id>
<rsrq>-9dB</rsrq>
<rsrp>-93dBm</rsrp>
<rssi>-71dBm</rssi>
<sinr>12dB</sinr>
<mode>7</mode>
</response>`;

// ── CAPTURED — ZTE MF79U goform, WITH the required Referer ──────────────────
const ZTE_BENCH = `{"modem_main_state":"modem_sim_undetected","ppp_status":"ppp_disconnected","signalbar":"","apn_name":""}`;

// CAPTURED — the same endpoint WITHOUT the Referer: HTTP 200, every field blank.
const ZTE_BLANK_REFUSED = `{"modem_main_state":"","ppp_status":"","signalbar":"","apn_name":""}`;

// SHAPE-DERIVED: the wave-1 key catalog (`signalbar`, `rssi`, `lte_rsrp`,
// `lte_rsrq`, `lte_snr`) carried on the captured envelope.
const ZTE_REGISTERED = `{"modem_main_state":"modem_init_complete","ppp_status":"ppp_connected","signalbar":"4","rssi":"-67","lte_rsrp":"-95","lte_rsrq":"-11","lte_snr":"8"}`;

// ── CAPTURED — Qualcomm/HiMI UFI `POST /himiapi/json`, phase-B todo 69 ──────
const UFI_SYSINFO = `{"reply":"ok","params":{"bsid":"25002","cellid":134318388,"cputemp":57,"wifinum":0,"ethnum":0,"SIGNAL":-96}}`;
const UFI_OVERVIEW = `{"reply":"ok","params":{"SYSVER":"UFI_HM_SIM1_V020_251125","HWVER":"HW1.0","IMEI":"868837088254863","SSID":"4G-UFI-611A","WANIP":"-","IMSI":"-","ICCID":"-","WEBVER":"WEB1.1","SIGNAL":-96}}`;
const UFI_STATUS = `{"reply":"ok","params":{"signalStrength":-96,"carrier":"无服务。","internetState":"disconnected","imsi":"-","simCardState":"invalid","wifiapstatus":"on"}}`;
// CAPTURED — what every himiapi command answers before login / after expiry.
const UFI_SESSION_OUT = `{"reply":"SessionOut"}`;
const UFI_SHELL =
	"<!DOCTYPE html><html><head><title>4G UFI</title></head><body><div id=app></div></body></html>";

const known = (value: number): RouterSignalMetric => ({
	state: "known",
	value,
});
const unknown = (
	reason: Extract<RouterSignalMetric, { state: "unknown" }>["reason"],
): RouterSignalMetric => ({ state: "unknown", reason });

const METRICS = [
	"bars",
	"max_bars",
	"dbm",
	"rsrp",
	"rsrq",
	"snr",
	"sinr",
] as const;

/** Nothing may be reported as a number the device did not state. */
function assertNoFabrication(model: RouterSignalModel): void {
	for (const id of METRICS) {
		const metric = model[id];
		if (metric.state === "known") continue;
		expect(metric).not.toHaveProperty("value");
	}
}

describe("HiLink signal normalization", () => {
	it("reads the bar count and the device's OWN scale from monitoring/status", () => {
		const model = parseHilinkSignal({
			status: HILINK_STATUS,
			signal: HILINK_SIGNAL_REGISTERED,
		});

		expect(model.provenance).toBe("hilink-admin-api");
		expect(model.freshness).toBe("live");
		expect(model.bars).toEqual(known(0));
		expect(model.max_bars).toEqual(known(5));
	});

	it("reads the radio quantities from device/signal, unit suffixes stripped", () => {
		const model = parseHilinkSignal({
			status: HILINK_STATUS,
			signal: HILINK_SIGNAL_REGISTERED,
		});

		expect(model.dbm).toEqual(known(-71));
		expect(model.rsrp).toEqual(known(-93));
		expect(model.rsrq).toEqual(known(-9));
		expect(model.sinr).toEqual(known(12));
	});

	it("reports snr as UNSUPPORTED — this dialect publishes sinr and no snr", () => {
		const model = parseHilinkSignal({
			status: HILINK_STATUS,
			signal: HILINK_SIGNAL_REGISTERED,
		});

		expect(model.snr).toEqual(unknown("unsupported"));
	});

	it("degraded: an EMPTY element is not-reported, never zero (bench capture)", () => {
		const model = parseHilinkSignal({
			status: HILINK_STATUS,
			signal: HILINK_SIGNAL_BLANK,
		});

		expect(model.freshness).toBe("live");
		expect(model.dbm).toEqual(unknown("not-reported"));
		expect(model.rsrp).toEqual(unknown("not-reported"));
		expect(model.rsrq).toEqual(unknown("not-reported"));
		expect(model.sinr).toEqual(unknown("not-reported"));
		assertNoFabrication(model);
	});

	it("degraded: auth expiry on ONE endpoint spoils only that endpoint's fields", () => {
		const model = parseHilinkSignal({
			status: HILINK_STATUS,
			signal: HILINK_AUTH_REFUSED,
		});

		expect(model.freshness).toBe("live");
		expect(model.bars).toEqual(known(0));
		expect(model.max_bars).toEqual(known(5));
		expect(model.dbm).toEqual(unknown("auth-expired"));
		expect(model.rsrp).toEqual(unknown("auth-expired"));
		expect(model.rsrq).toEqual(unknown("auth-expired"));
		expect(model.sinr).toEqual(unknown("auth-expired"));
	});

	it("degraded: auth expiry on BOTH endpoints leaves nothing fresh to report", () => {
		const model = parseHilinkSignal({
			status: HILINK_AUTH_REFUSED,
			signal: HILINK_AUTH_REFUSED,
		});

		expect(model.freshness).toBe("unknown");
		expect(model.bars).toEqual(unknown("auth-expired"));
		expect(model.max_bars).toEqual(unknown("auth-expired"));
		expect(model.dbm).toEqual(unknown("auth-expired"));
		assertNoFabrication(model);
	});

	it("degraded: a partial payload spoils only the field it truncated", () => {
		const partial = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<rsrq>-9dB</rsrq>
<rsrp>n/a</rsrp>
</response>`;
		const model = parseHilinkSignal({ status: HILINK_STATUS, signal: partial });

		expect(model.rsrq).toEqual(known(-9));
		expect(model.rsrp).toEqual(unknown("malformed"));
		// Elements the truncated document never carried are simply unstated.
		expect(model.dbm).toEqual(unknown("not-reported"));
		expect(model.sinr).toEqual(unknown("not-reported"));
	});

	it("degraded: a body that is not the vendor's XML at all reports nothing fresh", () => {
		const model = parseHilinkSignal({ status: "", signal: "" });

		expect(model.freshness).toBe("unknown");
		expect(model.bars).toEqual(unknown("not-reported"));
		assertNoFabrication(model);
	});
});

describe("ZTE signal normalization", () => {
	it("reads the bar count and the vendor's fixed 5-bar scale", () => {
		const model = parseZteSignal(ZTE_REGISTERED);

		expect(model.provenance).toBe("zte-goform");
		expect(model.freshness).toBe("live");
		expect(model.bars).toEqual(known(4));
		expect(model.max_bars).toEqual(known(5));
	});

	it("reads rssi/lte_rsrp/lte_rsrq as their own quantities", () => {
		const model = parseZteSignal(ZTE_REGISTERED);

		expect(model.dbm).toEqual(known(-67));
		expect(model.rsrp).toEqual(known(-95));
		expect(model.rsrq).toEqual(known(-11));
	});

	it("maps lte_snr to snr and leaves sinr UNSUPPORTED — they are not the same figure", () => {
		const model = parseZteSignal(ZTE_REGISTERED);

		expect(model.snr).toEqual(known(8));
		expect(model.sinr).toEqual(unknown("unsupported"));
	});

	it("degraded: the bench unit's blank signalbar yields no bars AND no scale", () => {
		const model = parseZteSignal(ZTE_BENCH);

		expect(model.freshness).toBe("live");
		expect(model.bars).toEqual(unknown("not-reported"));
		// The 5-bar scale explains a bar count; with none, stating it explains nothing.
		expect(model.max_bars).toEqual(unknown("not-reported"));
		assertNoFabrication(model);
	});

	it("degraded: the refused-but-200 reply reports unknown, not a reading", () => {
		const model = parseZteSignal(ZTE_BLANK_REFUSED);

		expect(model.bars).toEqual(unknown("not-reported"));
		expect(model.dbm).toEqual(unknown("not-reported"));
		expect(model.rsrp).toEqual(unknown("not-reported"));
		assertNoFabrication(model);
	});

	it("degraded: a partial payload keeps the keys it carried and no others", () => {
		const model = parseZteSignal(`{"signalbar":"3","apn_name":"internet"}`);

		expect(model.bars).toEqual(known(3));
		expect(model.max_bars).toEqual(known(5));
		expect(model.dbm).toEqual(unknown("not-reported"));
		expect(model.rsrp).toEqual(unknown("not-reported"));
		expect(model.snr).toEqual(unknown("not-reported"));
	});

	it("degraded: a non-JSON body (a login page) is malformed, not empty", () => {
		const model = parseZteSignal("<html>login</html>");

		expect(model.freshness).toBe("unknown");
		expect(model.bars).toEqual(unknown("malformed"));
		expect(model.dbm).toEqual(unknown("malformed"));
		expect(model.sinr).toEqual(unknown("unsupported"));
		assertNoFabrication(model);
	});

	it("degraded: a non-numeric bar count is malformed, never coerced", () => {
		const model = parseZteSignal(`{"signalbar":"good"}`);

		expect(model.bars).toEqual(unknown("malformed"));
		expect(model.max_bars).toEqual(unknown("not-reported"));
	});
});

describe("Qualcomm UFI signal normalization", () => {
	it("reads the getsysinfo SIGNAL field as dBm (bench: -96)", () => {
		const model = parseUfiSignal({
			sysinfo: UFI_SYSINFO,
			overview: UFI_OVERVIEW,
			status: UFI_STATUS,
		});

		expect(model.provenance).toBe("ufi-himiapi");
		expect(model.freshness).toBe("live");
		expect(model.dbm).toEqual(known(-96));
	});

	it("falls back to getoverview SIGNAL when getsysinfo carries none", () => {
		const model = parseUfiSignal({
			sysinfo: `{"reply":"ok","params":{"cputemp":57}}`,
			overview: UFI_OVERVIEW,
			status: UFI_STATUS,
		});

		expect(model.dbm).toEqual(known(-96));
	});

	it("falls back to getallstatus signalStrength when neither carries SIGNAL", () => {
		const model = parseUfiSignal({
			sysinfo: `{"reply":"ok","params":{"cputemp":57}}`,
			overview: `{"reply":"ok","params":{"HWVER":"HW1.0"}}`,
			status: UFI_STATUS,
		});

		expect(model.dbm).toEqual(known(-96));
	});

	it("reports EVERY other quantity as unsupported — this dialect has no bar scale", () => {
		const model = parseUfiSignal({
			sysinfo: UFI_SYSINFO,
			overview: UFI_OVERVIEW,
			status: UFI_STATUS,
		});

		expect(model.bars).toEqual(unknown("unsupported"));
		expect(model.max_bars).toEqual(unknown("unsupported"));
		expect(model.rsrp).toEqual(unknown("unsupported"));
		expect(model.rsrq).toEqual(unknown("unsupported"));
		expect(model.snr).toEqual(unknown("unsupported"));
		expect(model.sinr).toEqual(unknown("unsupported"));
		assertNoFabrication(model);
	});

	it("degraded: SessionOut on every command is auth expiry, not a dead radio", () => {
		const model = parseUfiSignal({
			sysinfo: UFI_SESSION_OUT,
			overview: UFI_SESSION_OUT,
			status: UFI_SESSION_OUT,
		});

		expect(model.freshness).toBe("unknown");
		expect(model.dbm).toEqual(unknown("auth-expired"));
		assertNoFabrication(model);
	});

	it("degraded: an answered command that omits the field is not-reported", () => {
		const model = parseUfiSignal({
			sysinfo: `{"reply":"ok","params":{"cputemp":57}}`,
			overview: `{"reply":"ok","params":{"HWVER":"HW1.0"}}`,
			status: `{"reply":"ok","params":{"simCardState":"invalid"}}`,
		});

		expect(model.freshness).toBe("live");
		expect(model.dbm).toEqual(unknown("not-reported"));
	});

	it("degraded: a non-JSON command response is malformed", () => {
		const model = parseUfiSignal({
			sysinfo: "<html>error</html>",
			overview: "",
			status: "",
		});

		expect(model.freshness).toBe("unknown");
		expect(model.dbm).toEqual(unknown("malformed"));
	});
});

describe("degraded whole-device readings", () => {
	it("an unreachable admin API is unknown ACROSS THE BOARD, per dialect", () => {
		const hilink = unreachableSignal("hilink");
		expect(hilink.freshness).toBe("unknown");
		for (const id of METRICS) {
			if (id === "snr") continue;
			expect(hilink[id]).toEqual(unknown("unreachable"));
		}
		// The dialect boundary survives unreachability: HiLink still has no snr.
		expect(hilink.snr).toEqual(unknown("unsupported"));
		assertNoFabrication(hilink);
	});

	it("an unreachable UFI keeps its unsupported fields unsupported", () => {
		const ufi = unreachableSignal("ufi");

		expect(ufi.dbm).toEqual(unknown("unreachable"));
		expect(ufi.bars).toEqual(unknown("unsupported"));
		expect(ufi.rsrp).toEqual(unknown("unsupported"));
	});

	it("a refused session is reported as auth expiry, distinctly from unreachable", () => {
		const zte = authExpiredSignal("zte");

		expect(zte.freshness).toBe("unknown");
		expect(zte.bars).toEqual(unknown("auth-expired"));
		expect(zte.sinr).toEqual(unknown("unsupported"));
	});

	it("markSignalStale changes freshness and nothing else", () => {
		const live = parseZteSignal(ZTE_REGISTERED);
		const stale = markSignalStale(live);

		expect(stale.freshness).toBe("stale");
		expect({ ...stale, freshness: live.freshness }).toEqual(live);
	});
});

describe("stale carry-forward", () => {
	const reading = (
		signal: RouterSignalModel | undefined,
		reachable: boolean,
	) => {
		const base: RouterAdminReading = {
			admin_url: "http://192.168.0.1",
			reachable,
		};
		return signal === undefined ? base : { ...base, signal };
	};

	it("a failed cycle re-serves the previous LIVE reading, marked stale", () => {
		const live = parseZteSignal(ZTE_REGISTERED);
		const merged = carryForwardStaleSignals(
			new Map([["enx0", reading(live, true)]]),
			new Map([["enx0", reading(unreachableSignal("zte"), false)]]),
		);

		const next = merged.get("enx0");
		expect(next?.reachable).toBe(false);
		expect(next?.signal?.freshness).toBe("stale");
		expect(next?.signal?.bars).toEqual(known(4));
	});

	it("a SECOND failed cycle drops it — stale is bounded to one cycle", () => {
		const live = parseZteSignal(ZTE_REGISTERED);
		const first = carryForwardStaleSignals(
			new Map([["enx0", reading(live, true)]]),
			new Map([["enx0", reading(unreachableSignal("zte"), false)]]),
		);
		const second = carryForwardStaleSignals(
			first,
			new Map([["enx0", reading(unreachableSignal("zte"), false)]]),
		);

		expect(second.get("enx0")?.signal?.freshness).toBe("unknown");
		expect(second.get("enx0")?.signal?.bars).toEqual(unknown("unreachable"));
	});

	it("a REACHABLE reading is never overwritten by the previous cycle", () => {
		const previous = parseZteSignal(ZTE_REGISTERED);
		const fresh = parseZteSignal(ZTE_BENCH);
		const merged = carryForwardStaleSignals(
			new Map([["enx0", reading(previous, true)]]),
			new Map([["enx0", reading(fresh, true)]]),
		);

		expect(merged.get("enx0")?.signal).toEqual(fresh);
	});
});

describe("the normalized model reaches the reading", () => {
	it("HiLink carries its signal beside the legacy bar fields", () => {
		const reading = parseHilink("http://192.168.8.1", {
			information: "<response><DeviceName>E3372</DeviceName></response>",
			status: HILINK_STATUS,
			signal: HILINK_SIGNAL_REGISTERED,
		});

		expect(reading.signal_bars).toBe(0);
		expect(reading.signal_max_bars).toBe(5);
		expect(reading.signal?.rsrp).toEqual(known(-93));
		expect(reading.signal?.provenance).toBe("hilink-admin-api");
	});

	it("ZTE carries its signal", () => {
		const reading = parseZte("http://192.168.0.1", ZTE_REGISTERED);

		expect(reading.signal?.bars).toEqual(known(4));
		expect(reading.signal?.snr).toEqual(known(8));
	});

	it("UFI gains a SIGNAL reading it previously discarded", () => {
		const reading = parseUfi("http://192.168.100.1", {
			shell: UFI_SHELL,
			overview: UFI_OVERVIEW,
			sysinfo: UFI_SYSINFO,
			status: UFI_STATUS,
		});

		expect(reading.signal?.dbm).toEqual(known(-96));
		// The dialect states no bar count, so the legacy fields stay ABSENT.
		expect(reading.signal_bars).toBeUndefined();
		expect(reading.signal_max_bars).toBeUndefined();
	});
});

describe("the ZTE and UFI read-only fence", () => {
	/**
	 * Todo 20 widened what these two dialects READ. This block is what stops the
	 * next widening from turning into a write: the fence is behavioural, so a
	 * mutation verb added to either dialect's command set fails HERE rather than
	 * in a review nobody ran.
	 */
	const readOnlyProbe = async (
		vidPid: string,
		gateway: string,
	): Promise<{ posted: string[]; fetched: string[] }> => {
		const posted: string[] = [];
		const fetched: string[] = [];
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				`default via ${gateway} dev enx0 proto dhcp metric 106 `,
			fetchViaInterface: async (_ifname, urls) => {
				fetched.push(...urls);
				return urls.map((url) => (url.endsWith("/") ? UFI_SHELL : ZTE_BENCH));
			},
			postViaInterface: async (_ifname, _url, body) => {
				posted.push(body);
				const request = JSON.parse(body) as { cmdid: string };
				return request.cmdid === "login"
					? `{"reply":"ok","session":"s1"}`
					: "{}";
			},
		};
		await probeRouterCellularAdmin(new Map([["enx0", vidPid]]), deps);
		return { posted, fetched };
	};

	it("the ZTE probe issues goform GET reads and never a set verb", async () => {
		const { posted, fetched } = await readOnlyProbe("19d2:1405", "192.168.0.1");

		expect(posted).toEqual([]);
		expect(fetched).toHaveLength(1);
		expect(fetched[0]).toContain("goform_get_cmd_process");
		expect(fetched[0]).not.toContain("goform_set_cmd_process");
		// The four radio keys this todo added are READS on that same GET.
		for (const key of [
			"signalbar",
			"rssi",
			"lte_rsrp",
			"lte_rsrq",
			"lte_snr",
		]) {
			expect(fetched[0]).toContain(key);
		}
	});

	it("every UFI command posted is a login or a get* read", async () => {
		const { posted } = await readOnlyProbe("05c6:9024", "192.168.100.1");

		expect(posted.length).toBeGreaterThan(1);
		for (const body of posted) {
			const { cmdid } = JSON.parse(body) as { cmdid: string };
			expect(cmdid === "login" || cmdid.startsWith("get")).toBe(true);
		}
	});

	it("a control write is refused for every dialect but HiLink", async () => {
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => {
				throw new Error("must not be reached");
			},
			fetchViaInterface: async () => {
				throw new Error("must not be reached");
			},
			postViaInterface: async () => {
				throw new Error("must not be reached");
			},
		};

		for (const vidPid of ["19d2:1405", "05c6:9024"]) {
			await expect(
				applyRouterCellularControl("enx0", vidPid, "mobile_data", true, deps),
			).resolves.toEqual({ status: "refused", reason: "unsupported" });
		}
	});
});

describe("probe-level degradation", () => {
	const gateway = "default via 192.168.8.1 dev eth1 proto dhcp metric 105 ";
	const SESSION = `<?xml version="1.0" encoding="UTF-8"?><response><SesInfo>SessionID=abc</SesInfo><TokInfo>tok</TokInfo></response>`;

	it("an unreachable admin API yields an all-unknown signal for its dialect", async () => {
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => gateway,
			fetchViaInterface: async () => {
				throw new Error("connection refused");
			},
			postViaInterface: async () => "",
		};

		const readings = await probeRouterCellularAdmin(
			new Map([["eth1", "12d1:14dc"]]),
			deps,
		);

		const reading = readings.get("eth1");
		expect(reading?.reachable).toBe(false);
		expect(reading?.signal?.freshness).toBe("unknown");
		expect(reading?.signal?.dbm).toEqual(unknown("unreachable"));
	});

	it("a HiLink whose session expired mid-read RE-AUTHS ONCE, then reports honestly", async () => {
		let sessions = 0;
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => gateway,
			fetchViaInterface: async (_ifname, urls) => {
				if (urls[0]?.endsWith("/api/webserver/SesTokInfo")) {
					sessions += 1;
					return [SESSION];
				}
				// The FIRST batch is refused; the retry behind a fresh session works.
				return sessions >= 2
					? [
							"<response><DeviceName>E3372</DeviceName></response>",
							HILINK_STATUS,
							"",
							"",
							"",
							HILINK_SIGNAL_REGISTERED,
						]
					: urls.map(() => HILINK_AUTH_REFUSED);
			},
			postViaInterface: async () => "",
		};

		const readings = await probeRouterCellularAdmin(
			new Map([["eth1", "12d1:14dc"]]),
			deps,
		);

		expect(sessions).toBe(2);
		expect(readings.get("eth1")?.signal?.rsrp).toEqual(known(-93));
	});

	it("a HiLink still refused after ONE re-auth reports auth expiry, not a retry loop", async () => {
		let sessions = 0;
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => gateway,
			fetchViaInterface: async (_ifname, urls) => {
				if (urls[0]?.endsWith("/api/webserver/SesTokInfo")) {
					sessions += 1;
					return [SESSION];
				}
				return urls.map(() => HILINK_AUTH_REFUSED);
			},
			postViaInterface: async () => "",
		};

		const readings = await probeRouterCellularAdmin(
			new Map([["eth1", "12d1:14dc"]]),
			deps,
		);

		expect(sessions).toBe(2);
		expect(readings.get("eth1")?.signal?.freshness).toBe("unknown");
		expect(readings.get("eth1")?.signal?.bars).toEqual(unknown("auth-expired"));
	});

	it("a UFI whose session expired mid-read RE-AUTHS ONCE", async () => {
		let logins = 0;
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				"default via 192.168.100.1 dev enx0 proto dhcp metric 106 ",
			fetchViaInterface: async () => [UFI_SHELL],
			postViaInterface: async (_ifname, _url, body) => {
				const request = JSON.parse(body) as { cmdid: string };
				if (request.cmdid === "login") {
					logins += 1;
					return `{"reply":"ok","session":"s${logins}"}`;
				}
				if (logins < 2) return UFI_SESSION_OUT;
				if (request.cmdid === "getsysinfo") return UFI_SYSINFO;
				if (request.cmdid === "getoverview") return UFI_OVERVIEW;
				if (request.cmdid === "getallstatus") return UFI_STATUS;
				return "{}";
			},
		};

		const readings = await probeRouterCellularAdmin(
			new Map([["enx0", "05c6:9024"]]),
			deps,
		);

		expect(logins).toBe(2);
		expect(readings.get("enx0")?.signal?.dbm).toEqual(known(-96));
	});
});
