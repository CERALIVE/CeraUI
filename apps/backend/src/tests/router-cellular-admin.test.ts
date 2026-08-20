/**
 * Router-dongle admin probe (todo 53).
 *
 * The bodies below are VERBATIM captures from the bench dongles' own admin
 * APIs, taken over `curl --interface` from the board — not hand-written
 * fixtures. That matters, because everything this probe claims about a device
 * is a claim about a specific vendor's HTTP dialect, and the only defensible
 * source for it is the device.
 *
 * The gate is honesty rather than coverage: a field the device did not state
 * must come back `undefined`, and a code the mapping cannot justify must come
 * back `unknown` instead of being folded into the nearest neighbour.
 */
import { describe, expect, it } from "bun:test";
import {
	dialectForVidPid,
	parseDefaultGateways,
	parseHilink,
	parseHilinkActiveApn,
	parseUfi,
	parseZte,
	probeRouterCellularAdmin,
	type RouterAdminProbeDeps,
	UFI_READ_COMMANDS,
} from "../modules/network/router-cellular-admin.ts";
import { applyRouterCellularControl } from "../modules/network/router-cellular-control.ts";

// Captured from `ip -4 route show default` on the bench board, which holds two
// default routes through ONE gateway because the HiLink pair ships one factory
// LAN subnet between them.
const ROUTE_OUTPUT = `default via 192.168.8.1 dev enx0c5b8f279a64 
default via 192.168.78.1 dev eth0 proto dhcp src 192.168.78.132 metric 101 
default via 192.168.0.1 dev enx344b50000000 proto dhcp src 192.168.0.169 metric 103 
default via 192.168.8.1 dev enx0c5b8f279a64 proto dhcp src 192.168.8.100 metric 104 
default via 192.168.8.1 dev eth1 proto dhcp src 192.168.8.100 metric 105 `;

const HILINK_INFORMATION = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<DeviceName>E3372</DeviceName>
<SerialNumber>Y4QDU17621000793</SerialNumber>
<Imei>866850029359669</Imei>
<Imsi></Imsi>
<HardwareVersion>CL2E3372HM</HardwareVersion>
<SoftwareVersion>22.333.01.00.00</SoftwareVersion>
<ProductFamily>LTE</ProductFamily>
<Classify>hilink</Classify>
<workmode>NO SERVICE</workmode>
<WanIPAddress></WanIPAddress>
</response>`;

const HILINK_STATUS = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<ConnectionStatus>902</ConnectionStatus>
<SignalStrength>0</SignalStrength>
<SignalIcon>0</SignalIcon>
<CurrentNetworkType>19</CurrentNetworkType>
<ServiceStatus>1</ServiceStatus>
<SimStatus>255</SimStatus>
<maxsignal>5</maxsignal>
<classify>hilink</classify>
</response>`;

