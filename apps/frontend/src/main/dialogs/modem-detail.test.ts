/**
 * The dialog's read-only detail derivations, as tables.
 *
 * Everything here exists to defend ONE property: an additive-optional field that
 * is absent must produce nothing — not a zero, not a dash, not a row with an
 * empty value. The negative arms are therefore the point of the file, and the
 * `defaultAutoApn` and threshold cases pin two decisions that a "simplification"
 * would silently reverse.
 */

import type {
	ModemCellInfo,
	ModemDataUsage,
	ModemEsim,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	cellMetricRows,
	cellObservedAtMs,
	defaultAutoApn,
	esimView,
	firmwareRevision,
	hasModemDetail,
	isStandingUsbRefusal,
	OWN_NUMBER_MASK,
	ownNumbers,
	simIccid,
	usageView,
} from "./modem-detail";

describe("cellMetricRows", () => {
	it("renders nothing at all for an absent cell_info — the mmcli path", () => {
		expect(cellMetricRows(undefined)).toEqual([]);
	});

	it("renders nothing for a cell_info object carrying no readings", () => {
		expect(cellMetricRows({})).toEqual([]);
		expect(cellMetricRows({ provenance: { source: "qmi" } })).toEqual([]);
	});

	it("orders the metrics radio → location → quality", () => {
		const cell: ModemCellInfo = {
			tech: "nr",
			cell_id: "0x1A2B3C",
			band: "n78",
			rsrp: -92,
			rsrq: -11,
			snr: 14,
			sinr: 18.5,
		};
		expect(cellMetricRows(cell).map((r) => r.key)).toEqual([
			"tech",
			"band",
			"cell_id",
			"rsrp",
			"rsrq",
			"snr",
			"sinr",
		]);
	});

	it("keeps SNR and SINR apart — they are different quantities", () => {
		const lte = cellMetricRows({ tech: "lte", snr: 12 });
		expect(lte.map((r) => r.key)).toEqual(["tech", "snr"]);

		const nr = cellMetricRows({ tech: "nr", sinr: 12 });
		expect(nr.map((r) => r.key)).toEqual(["tech", "sinr"]);
	});

	it("emits every metric individually, so one absent field drops one row", () => {
		expect(cellMetricRows({ rsrp: -80 }).map((r) => r.key)).toEqual(["rsrp"]);
		expect(cellMetricRows({ band: "b3" }).map((r) => r.key)).toEqual(["band"]);
	});

	it("keeps a genuinely-measured zero — it is a reading, not a gap", () => {
		const rows = cellMetricRows({ rsrq: 0 });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toBe("0");
	});

	it("drops a non-finite reading rather than rendering NaN", () => {
		expect(
			cellMetricRows({ rsrp: Number.NaN, sinr: Number.POSITIVE_INFINITY }),
		).toEqual([]);
	});

	it("treats a blank string field as unreported, never as an empty cell id", () => {
		expect(cellMetricRows({ cell_id: "   ", band: "" })).toEqual([]);
	});

	it("units are per-quantity: dBm for the absolute power, dB for the ratios", () => {
		const rows = cellMetricRows({ rsrp: -90, rsrq: -10, snr: 5, sinr: 6 });
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r.unit]));
		expect(byKey).toEqual({ rsrp: "dBm", rsrq: "dB", snr: "dB", sinr: "dB" });
	});

	it("resolves `tech` to a keyed value, never a raw wire token", () => {
		for (const tech of ["lte", "nr", "unknown"] as const) {
			const row = cellMetricRows({ tech })[0];
			expect(row?.valueKey).toMatch(/^network\.modem\.detail\.tech/);
			expect(row?.value).toBeUndefined();
		}
	});
});

describe("cellObservedAtMs", () => {
	it("is undefined when nothing said when the reading was taken", () => {
		expect(cellObservedAtMs(undefined)).toBeUndefined();
		expect(cellObservedAtMs({})).toBeUndefined();
		expect(cellObservedAtMs({ provenance: {} })).toBeUndefined();
	});

	it("promotes an epoch-seconds stamp to milliseconds", () => {
		expect(
			cellObservedAtMs({ provenance: { observed_at: 1_770_000_000 } }),
		).toBe(1_770_000_000_000);
	});

	it("passes an epoch-milliseconds stamp through untouched", () => {
		expect(
			cellObservedAtMs({ provenance: { observed_at: 1_770_000_000_000 } }),
		).toBe(1_770_000_000_000);
	});

	it("refuses a non-positive stamp rather than rendering 1970", () => {
		expect(
			cellObservedAtMs({ provenance: { observed_at: 0 } }),
		).toBeUndefined();
		expect(
			cellObservedAtMs({ provenance: { observed_at: -5 } }),
		).toBeUndefined();
	});
});

