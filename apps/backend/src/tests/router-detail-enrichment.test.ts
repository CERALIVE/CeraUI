/*
 * The dongle-detail enrichment, against what the bench hardware ACTUALLY answered.
 *
 * Every fixture in this file is a VERBATIM capture taken on `ceralive2`
 * (2026-08-18) with `curl --interface` bound to each unit, not a shape derived
 * from a vendor document. That distinction is the whole point of the file: the
 * research this pass started from named three Huawei endpoints that turned out
 * to be REFUSED by the firmware in the rack, and named ZTE fields that the
 * firmware in the rack answers as empty strings. Both facts are pinned below, so
 * the next reader learns them from a failing test rather than from a board.
 */

import { describe, expect, it } from "bun:test";

import {
	parseHilinkDetails,
	parseUfiDetails,
	parseZteDetails,
	ZTE_DETAIL_KEYS,
} from "../modules/network/router-details.ts";

// ── Huawei E3372 HiLink, firmware 22.333.01.00.00, SIM-less ─────────────────

/** VERBATIM: `GET /api/device/information` on `enx0c5b8f279a64`. */
const HILINK_INFORMATION = `<?xml version="1.0" encoding="UTF-8"?>
<response>
<DeviceName>E3372</DeviceName>
<SerialNumber>Y4QDU17621000872</SerialNumber>
<Imei>866850029360451</Imei>
<Imsi></Imsi>
<Iccid></Iccid>
<Msisdn></Msisdn>
<HardwareVersion>CL2E3372HM</HardwareVersion>
<SoftwareVersion>22.333.01.00.00</SoftwareVersion>
<WebUIVersion>17.100.13.112.03</WebUIVersion>
<MacAddress1>BA:AB:BE:34:00:00</MacAddress1>
<MacAddress2></MacAddress2>
<ProductFamily>LTE</ProductFamily>
<Classify>hilink</Classify>
<supportmode>LTE|WCDMA|GSM</supportmode>
<workmode>NO SERVICE</workmode>
<WanIPAddress></WanIPAddress>
<WanIPv6Address></WanIPv6Address>
</response>`;