const HILINK_PROFILES = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<CurrentProfile>1</CurrentProfile>
<Profiles>
<Profile>
<Index>1</Index>
<Name>Unicom</Name>
<ApnName>3gnet</ApnName>
<ReadOnly>2</ReadOnly>
</Profile>
</Profiles>
</response>`;

const ZTE_BODY = `{"modem_main_state":"modem_sim_undetected","ppp_status":"ppp_disconnected","signalbar":"","apn_name":""}`;

describe("dialect selection", () => {
	it("routes Huawei and ZTE to their own APIs and nothing else", () => {
		expect(dialectForVidPid("12d1:14dc")).toBe("hilink");
		expect(dialectForVidPid("19d2:1405")).toBe("zte");
		expect(dialectForVidPid("05c6:9024")).toBe("ufi");
		expect(dialectForVidPid("2c7c:0801")).toBeUndefined();
		expect(dialectForVidPid("")).toBeUndefined();
	});
});

describe("Qualcomm 4G UFI readings", () => {
	const UFI_SHELL =
		"<!DOCTYPE html><html><head><title>4G UFI</title></head><body><div id=app></div></body></html>";
	const UFI_OVERVIEW =
		'{"reply":"ok","params":{"SYSVER":"UFI_HM_SIM1_V020_251125","HWVER":"HW1.0","IMEI":"868837088254863"}}';
	const UFI_SYSINFO =
		'{"reply":"ok","params":{"sysruntime":13952,"bsid":"25002"}}';
	const UFI_STATUS =
		'{"reply":"ok","params":{"signalStrength":-96,"carrier":"无服务。","internetState":"disconnected","simCardState":"invalid"}}';
	const UFI_APN =
		'{"reply":"ok","params":{"apnlist":[{"apn":"none"}],"apncurrent":0}}';

	it("records the reachable read-only admin shell without inventing controls", () => {
		const reading = parseUfi("http://192.168.100.1", {
			shell: UFI_SHELL,
			overview: UFI_OVERVIEW,
			sysinfo: UFI_SYSINFO,
			status: UFI_STATUS,
			apn: UFI_APN,
		});

		expect(reading).toEqual({
			admin_url: "http://192.168.100.1",
			reachable: true,
			model: "4G UFI",
			imei: "868837088254863",
			firmware: "UFI_HM_SIM1_V020_251125",
			hardware: "HW1.0",
			sim: "absent",
			connection: "disconnected",
			apn: "none",
			// Todo 23. The ONLY non-signal field this capture states is the
			// carrier string, published verbatim — the device's own words, never
			// translated and never widened to the fields it said nothing about.
			details: { provider: "无服务。" },
			// Todo 20. The dialect publishes ONE scalar and no bar scale, so every
			// other quantity is `unsupported` rather than a fabricated zero.
			signal: {
				provenance: "ufi-himiapi",
				freshness: "live",
				bars: { state: "unknown", reason: "unsupported" },
				max_bars: { state: "unknown", reason: "unsupported" },
				dbm: { state: "known", value: -96 },
				rsrp: { state: "unknown", reason: "unsupported" },
				rsrq: { state: "unknown", reason: "unsupported" },
				snr: { state: "unknown", reason: "unsupported" },
				sinr: { state: "unknown", reason: "unsupported" },
			},
		});
		expect(reading.controls).toBeUndefined();
	});

	it("keeps empty and unrecognised command fields honest", () => {
		const reading = parseUfi("http://192.168.100.1", {
			shell: UFI_SHELL,
			overview: "{}",
			sysinfo: "{}",
			status: "{}",
			apn: "{}",
		});
		expect(reading.imei).toBeUndefined();
		expect(reading.sim).toBe("unknown");
		expect(reading.connection).toBe("unknown");
		expect(reading.apn).toBeUndefined();
	});
});

describe("default-gateway resolution", () => {
	it("reads the admin address from the routing table, per interface", () => {
		const gateways = parseDefaultGateways(ROUTE_OUTPUT);

		expect(gateways.get("enx0c5b8f279a64")).toBe("192.168.8.1");
		expect(gateways.get("enx344b50000000")).toBe("192.168.0.1");
		expect(gateways.get("eth1")).toBe("192.168.8.1");
	});

	it("ignores a malformed or non-IPv4 gateway rather than trusting it", () => {
		const gateways = parseDefaultGateways(
			"default via not-an-ip dev eth9\ndefault dev eth8\n",
		);
		expect(gateways.size).toBe(0);
	});
});

describe("HiLink readings", () => {
	const reading = parseHilink("http://192.168.8.1", {
		information: HILINK_INFORMATION,
		status: HILINK_STATUS,
		profiles: HILINK_PROFILES,
	});

	it("reports the SIM-less bench unit as having no SIM", () => {
		expect(reading.sim).toBe("absent");
		expect(reading.connection).toBe("disconnected");
	});

	it("carries the serial that separates the twin units", () => {
		expect(reading.serial).toBe("Y4QDU17621000793");
		expect(reading.model).toBe("E3372");
	});

	it("keeps the device's own scale with its bar count", () => {
		expect(reading.signal_bars).toBe(0);
		expect(reading.signal_max_bars).toBe(5);
	});

	it("takes the APN of the profile the device calls CURRENT", () => {
		expect(reading.apn).toBe("3gnet");
	});

	it("prefers the current profile over the first one listed", () => {
		const twoProfiles = `<response><CurrentProfile>2</CurrentProfile>
