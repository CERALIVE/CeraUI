/**
 * THE MIXED-VERSION BRIDGE: the exact 1.2.0 pin must resolve every packaged
 * projection from `@ceralive/modem-control`, while the two never-packaged
 * helpers remain on their permanent local implementations.
 *
 * Todo 29 routes fourteen frozen pure projections through ONE structural
 * namespace probe, so which implementation answers is decided at RUNTIME by
 * whichever package version is installed. That is a real skew surface with a
 * silent failure mode: `modemControlFunction<T>` CASTS the runtime export to
 * `T`, so a packaged function that shares a name but not a signature type-checks
 * clean and then misbehaves at runtime — either by throwing (the 1.1 candidate's
 * `fiveGPreferenceEvidence` takes a decoded RAT set, not mmcli's mode catalog)
 * or, worse, by silently answering about fields it was never given.
 *
 * `tsc` cannot see any of that. Only executing the projections can, so every
 * assertion below is on a RETURNED VALUE rather than on a type, and the whole
 * file is the per-cell proof for one column of the skew matrix: run it under the
 * floor and under the candidate overlay and the two columns must agree.
 */

import { describe, expect, test } from "bun:test";

import { claimableModules, surfaceableModules } from "@ceraui/rpc";
import { modeMaskToLabel } from "../modules/cellular/dbus-mm-enums.ts";
import { classifyShadowDivergences } from "../modules/cellular/shadow-divergence.ts";
import { hasModemControlFunction } from "../modules/modem-control-compat.ts";
import { resolveModemCapabilityClaims } from "../modules/modems/capability-gates.ts";
import { fiveGPreferenceEvidence } from "../modules/modems/five-g-preference.ts";
import type { ModemInfo } from "../modules/modems/mmcli.ts";
import { isUninformativeIdentity } from "../modules/modems/modem-identity.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { deriveSimPresence } from "../modules/modems/sim-presence.ts";
import { parseHilinkCapabilities } from "../modules/network/router-capabilities.ts";
import { parseZteDetails } from "../modules/network/router-details.ts";
import { parseZteSignal } from "../modules/network/router-signal.ts";
import { parseJsonObject } from "../modules/network/router-signal-model.ts";
import { classifyUsbNetDevice } from "../modules/network/usb-net-classifier.ts";
import { xmlValue } from "../modules/network/vendor-xml.ts";

/**
 * The names the fourteen frozen projections probe for, and the two frozen
 * columns their resolution may take. Anything else — a partial package, a
 * renamed export, an unexpected build — is a skew this matrix must refuse
 * rather than silently absorb.
 */
const PROBED_NAMES = [
	"classifyShadowDivergences",
	"classifyUsbNetDevice",
	"deriveSimPresence",
	"fiveGPreferenceEvidence",
	"hilinkConnectionBody",
	"isUninformativeIdentity",
	"mintLinkId",
	"modeMaskToLabel",
	"parseHilinkCapabilities",
	"parseHilinkXmlValue",
	"parseJsonObject",
	"parseZteDetails",
	"parseZteSignal",
	"vidPidOf",
] as const;

/**
 * `vidPidOf` and `hilinkConnectionBody` exist in NEITHER column — the candidate
 * package genuinely exports no such function (only an unrelated `vidPid`
 * catalog FIELD). Their local fallbacks are therefore permanent, not
 * transitional, and a cutover that deletes them deletes the implementation.
 */
const NEVER_PACKAGED = ["hilinkConnectionBody", "vidPidOf"] as const;

const CANDIDATE_COLUMN = PROBED_NAMES.filter(
	(name) => !(NEVER_PACKAGED as readonly string[]).includes(name),
);

function resolvedProbes(): readonly string[] {
	return PROBED_NAMES.filter((name) => hasModemControlFunction(name));
}

function column(): "floor" | "candidate" {
	return resolvedProbes().length === 0 ? "floor" : "candidate";
}