describe("esimView", () => {
	it("is absent when the modem reports no eSIM block", () => {
		expect(esimView(undefined)).toBeUndefined();
	});

	it("is absent for an empty observation — an empty badge is noise", () => {
		expect(esimView({})).toBeUndefined();
	});

	it("names the SIM kind and the profile state by key", () => {
		const view = esimView({ sim_type: "esim", esim_status: "with-profiles" });
		expect(view?.typeKey).toBe("network.modem.detail.simTypeEsim");
		expect(view?.statusKey).toBe("network.modem.detail.esimWithProfiles");
		expect(view?.isEsim).toBe(true);
	});

	it("survives a profile state with no SIM kind, defaulting the kind to unknown", () => {
		const view = esimView({ esim_status: "no-profiles" });
		expect(view?.typeKey).toBe("network.modem.detail.simTypeUnknown");
		expect(view?.isEsim).toBe(false);
	});

	it("omits the status key entirely when the state was not reported", () => {
		const view = esimView({ sim_type: "physical" });
		expect(view?.statusKey).toBeUndefined();
		expect(view?.isEsim).toBe(false);
	});

	it("never emits a raw wire token", () => {
		const cases: ModemEsim[] = [
			{ sim_type: "physical", esim_status: "unknown" },
			{ sim_type: "unknown", esim_status: "no-profiles" },
		];
		for (const esim of cases) {
			const view = esimView(esim);
			expect(view?.typeKey).toMatch(/^network\.modem\.detail\./);
			expect(view?.statusKey).toMatch(/^network\.modem\.detail\./);
		}
	});
});

describe("usageView", () => {
	it("is absent when the modem reports no data_usage", () => {
		expect(usageView(undefined)).toBeUndefined();
	});

	it("renders both counters — a usage object always carries both", () => {
		const view = usageView({ session_bytes: 1024, cycle_bytes: 4096 });
		expect(view?.sessionBytes).toBe(1024);
		expect(view?.cycleBytes).toBe(4096);
		expect(view?.cycleDay).toBeUndefined();
		expect(view?.thresholdBytes).toBeUndefined();
		expect(view?.thresholdPercent).toBeUndefined();
		expect(view?.overThreshold).toBe(false);
	});

	it("keeps a measured zero — it is a reading, not an absence", () => {
		const view = usageView({ session_bytes: 0, cycle_bytes: 0 });
		expect(view?.sessionBytes).toBe(0);
		expect(view?.cycleBytes).toBe(0);
	});

	it("computes the advisory share against a real limit", () => {
		const view = usageView({
			session_bytes: 0,
			cycle_bytes: 250,
			threshold_bytes: 1000,
		});
		expect(view?.thresholdPercent).toBe(25);
		expect(view?.overThreshold).toBe(false);
	});

	it("clamps the BAR at full while the over-limit verdict stays true", () => {
		const view = usageView({
			session_bytes: 0,
			cycle_bytes: 3000,
			threshold_bytes: 1000,
		});
		expect(view?.thresholdPercent).toBe(100);
		expect(view?.overThreshold).toBe(true);
	});

	it("draws no bar for a zero limit but still reports being past it", () => {
		const view = usageView({
			session_bytes: 0,
			cycle_bytes: 1,
			threshold_bytes: 0,
		});
		expect(view?.thresholdPercent).toBeUndefined();
		expect(view?.overThreshold).toBe(true);
	});

	it("carries the cycle day through only when reported", () => {
		const withDay: ModemDataUsage = {
			session_bytes: 1,
			cycle_bytes: 2,
			cycle_day: 17,
		};
		expect(usageView(withDay)?.cycleDay).toBe(17);
		expect(
			usageView({ session_bytes: 1, cycle_bytes: 2 })?.cycleDay,
		).toBeUndefined();
	});
});