/** VERBATIM: `GET /api/device/signal` on the same unit. Every element EMPTY. */
const HILINK_SIGNAL = `<?xml version="1.0" encoding="UTF-8"?>
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

/**
 * The same two documents as a REGISTERED unit publishes them. Shape-derived from
 * the elements the capture above proves exist — labelled as such, never presented
 * as a capture (this bench has no SIM in either HiLink twin).
 */
const HILINK_SIGNAL_REGISTERED = HILINK_SIGNAL.replace(
	"<pci></pci>",
	"<pci>247</pci>",
)
	.replace("<cell_id></cell_id>", "<cell_id>11029764</cell_id>")
	.replace("<mode></mode>", "<mode>7</mode>")
	.replace(
		"<lte_bandwidth></lte_bandwidth>",
		"<lte_bandwidth>20MHz</lte_bandwidth>",
	)
	.replace("<lte_bandinfo></lte_bandinfo>", "<lte_bandinfo>3</lte_bandinfo>");

describe("the Huawei HiLink detail read", () => {
	it("reports the registration the carrier granted, which a SIM slot cannot", () => {
		const details = parseHilinkDetails({
			information: HILINK_INFORMATION,
			signal: HILINK_SIGNAL,
		});

		// The whole reason this field exists: the slot reading and the carrier's
		// answer are different facts, and on this unit they disagree.
		expect(details?.registration).toBe("NO SERVICE");
	});

	it("states nothing about a radio that stated nothing", () => {
		const details = parseHilinkDetails({
			information: HILINK_INFORMATION,
			signal: HILINK_SIGNAL,
		});

		// Every element of the captured signal document is present and EMPTY, and
		// an empty element is not a reading. No key, rather than a blank one.
		for (const key of [
			"cell_id",
			"pci",
			"band",
			"bandwidth",
			"network_type",
			"imsi",
			"iccid",
			"wan_ip",
		] as const) {
			expect(details).not.toHaveProperty(key);
		}
	});

	it("carries the serving cell once the device publishes one", () => {
		expect(
			parseHilinkDetails({
				information: HILINK_INFORMATION,
				signal: HILINK_SIGNAL_REGISTERED,
			}),
		).toEqual({
			registration: "NO SERVICE",
			network_type: "7",
			cell_id: "11029764",
			pci: "247",
			band: "3",
			bandwidth: "20MHz",
		});
	});

	it("reports nothing at all for bodies it never received", () => {
		expect(parseHilinkDetails({})).toBeUndefined();
	});
});

// ── ZTE MF79U, firmware BD_XCBZHKMF79UV1.0.0B03, SIM present ────────────────

/**
 * VERBATIM: the ONE `goform_get_cmd_process` `multi_data` reply on
 * `enx344b50000000`, trimmed to the keys this reader consumes. The empty strings
 * are the measurement — this OEM build answers the whole carrier-aggregation and
 * traffic-counter surface as `""`, so the enrichment renders none of it here.
 */
const ZTE_BODY = JSON.stringify({
	network_provider: "732103",
	network_type: "LTE",
	rmcc: "",
	rmnc: "",
	cell_id: "2c20f34",
	wan_active_band: "",
	wan_lte_ca: "",
	lte_pci: "",
	lte_ca_pcell_arfcn: "",
	lte_ca_pcell_band: "",
	lte_ca_pcell_bandwidth: "",
	lte_ca_scell_arfcn: "",
	lte_ca_scell_band: "",
	lte_ca_scell_bandwidth: "",
	monthly_tx_bytes: "",
	monthly_rx_bytes: "",
	monthly_time: "",
	date_month: "",
	realtime_tx_bytes: "",
	realtime_rx_bytes: "",
	realtime_tx_thrpt: "",
	realtime_rx_thrpt: "",
	realtime_time: "",
	signalbar: "5",
	lte_rsrp: "-74",
	lte_rsrq: "-14",
	lte_snr: "-1.0",
	simcard_roam: "Home",
	network_provider_fullname: "",
	lte_band: "",
});

describe("the ZTE detail read", () => {
	it("publishes exactly what the bench firmware stated, and nothing it left blank", () => {
		expect(parseZteDetails(ZTE_BODY)).toEqual({
			network_type: "LTE",
			provider: "732103",
			cell_id: "2c20f34",
			roaming: "Home",
		});
	});

	it("prefers the operator's NAME over the numeric code beside it", () => {
		const named = JSON.parse(ZTE_BODY) as Record<string, string>;
		named.network_provider_fullname = "Movistar";

		// `network_provider` is a PLMN on this firmware (`732103`). Rendering that
		// under an "Operator" label reports a code as an operator, so a stated name
		// outranks it — both verbatim, only the order is ours.
		expect(parseZteDetails(JSON.stringify(named))?.provider).toBe("Movistar");
	});

	it("carries the full carrier composition once a firmware answers it", () => {
		const rich = JSON.parse(ZTE_BODY) as Record<string, string>;
		Object.assign(rich, {
			rmcc: "732",
			rmnc: "103",
			lte_pci: "247",
			wan_active_band: "LTE BAND 4",
			wan_lte_ca: "ca_activated",
			lte_ca_pcell_arfcn: "2000",
			lte_ca_pcell_band: "4",
			lte_ca_pcell_bandwidth: "20",
			lte_ca_scell_arfcn: "5230",
			lte_ca_scell_band: "7",
			lte_ca_scell_bandwidth: "15",
		});

		expect(parseZteDetails(JSON.stringify(rich))).toMatchObject({
			mcc: "732",
			mnc: "103",
			pci: "247",
			network_band: "LTE BAND 4",
			carrier_aggregation: "ca_activated",
			pcell_arfcn: "2000",
			pcell_band: "4",
			pcell_bandwidth: "20",
			scell_arfcn: "5230",
			scell_band: "7",
			scell_bandwidth: "15",
		});
	});

	it("carries the dongle's own counters under names that cannot read as a rate", () => {
		const counted = JSON.parse(ZTE_BODY) as Record<string, string>;
		Object.assign(counted, {
			monthly_tx_bytes: "12884901888",
			monthly_rx_bytes: "96636764160",
			monthly_time: "184320",
			date_month: "2026-08",
			realtime_tx_bytes: "1048576",
			realtime_rx_bytes: "8388608",
			realtime_tx_thrpt: "131072",
			realtime_rx_thrpt: "1048576",
			realtime_time: "3600",
		});

		expect(parseZteDetails(JSON.stringify(counted))).toMatchObject({
			monthly_tx_bytes: "12884901888",
			monthly_rx_bytes: "96636764160",
			monthly_time: "184320",
			monthly_period: "2026-08",
			session_tx_bytes: "1048576",
			session_rx_bytes: "8388608",
			session_tx_rate: "131072",
			session_rx_rate: "1048576",
			session_time: "3600",
		});
	});

	it("asks for every key it reads, on the ONE request the probe already sends", () => {
		// A key the reader consumes but the request never asks for is a field that
		// is silently absent forever, and nothing else in this module would fail.
		for (const key of [
			"lte_pci",
			"rmcc",
			"rmnc",
			"simcard_roam",
			"wan_active_band",
			"wan_lte_ca",
			"lte_ca_pcell_arfcn",
			"lte_ca_scell_bandwidth",
			"monthly_tx_bytes",
			"date_month",
			"realtime_rx_thrpt",
			"network_provider_fullname",
		]) {
			expect(ZTE_DETAIL_KEYS).toContain(key);
		}
	});
});

// ── Qualcomm 4G UFI, firmware UFI_HM_SIM1_V016_240828, SIM present ──────────

/** VERBATIM: `getsysinfo` on `enx020a53313630`. */
const UFI_SYSINFO = JSON.stringify({
	reply: "ok",
	params: {
		sysruntime: 4793,
		systime: "1970-01-02 02:19:40",
		bsid: "25002",
		cellid: "134318388",
		cputemp: "60",
		wifinum: "0",
		ethnum: "0",
	},
});

/** VERBATIM: `getoverview` on the same unit. */
const UFI_OVERVIEW = JSON.stringify({
	reply: "ok",
	params: {
		SYSVER: "UFI_HM_SIM1_V016_240828",
		HWVER: "HW1.0",
		IMEI: "862901072672633",
		SSID: "4G-UFI-9627",
		IMSI: "732123704103087",
		WANIP: "-",
		ICCID: "8957123302538483871",
		WEBVER: "WEB1.1",
		SIGNAL: -88,
	},
});

/** VERBATIM: `getproduceinfo` — it carries NO product name on this firmware. */
const UFI_PRODUCE_INFO = JSON.stringify({
	reply: "ok",
	params: { calstatus: "1", wificheckstatus: "1" },
});

describe("the Qualcomm UFI detail read", () => {
	it("reads the device diagnostics its `getsysinfo` actually publishes", () => {
		const details = parseUfiDetails({
			overview: UFI_OVERVIEW,
			sysinfo: UFI_SYSINFO,
			produceInfo: UFI_PRODUCE_INFO,
		});

		expect(details).toEqual({
			ssid: "4G-UFI-9627",
			imsi: "732123704103087",
			iccid: "8957123302538483871",
			web_version: "WEB1.1",
			cell_id: "134318388",
			station_id: "25002",
			cpu_temp: "60",
			wifi_clients: "0",
			eth_clients: "0",
		});
	});

	it("drops the `-` the device uses for a WAN address it does not hold", () => {
		expect(
			parseUfiDetails({ overview: UFI_OVERVIEW, sysinfo: UFI_SYSINFO }),
		).not.toHaveProperty("wan_ip");
	});

	it("invents no product name from a record that carries none", () => {
		// `getproduceinfo` answers calibration flags on this firmware, so the
		// candidate ladder correctly finds nothing rather than adopting one.
		expect(parseUfiDetails({ produceInfo: UFI_PRODUCE_INFO })).toBeUndefined();
	});

	it("keeps `bsid` as an identifier and never as a claim", () => {
		const details = parseUfiDetails({ sysinfo: UFI_SYSINFO });

		// It is carried under a name that asserts nothing. `cellid` is the field
		// that genuinely IS a serving-cell id, and the two must not be merged.
		expect(details?.station_id).toBe("25002");
		expect(details?.cell_id).toBe("134318388");
	});

	it("reports nothing for a body it never received", () => {
		expect(parseUfiDetails({})).toBeUndefined();
	});
});