<Profile><Index>1</Index><ApnName>first</ApnName></Profile>
<Profile><Index>2</Index><ApnName>second</ApnName></Profile></response>`;
		expect(parseHilinkActiveApn(twoProfiles)).toBe("second");
	});

	it("leaves an unjustifiable SIM code unknown rather than guessing", () => {
		const odd = parseHilink("http://192.168.8.1", {
			information: HILINK_INFORMATION,
			status: HILINK_STATUS.replace(
				"<SimStatus>255</SimStatus>",
				"<SimStatus>3</SimStatus>",
			),
		});
		expect(odd.sim).toBe("unknown");
	});

	it("omits every field the device left empty", () => {
		const empty = parseHilink("http://192.168.8.1", {
			information: "<response/>",
			status: "<response/>",
		});

		expect(empty.model).toBeUndefined();
		expect(empty.serial).toBeUndefined();
		expect(empty.signal_bars).toBeUndefined();
		expect(empty.apn).toBeUndefined();
	});
});

describe("ZTE readings", () => {
	it("reads the bench unit's undetected SIM and idle PPP", () => {
		const reading = parseZte("http://192.168.0.1", ZTE_BODY);

		expect(reading.sim).toBe("absent");
		expect(reading.connection).toBe("disconnected");
		expect(reading.reachable).toBe(true);
	});

	it("omits the bar count the device returned empty", () => {
		const reading = parseZte("http://192.168.0.1", ZTE_BODY);

		expect(reading.signal_bars).toBeUndefined();
		expect(reading.signal_max_bars).toBeUndefined();
	});

	it("reports a locked SIM as PRESENT — it is in the tray", () => {
		expect(
			parseZte("http://192.168.0.1", '{"modem_main_state":"modem_waitpin"}')
				.sim,
		).toBe("present");
	});

	it("stays reachable-but-unread when the body is not JSON", () => {
		const reading = parseZte("http://192.168.0.1", "<html>login</html>");

		expect(reading.reachable).toBe(true);
		expect(reading.sim).toBeUndefined();
	});

	// The refused-request shape. It is NOT an error body — the device answers 200
	// with every field blank — so without the Referer below it reads as a modem
	// with nothing to say instead of as a request that was turned away.
	it("reports unknown, not a guess, for the blank refused reply", () => {
		const reading = parseZte(
			"http://192.168.0.1",
			'{"modem_main_state":"","ppp_status":"","signalbar":"","apn_name":""}',
		);

		expect(reading.sim).toBe("unknown");
		expect(reading.connection).toBe("unknown");
		expect(reading.signal_bars).toBeUndefined();
	});
});

describe("probe orchestration", () => {
	function deps(overrides: Partial<RouterAdminProbeDeps> = {}) {
		return {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => ROUTE_OUTPUT,
			fetchViaInterface: async () => [""],
			postViaInterface: async () => "",
			...overrides,
		} satisfies RouterAdminProbeDeps;
	}

	it("never spawns anything on a dev host", async () => {
		let called = false;
		const readings = await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "19d2:1405"]]),
			deps({
				isRealDevice: async () => false,
				runIpRouteShowDefault: async () => {
					called = true;
					return ROUTE_OUTPUT;
				},
			}),
		);

		expect(called).toBe(false);
		expect(readings.size).toBe(0);
	});

	it("still reports the admin address for a vendor it cannot read", async () => {
		const readings = await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "aaaa:bbbb"]]),
			deps(),
		);

		expect(readings.get("enx344b50000000")).toEqual({
			admin_url: "http://192.168.0.1",
			reachable: false,
		});
	});

	it("degrades to unreachable when the transfer throws", async () => {
		const readings = await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "19d2:1405"]]),
			deps({
				fetchViaInterface: async () => {
					throw new Error("curl: (7) failed to connect");
				},
			}),
		);

		expect(readings.get("enx344b50000000")?.reachable).toBe(false);
	});

	it("binds each request to the interface it is probing", async () => {
		const bound: string[] = [];
		await probeRouterCellularAdmin(
			new Map([
				["enx0c5b8f279a64", "12d1:14dc"],
				["eth1", "12d1:14dc"],
			]),
			deps({
				fetchViaInterface: async (ifname, urls) => {
					bound.push(ifname);
					return urls.map(() =>
						urls[0]?.includes("SesTokInfo")
							? "<response><SesInfo>c</SesInfo><TokInfo>t</TokInfo></response>"
							: HILINK_STATUS,
					);
				},
			}),
		);

		// The pair share one LAN address, so the interface binding is the ONLY
		// thing that keeps their two readings apart.
		expect(bound).toContain("enx0c5b8f279a64");
		expect(bound).toContain("eth1");
	});

	// Board-measured: without this header the MF79U answers 200 with every field
	// an empty string, so the probe silently reports a device that said nothing.
	it("sends the Referer the ZTE endpoint requires", async () => {
		let sent: readonly string[] | undefined;
		await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "19d2:1405"]]),
			deps({
				fetchViaInterface: async (_ifname, _urls, headers) => {
					sent = headers;
					return [ZTE_BODY];
				},
			}),
		);

		expect(sent).toEqual(["Referer: http://192.168.0.1/index.html"]);
	});

	it("reads the Qualcomm UFI shell through each interface binding", async () => {
		const bound: string[] = [];
		const readings = await probeRouterCellularAdmin(
			new Map([
				["enx020754023235", "05c6:9024"],
				["enx020a53313630", "05c6:9024"],
			]),
			deps({
				runIpRouteShowDefault: async () =>
					"default via 192.168.100.1 dev enx020754023235\n" +
					"default via 192.168.100.1 dev enx020a53313630\n",
				fetchViaInterface: async (ifname, urls) => {
					bound.push(ifname);
					expect(urls).toEqual(["http://192.168.100.1/"]);
					return ["<title>4G UFI</title>"];
				},
				postViaInterface: async (ifname, url, body) => {
					bound.push(ifname);
					expect(url).toBe("http://192.168.100.1/himiapi/json");
					const request = JSON.parse(body) as { cmdid: string };
					if (request.cmdid === "login") {
						return '{"reply":"ok","session":"ufi-session"}';
					}
					return '{"reply":"ok","params":{}}';
				},
			}),
		);

		// One login, one shell fetch, then every read command — derived rather
		// than pinned to a literal, so adding a READ moves this count and adding
		// a WRITE could not hide inside it.
		const perDevice = 2 + UFI_READ_COMMANDS.length;
		expect(bound.filter((ifname) => ifname === "enx020754023235").length).toBe(
			perDevice,
		);
		expect(bound.filter((ifname) => ifname === "enx020a53313630").length).toBe(
			perDevice,
		);
		expect(readings.get("enx020754023235")?.model).toBe("4G UFI");
		expect(readings.get("enx020a53313630")?.reachable).toBe(true);
	});

	it("skips an interface with no default route of its own", async () => {
		const readings = await probeRouterCellularAdmin(
			new Map([["enx9999", "19d2:1405"]]),
			deps(),
		);

		expect(readings.size).toBe(0);
	});

	it("returns no readings when the routing table cannot be read", async () => {
		const readings = await probeRouterCellularAdmin(
			new Map([["enx344b50000000", "19d2:1405"]]),
			deps({
				runIpRouteShowDefault: async () => {
					throw new Error("ip: command not found");
				},
			}),
		);

		expect(readings.size).toBe(0);
	});
});

/**
 * The write path (todo 56).
 *
 * These bodies are captures too: the HiLink round-trips below are the ones that
 * actually ran on the bench (`dataswitch` 1→0→1, `RoamAutoConnectEnable` 0→1→0),
 * which is the evidence that earned this dialect a control at all.
 *
 * The gate here is the one rule that matters: `applied` is a claim about the
 * DEVICE, so it may only be issued after a read-back agreed. Every test below
 * that ends in a refusal is a case where the vendor said OK and the device did
 * not move.
 */
describe("applyRouterCellularControl", () => {
	const SESSION = `<?xml version="1.0" encoding="UTF-8"?><response><SesInfo>SessionID=abc</SesInfo><TokInfo>tok123</TokInfo></response>`;
	const dataSwitchBody = (on: boolean) =>
		`<?xml version="1.0" encoding="UTF-8"?><response><dataswitch>${on ? 1 : 0}</dataswitch></response>`;
	const connectionBody = (roaming: boolean) =>
		`<?xml version="1.0" encoding="UTF-8"?><response><RoamAutoConnectEnable>${roaming ? 1 : 0}</RoamAutoConnectEnable><MaxIdelTime>600</MaxIdelTime><ConnectMode>0</ConnectMode><MTU>1500</MTU><auto_dial_switch>1</auto_dial_switch><pdp_always_on>1</pdp_always_on></response>`;

	/** A fake HiLink whose stored state only moves when a POST is actually made. */
	function fakeHilink(options: { acceptWrites?: boolean } = {}) {
		const accept = options.acceptWrites ?? true;
		const state = { mobile_data: true, roaming_autoconnect: false };
		const posts: Array<{ url: string; body: string }> = [];
		const deps: RouterAdminProbeDeps = {
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () => ROUTE_OUTPUT,
			fetchViaInterface: async (_ifname, urls) =>
				urls.map((url) => {
					if (url.endsWith("/api/webserver/SesTokInfo")) return SESSION;
					if (url.endsWith("/api/dialup/mobile-dataswitch"))
						return dataSwitchBody(state.mobile_data);
					if (url.endsWith("/api/dialup/connection"))
						return connectionBody(state.roaming_autoconnect);
					return "";
				}),
			postViaInterface: async (_ifname, url, body) => {
				posts.push({ url, body });
				if (!accept)
					return `<?xml version="1.0" encoding="UTF-8"?><response>OK</response>`;
				if (url.endsWith("/api/dialup/mobile-dataswitch")) {
					state.mobile_data = /<dataswitch>1<\/dataswitch>/.test(body);
				} else if (url.endsWith("/api/dialup/connection")) {
					state.roaming_autoconnect =
						/<RoamAutoConnectEnable>1<\/RoamAutoConnectEnable>/.test(body);
				}
				return `<?xml version="1.0" encoding="UTF-8"?><response>OK</response>`;
			},
		};
		return { deps, posts, state };
	}

	it("reports applied only after the device reports the new value", async () => {
		const { deps, state } = fakeHilink();

		const result = await applyRouterCellularControl(
			"enx0c5b8f279a64",
			"12d1:14dc",
			"mobile_data",
			false,
			deps,
		);

		expect(result).toEqual({
			status: "applied",
			controls: { mobile_data: false, roaming_autoconnect: false },
		});
		expect(state.mobile_data).toBe(false);
	});

	// The defect this whole path exists to prevent: a vendor that answers OK and
	// changes nothing must NOT surface as a successful control.
	it("refuses not_applied when the device answers OK but does not move", async () => {
		const { deps } = fakeHilink({ acceptWrites: false });

		const result = await applyRouterCellularControl(
			"enx0c5b8f279a64",
			"12d1:14dc",
			"mobile_data",
			false,
			deps,
		);

		expect(result).toEqual({ status: "refused", reason: "not_applied" });
	});

	it("preserves the sibling fields when writing the roaming flag", async () => {
		const { deps, posts } = fakeHilink();

		const result = await applyRouterCellularControl(
			"enx0c5b8f279a64",
			"12d1:14dc",
			"roaming_autoconnect",
			true,
			deps,
		);

		expect(result.status).toBe("applied");
		const write = posts.find((p) => p.url.endsWith("/api/dialup/connection"));
		// The endpoint REPLACES the record, so an omitted field is a reset. Each
		// of these was read off the device moments earlier and echoed back.
		expect(write?.body).toContain("<MTU>1500</MTU>");
		expect(write?.body).toContain("<MaxIdelTime>600</MaxIdelTime>");
		expect(write?.body).toContain("<pdp_always_on>1</pdp_always_on>");
		expect(write?.body).toContain(
			"<RoamAutoConnectEnable>1</RoamAutoConnectEnable>",
		);
	});

	it("refuses a ZTE outright — nothing on it was ever proven writable", async () => {
		const { deps, posts } = fakeHilink();

		const result = await applyRouterCellularControl(
			"enx344b50000000",
			"19d2:1405",
			"mobile_data",
			false,
			deps,
		);

		expect(result).toEqual({ status: "refused", reason: "unsupported" });
		expect(posts).toEqual([]);
	});

	it("never writes from a dev host", async () => {
		const { deps, posts } = fakeHilink();

		const result = await applyRouterCellularControl(
			"enx0c5b8f279a64",
			"12d1:14dc",
			"mobile_data",
			false,
			{ ...deps, isRealDevice: async () => false },
		);

		expect(result).toEqual({ status: "refused", reason: "unsupported" });
		expect(posts).toEqual([]);
	});

	it("refuses unreachable when the dongle has no default route", async () => {
		const { deps } = fakeHilink();

		const result = await applyRouterCellularControl(
			"enx9999",
			"12d1:14dc",
			"mobile_data",
			false,
			deps,
		);

		expect(result).toEqual({ status: "refused", reason: "unreachable" });
	});
});

describe("identity fields the naming depends on", () => {
	it("reads the HiLink's IMEI, firmware and hardware revision", () => {
		const reading = parseHilink("http://192.168.8.1", {
			information: HILINK_INFORMATION,
			status: HILINK_STATUS,
		});

		expect(reading.imei).toBe("866850029359669");
		expect(reading.firmware).toBe("22.333.01.00.00");
		expect(reading.hardware).toBe("CL2E3372HM");
	});

	it("reads the ZTE's model, IMEI and firmware", () => {
		const reading = parseZte(
			"http://192.168.0.1",
			JSON.stringify({
				modem_main_state: "modem_sim_undetected",
				ppp_status: "ppp_disconnected",
				model_name: "MF79U",
				imei: "862882046298749",
				wa_inner_version: "BD_XCBZHKMF79UV1.0.0B03",
			}),
		);

		expect(reading.model).toBe("MF79U");
		expect(reading.imei).toBe("862882046298749");
		expect(reading.firmware).toBe("BD_XCBZHKMF79UV1.0.0B03");
	});

	// The ZTE must never advertise a control, whatever else it reports.
	it("a ZTE reading carries no controls", () => {
		const reading = parseZte(
			"http://192.168.0.1",
			JSON.stringify({ modem_main_state: "modem_init_complete" }),
		);

		expect(reading.controls).toBeUndefined();
	});

	it("a HiLink with unreadable switch bodies claims no controls", () => {
		const reading = parseHilink("http://192.168.8.1", {
			information: HILINK_INFORMATION,
			status: HILINK_STATUS,
		});

		expect(reading.controls).toBeUndefined();
	});
});