describe("defaultAutoApn — the annex 'Automatic (recommended)' default", () => {
	it("defaults an unconfigured modem to Automatic", () => {
		expect(defaultAutoApn(undefined)).toBe(true);
	});

	it("defaults a config with no flag and no stored APN to Automatic", () => {
		expect(
			defaultAutoApn({
				apn: "",
				username: "",
				password: "",
				roaming: false,
				network: "",
			}),
		).toBe(true);
	});

	it("treats a whitespace-only APN as unconfigured", () => {
		expect(
			defaultAutoApn({
				apn: "   ",
				username: "",
				password: "",
				roaming: false,
				network: "",
			}),
		).toBe(true);
	});

	it("NEVER flips a stored manual APN to Automatic — that would discard it on save", () => {
		expect(
			defaultAutoApn({
				apn: "internet.provider.com",
				username: "",
				password: "",
				roaming: false,
				network: "",
			}),
		).toBe(false);
	});

	it("an explicit flag always wins over the default, in both directions", () => {
		expect(
			defaultAutoApn({
				apn: "",
				username: "",
				password: "",
				roaming: false,
				network: "",
				autoconfig: false,
			}),
		).toBe(false);
		expect(
			defaultAutoApn({
				apn: "internet.provider.com",
				username: "",
				password: "",
				roaming: false,
				network: "",
				autoconfig: true,
			}),
		).toBe(true);
	});
});

describe("hasModemDetail", () => {
	it("is false for a legacy payload carrying none of the three fields", () => {
		expect(hasModemDetail({})).toBe(false);
	});

	it("is false for present-but-empty objects — no empty framed section", () => {
		expect(
			hasModemDetail({ cell_info: {}, esim: {}, firmware_revision: "  " }),
		).toBe(false);
	});

	it("is true on ANY one of the three, independently", () => {
		expect(hasModemDetail({ cell_info: { rsrp: -90 } })).toBe(true);
		expect(hasModemDetail({ esim: { sim_type: "esim" } })).toBe(true);
		expect(hasModemDetail({ firmware_revision: "RM520NGL_1.0" })).toBe(true);
		expect(hasModemDetail({ own_numbers: ["+573115422359"] })).toBe(true);
		expect(hasModemDetail({ own_numbers: [] })).toBe(false);
		expect(hasModemDetail({ iccid: "8957123102400060892" })).toBe(true);
		expect(hasModemDetail({ iccid: "   " })).toBe(false);
	});
});

describe("firmwareRevision", () => {
	it("drops an absent or blank revision rather than rendering an empty line", () => {
		expect(firmwareRevision(undefined)).toBeUndefined();
		expect(firmwareRevision("")).toBeUndefined();
		expect(firmwareRevision("  ")).toBeUndefined();
	});

	it("trims a reported revision", () => {
		expect(firmwareRevision("  RM520NGL_1.0  ")).toBe("RM520NGL_1.0");
	});
});

describe("isStandingUsbRefusal", () => {
	it("names the two refusals that will answer identically on every retry", () => {
		expect(isStandingUsbRefusal("uncertified")).toBe(true);
		expect(isStandingUsbRefusal("provisioning_disabled")).toBe(true);
	});

	it("leaves every recoverable refusal on the retryable path", () => {
		for (const refusal of [
			"streaming_active",
			"transition_in_progress",
			"transition_failed",
			"unavailable_in_emulated_mode",
			undefined,
		]) {
			expect(isStandingUsbRefusal(refusal)).toBe(false);
		}
	});
});

describe("ownNumbers", () => {
	// The bench Quectel RM530N-GL's own SIM, as `mmcli -m 3` reported it live.
	const BOARD = "+573115422359";

	it("carries every number the carrier published, in order", () => {
		expect(ownNumbers([BOARD, "+573001112233"])).toEqual([
			BOARD,
			"+573001112233",
		]);
	});

	it("answers undefined for the common case — a SIM that published none", () => {
		expect(ownNumbers(undefined)).toBeUndefined();
		expect(ownNumbers([])).toBeUndefined();
	});

	it("drops blank members, and an all-blank list is absence", () => {
		expect(ownNumbers(["  ", BOARD, ""])).toEqual([BOARD]);
		expect(ownNumbers(["  ", ""])).toBeUndefined();
	});

	it("the mask carries no digits and no shape of the value", () => {
		expect(OWN_NUMBER_MASK).not.toMatch(/[0-9+]/);
		expect(OWN_NUMBER_MASK.length).toBeGreaterThan(0);
	});
});

describe("simIccid", () => {
	// The bench Quectel RM530N-GL's real ICCID, read live off `ceralive2`. It is
	// deliberately unredacted: an ICCID is printed on the card, unlike the
	// subscriber number above.
	const BOARD = "8957123102400060892";

	it("carries the value verbatim — there is no mask for this field", () => {
		expect(simIccid(BOARD)).toBe(BOARD);
	});

	it("answers undefined for a modem that reported none", () => {
		expect(simIccid(undefined)).toBeUndefined();
		expect(simIccid("")).toBeUndefined();
	});

	it("treats a locked SIM's blank answer as absence, never a value", () => {
		expect(simIccid("   ")).toBeUndefined();
	});
});