function modemInfo(fields: Record<string, unknown>): Readonly<ModemInfo> {
	return fields as unknown as Readonly<ModemInfo>;
}

describe("modem-control skew matrix — the probe roster", () => {
	test("the pinned release resolves the complete candidate column", () => {
		expect(column()).toBe("candidate");
		expect(resolvedProbes()).toEqual(CANDIDATE_COLUMN);
	});

	test("the two never-packaged names are absent in BOTH columns", () => {
		for (const name of NEVER_PACKAGED) {
			expect(hasModemControlFunction(name), name).toBe(false);
		}
	});
});

describe("modem-control skew matrix — every projection answers identically", () => {
	test("parseZteDetails splits the serving band from the WAN leg band", () => {
		expect(
			parseZteDetails(
				JSON.stringify({
					network_type: "LTE",
					network_provider: "732103",
					network_provider_fullname: "Movistar",
					cell_id: "2c20f34",
					lte_band: "B4",
					wan_active_band: "LTE BAND 7",
					lte_pci: "247",
					rmcc: "732",
					rmnc: "103",
					simcard_roam: "Home",
					wan_lte_ca: "ca_activated",
				}),
			),
		).toEqual({
			network_type: "LTE",
			provider: "Movistar",
			cell_id: "2c20f34",
			band: "B4",
			network_band: "LTE BAND 7",
			pci: "247",
			mcc: "732",
			mnc: "103",
			roaming: "Home",
			carrier_aggregation: "ca_activated",
		});
	});

	test("parseZteDetails carries the carrier composition and the dongle counters", () => {
		expect(
			parseZteDetails(
				JSON.stringify({
					lte_ca_pcell_arfcn: "2000",
					lte_ca_pcell_band: "4",
					lte_ca_pcell_bandwidth: "20",
					lte_ca_scell_arfcn: "5230",
					lte_ca_scell_band: "7",
					lte_ca_scell_bandwidth: "15",
					monthly_tx_bytes: "12884901888",
					monthly_rx_bytes: "96636764160",
					monthly_time: "184320",
					date_month: "2026-08",
					realtime_tx_bytes: "1048576",
					realtime_rx_bytes: "8388608",
					realtime_tx_thrpt: "131072",
					realtime_rx_thrpt: "1048576",
					realtime_time: "3600",
				}),
			),
		).toEqual({
			pcell_arfcn: "2000",
			pcell_band: "4",
			pcell_bandwidth: "20",
			scell_arfcn: "5230",
			scell_band: "7",
			scell_bandwidth: "15",
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

	test("parseZteDetails drops every vendor placeholder and refuses an empty block", () => {
		expect(
			parseZteDetails('{"cell_id":"-","lte_band":"--","rmcc":"N/A"}'),
		).toBeUndefined();
		expect(parseZteDetails("not json")).toBeUndefined();
	});

	test("parseZteSignal normalizes the goform dialect", () => {
		expect(
			parseZteSignal('{"signalbar":"4","rssi":"-67","lte_snr":"8"}'),
		).toMatchObject({
			bars: { state: "known", value: 4 },
			dbm: { state: "known", value: -67 },
			snr: { state: "known", value: 8 },
		});
		expect(parseZteSignal("not json").bars).toEqual({
			state: "unknown",
			reason: "malformed",
		});
	});

	test("parseJsonObject accepts an object and refuses everything else", () => {
		expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonObject("[1,2]")).toBeUndefined();
		expect(parseJsonObject("nope")).toBeUndefined();
	});

	test("xmlValue reads a HiLink tag and answers undefined for an absent one", () => {
		expect(
			xmlValue("<response><SignalIcon>4</SignalIcon></response>", "SignalIcon"),
		).toBe("4");
		expect(xmlValue("<response></response>", "SignalIcon")).toBeUndefined();
	});

	test("parseHilinkCapabilities reports a catalog and a refusal distinctly", () => {
		expect(
			parseHilinkCapabilities({
				netModeList:
					"<response><NetworkModeList><NetworkMode><Index>00</Index><Name>AUTO</Name></NetworkMode></NetworkModeList></response>",
				netMode: "<response><NetworkMode>00</NetworkMode></response>",
			}),
		).toEqual({
			net_mode: {
				state: "reported",
				modes: [{ id: "00", name: "AUTO" }],
				current: "00",
			},
		});
		expect(
			parseHilinkCapabilities({
				netModeList: "<error><code>112008</code></error>",
			}),
		).toEqual({
			net_mode: { state: "unavailable", reason: "refused", code: "112008" },
		});
	});

	test("deriveSimPresence keeps `absent` reachable through exactly one fact", () => {
		expect(
			deriveSimPresence(
				modemInfo({
					"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/0",
				}),
			),
		).toBe("present");
		expect(
			deriveSimPresence(
				modemInfo({
					"modem.generic.sim": "/",
					"modem.generic.sim-slots": ["/", "/"],
					"modem.generic.state-failed-reason": "sim-missing",
				}),
			),
		).toBe("absent");
		// A blank slot proves nothing — MM reports `/` while a modem initializes.
		expect(deriveSimPresence(modemInfo({ "modem.generic.sim": "/" }))).toBe(
			"unknown",
		);
	});

	test("fiveGPreferenceEvidence survives the RAT-vocabulary boundary", () => {
		// The candidate's twin takes a decoded RAT set; a bare delegation throws
		// `supportedRats.has is not a function` here and nowhere in `tsc`.
		expect(fiveGPreferenceEvidence(undefined)).toBe("unknown");
		expect(fiveGPreferenceEvidence({ supported: [] })).toBe("unknown");
		expect(
			fiveGPreferenceEvidence({
				supported: [{ allowed: "2g|3g|4g", preferred: "4g" }],
			}),
		).toBe("absent");
		expect(
			fiveGPreferenceEvidence({
				supported: [{ allowed: "3g|4g|5g", preferred: "5g" }],
			}),
		).toBe("present");
	});

	test("isUninformativeIdentity judges mmcli's own garbage answers", () => {
		expect(isUninformativeIdentity(undefined)).toBe(true);
		expect(isUninformativeIdentity("--")).toBe(true);
		expect(isUninformativeIdentity("RM530N-GL")).toBe(false);
	});

	test("modeMaskToLabel decodes a mode mask", () => {
		expect(modeMaskToLabel(undefined)).toBeUndefined();
		expect(modeMaskToLabel(0)).toBeUndefined();
	});

	test("classifyUsbNetDevice keeps the three-way precedence", () => {
		// An MM control port outranks everything: the Cellular section owns it.
		expect(
			classifyUsbNetDevice({
				vendorId: "2c7c",
				productId: "0801",
				bDeviceClass: 0,
				interfaces: [
					{
						interfaceClass: 0x02,
						interfaceSubClass: 0x0e,
						interfaceProtocol: 0x00,
					},
					{
						interfaceClass: 0x0a,
						interfaceSubClass: 0x00,
						interfaceProtocol: 0x00,
					},
				],
			}).deviceClass,
		).toBe("mm-managed");
		// A tether with no control port and no cellular evidence is said plainly.
		expect(
			classifyUsbNetDevice({
				vendorId: "0b95",
				productId: "1790",
				bDeviceClass: 0,
				interfaces: [
					{
						interfaceClass: 0x02,
						interfaceSubClass: 0x06,
						interfaceProtocol: 0x00,
					},
					{
						interfaceClass: 0x0a,
						interfaceSubClass: 0x00,
						interfaceProtocol: 0x00,
					},
				],
			}).deviceClass,
		).toBe("wired-ethernet");
		// The SAME tether from a known cellular vendor IS a router-mode dongle.
		expect(
			classifyUsbNetDevice({
				vendorId: "12d1",
				productId: "14dc",
				bDeviceClass: 0,
				interfaces: [
					{
						interfaceClass: 0x02,
						interfaceSubClass: 0x06,
						interfaceProtocol: 0x00,
					},
					{
						interfaceClass: 0x0a,
						interfaceSubClass: 0x00,
						interfaceProtocol: 0x00,
					},
				],
			}).deviceClass,
		).toBe("router-cellular");
	});

	test("classifyShadowDivergences joins two sides and reports the one-sided rows", () => {
		expect(classifyShadowDivergences([], [])).toEqual([]);
		expect(
			classifyShadowDivergences([{ deviceKey: "d-aaa", present: true }], []),
		).toEqual([{ deviceKey: "d-aaa", kind: "only-in-mmcli" }]);
		expect(
			classifyShadowDivergences([], [{ deviceKey: "d-bbb", present: true }]),
		).toEqual([{ deviceKey: "d-bbb", kind: "only-in-dbus" }]);
		expect(
			classifyShadowDivergences(
				[{ deviceKey: "d-aaa", present: true }],
				[{ deviceKey: "d-aaa", present: true }],
			),
		).toEqual([]);
	});
});

describe("modem-control skew matrix — SRTLA link identity is stable across the skew", () => {
	/**
	 * `mintLinkId` is one of the probed twelve, so the SRTLA bond's identity
	 * authority itself crosses the version boundary. A digest that moved would
	 * re-key every telemetry row on upgrade: the operator's RTT and NAK history
	 * would silently reattach to a different physical uplink, which is the exact
	 * misattribution the id exists to prevent.
	 */
	// `lnk_` + the first 16 hex characters of sha256(identityKey).
	const CASES: readonly [string, string][] = [
		["ifname:eth0", "lnk_ca6c37c1643cc7af"],
		["ifname:usb0", "lnk_a10326b1061d84a7"],
		["usb-serial:2b16081", "lnk_0a8ebc2d22d4b0b8"],
		["id-path:platform-xhci-hcd.0.auto-usb-0:1.4.1", "lnk_647ff77c0e01edc0"],
	];

	test("a minted id is byte-identical in both columns", () => {
		for (const [identityKey, expected] of CASES) {
			expect(mintLinkId(identityKey), identityKey).toBe(expected);
		}
	});

	test("distinct identities never collide, and minting is deterministic", () => {
		const minted = CASES.map(([identityKey]) => mintLinkId(identityKey));
		expect(new Set(minted).size).toBe(CASES.length);
		for (const [identityKey] of CASES) {
			expect(mintLinkId(identityKey)).toBe(mintLinkId(identityKey));
		}
	});
});

describe("modem-control skew matrix — a floor backend fabricates no candidate capability", () => {
	/**
	 * The structural-probe ABSENCE path is the one the whole fleet runs today, and
	 * the honest answer it must give is the SHIPPED state — never a capability
	 * borrowed from a package that is not installed. Installing the candidate adds
	 * pure functions, not modules, so the ladder may not move: nothing becomes
	 * offerable and nothing becomes claimable in either column.
	 */
	test("no module is surfaceable or claimable on an unconfigured device", () => {
		const claims = resolveModemCapabilityClaims(undefined);
		expect(surfaceableModules(claims)).toEqual([]);
		expect(claimableModules(claims)).toEqual([]);
	});

	test("a module this build does not ship stays unavailable, gates absent", () => {
		const claims = resolveModemCapabilityClaims(undefined);
		// `implemented` (shipped, gate OFF) is the honest floor for the one module
		// this build registers; every other module is not shipped at all.
		expect(claims["fcc-auto-unlock"]).toBe("implemented");
		for (const module of [
			"five-g-pref",
			"band-lock",
			"gps",
			"ussd",
			"sms",
			"esim",
		] as const) {
			expect(claims[module], module).toBe("unavailable");
		}
	});

	test("an unknown modem key still answers, rather than throwing", () => {
		expect(() => resolveModemCapabilityClaims("no-such-modem")).not.toThrow();
	});
});
