/**
 * The pure half of the ModemManager normalized reading.
 *
 * The rule under test is one sentence — `unsupported` ≠ `not-reported` ≠
 * `not-observed` — and the whole reason the wire carries a discriminated union
 * instead of a nullable number. So the tables below are exhaustive over the
 * SEVEN-member reason enum and the FIVE-member evidence union rather than
 * sampling them: a reason that reaches an operator as somebody else's sentence
 * is exactly as wrong as one that reaches them as a raw token, and only a total
 * sweep catches a table that lost an entry.
 */

import type {
	ModemMetricUnknownReason,
	ModemRegistrationContext,
	ModemSignalDetail,
	ModemSimPresenceEvidence,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	hasNormalizedReading,
	MODEM_METRIC_REASON_KEYS,
	modemMetricReasonKey,
	qualityRecency,
	registrationRows,
	SUPERSEDED_CELL_METRIC_KEYS,
	signalDetailRows,
	simPresenceEvidenceHint,
} from "./signal-detail";

const ALL_REASONS: readonly ModemMetricUnknownReason[] = [
	"unsupported",
	"not-reported",
	"not-observed",
	"malformed",
	"auth-expired",
	"refused",
	"unreachable",
];

const known = (value: number) => ({ state: "known", value }) as const;
const unknown = (reason: ModemMetricUnknownReason) =>
	({ state: "unknown", reason }) as const;
const text = (value: string) => ({ state: "known", value }) as const;

/** Every metric known — the shape a fully-primed LTE read produces. */
function fullDetail(): ModemSignalDetail {
	return {
		quality_recent: { state: "known", value: true },
		rsrp: known(-92),
		rsrq: known(-11),
		snr: known(7),
		sinr: unknown("not-reported"),
	};
}

/** The bench's real registration answer: operator known, cell masked. */
function benchRegistration(): ModemRegistrationContext {
	return {
		operator_name: text("Claro"),
		operator_code: text("73201"),
		cell_id: unknown("not-observed"),
		tac: unknown("not-observed"),
	};
}

describe("signalDetailRows — four measurements, in reading order", () => {
	it("renders every metric with its OWN unit", () => {
		const rows = signalDetailRows(fullDetail());

		expect(rows.map((row) => row.id)).toEqual(["rsrp", "rsrq", "snr", "sinr"]);
		expect(rows[0]).toMatchObject({ state: "known", value: "-92 dBm" });
		expect(rows[1]).toMatchObject({ state: "known", value: "-11 dB" });
		expect(rows[2]).toMatchObject({ state: "known", value: "7 dB" });
	});

	it("keeps RSRP in dBm and the three ratios in dB", () => {
		const rows = signalDetailRows({
			quality_recent: { state: "known", value: true },
			rsrp: known(-100),
			rsrq: known(-10),
			snr: known(3),
			sinr: known(4),
		});

		const units = rows.map((row) =>
			row.state === "known" ? row.value.split(" ")[1] : undefined,
		);
		expect(units).toEqual(["dBm", "dB", "dB", "dB"]);
	});

	// The block is TOTAL on the wire, so a dropped row would silently shrink a
	// fixed-shape strip and read as a partial render on the modem beside it.
	it("keeps a row for EVERY reason class, `unsupported` included", () => {
		for (const reason of ALL_REASONS) {
			const rows = signalDetailRows({
				quality_recent: unknown(reason),
				rsrp: unknown(reason),
				rsrq: unknown(reason),
				snr: unknown(reason),
				sinr: unknown(reason),
			});

			expect(rows).toHaveLength(4);
			for (const row of rows) {
				expect(row.state).toBe("unknown");
				if (row.state !== "unknown") continue;
				expect(row.reason).toBe(reason);
				expect(row.reasonKey).toBe(MODEM_METRIC_REASON_KEYS[reason]);
			}
		}
	});

	it("gives each of the seven reasons a DISTINCT key", () => {
		const keys = ALL_REASONS.map(modemMetricReasonKey);
		expect(new Set(keys).size).toBe(ALL_REASONS.length);
	});

	// A CAST broadcast can put a non-number behind `state: 'known'`. `NaN dBm`
	// where a measurement belongs is worse than the honest reason.
	it("reads a non-finite `known` value as `malformed`", () => {
		const rows = signalDetailRows({
			quality_recent: { state: "known", value: true },
			rsrp: { state: "known", value: Number.NaN },
			rsrq: known(-11),
			snr: known(7),
			sinr: known(4),
		});

		expect(rows[0]).toMatchObject({ state: "unknown", reason: "malformed" });
	});

	// An absent BLOCK is "this backend did not observe it", never "the modem has
	// none" — the mmcli path reads no signal interface at all.
	it("renders NOTHING for a backend that published no block", () => {
		expect(signalDetailRows(undefined)).toEqual([]);
	});
});

describe("qualityRecency — when the MODEM measured, not when we read", () => {
	it("reports a live measurement", () => {
		expect(qualityRecency(fullDetail())).toMatchObject({ state: "recent" });
	});

	it("reports the modem's cached reading as cached", () => {
		expect(
			qualityRecency({
				...fullDetail(),
				quality_recent: { state: "known", value: false },
			}),
		).toMatchObject({ state: "cached" });
	});

	it("carries the reason through for every unknown class", () => {
		for (const reason of ALL_REASONS) {
			expect(
				qualityRecency({ ...fullDetail(), quality_recent: unknown(reason) }),
			).toEqual({
				state: "unknown",
				reason,
				labelKey: MODEM_METRIC_REASON_KEYS[reason],
			});
		}
	});

	it("answers nothing for an absent block", () => {
		expect(qualityRecency(undefined)).toBeUndefined();
	});
});

describe("registrationRows — which network, which cell", () => {
	it("renders the operator and the masked cell in one strip", () => {
		const rows = registrationRows(benchRegistration());

		expect(rows.map((row) => row.id)).toEqual([
			"operator_name",
			"operator_code",
			"cell_id",
			"tac",
		]);
		expect(rows[0]).toMatchObject({ state: "known", value: "Claro" });
		expect(rows[1]).toMatchObject({ state: "known", value: "73201" });
	});

	// THE FENCE, not a gap: the cell property stays masked unless a location
	// source is primed, which this device never does.
	it("renders `not-observed` for the cell identifiers every board reports", () => {
		const rows = registrationRows(benchRegistration());

		expect(rows[2]).toMatchObject({
			state: "unknown",
			reason: "not-observed",
			reasonKey: MODEM_METRIC_REASON_KEYS["not-observed"],
		});
		expect(rows[3]).toMatchObject({ state: "unknown", reason: "not-observed" });
	});

	it("keeps the operator code TEXT so a leading zero survives", () => {
		const rows = registrationRows({
			...benchRegistration(),
			operator_code: text("07201"),
		});

		expect(rows[1]).toMatchObject({ state: "known", value: "07201" });
	});

	// A blank string behind `known` is a field the producer could not fill —
	// an empty cell would read as a successful read of nothing.
	it("reads a blank identifier as `malformed`", () => {
		const rows = registrationRows({
			...benchRegistration(),
			operator_name: text("   "),
		});

		expect(rows[0]).toMatchObject({ state: "unknown", reason: "malformed" });
	});

	it("renders NOTHING for a backend that published no block", () => {
		expect(registrationRows(undefined)).toEqual([]);
	});
});

describe("simPresenceEvidenceHint — WHICH FACT decided it", () => {
	const cases: readonly ModemSimPresenceEvidence[] = [
		{ kind: "sim-object-path", field: "sim", value: "/SIM/0" },
		{ kind: "sim-slot-object-path", field: "simSlots", value: "/SIM/1" },
		{
			kind: "state-failed-reason",
			field: "failedReason",
			value: "sim-missing",
		},
		{ kind: "no-evidence", inspected: ["sim", "simSlots", "failedReason"] },
		{ kind: "vendor-code-unclaimed", field: "SimStatus" },
	];

	it("keys every evidence kind to its own copy", () => {
		const keys = cases.map(
			(evidence) => simPresenceEvidenceHint(evidence)?.key ?? "",
		);
		expect(new Set(keys).size).toBe(cases.length);
		expect(
			keys.every((key) => key.startsWith("network.modem.simEvidence.")),
		).toBe(true);
	});

	// `absent` is reachable through exactly ONE kind, and that is what makes
	// "never inferred from a blank field" verifiable rather than a promise.
	it("marks ONLY the failed-reason kind as a positive empty-slot statement", () => {
		const stating = cases
			.map((evidence) => simPresenceEvidenceHint(evidence))
			.filter((hint) => hint?.statesEmptySlot === true)
			.map((hint) => hint?.kind);

		expect(stating).toEqual(["state-failed-reason"]);
	});

	it("carries the inspected COUNT, never the field names", () => {
		const hint = simPresenceEvidenceHint({
			kind: "no-evidence",
			inspected: ["sim", "simSlots", "failedReason"],
		});

		expect(hint?.params).toEqual({ count: 3 });
	});

	// Every `value` on the union is a device path or a wire token; none may
	// travel into operator copy (OL-2).
	it("carries no raw device value on any kind", () => {
		for (const evidence of cases) {
			const hint = simPresenceEvidenceHint(evidence);
			const serialized = JSON.stringify(hint ?? {});
			expect(serialized).not.toContain("sim-missing");
			expect(serialized).not.toContain("/SIM/");
			expect(serialized).not.toContain("SimStatus");
		}
	});

	it("answers nothing for a backend that published no evidence", () => {
		expect(simPresenceEvidenceHint(undefined)).toBeUndefined();
	});
});

describe("the normalized block supersedes the legacy quality strip", () => {
	it("names exactly the four quantities both blocks can express", () => {
		expect([...SUPERSEDED_CELL_METRIC_KEYS].sort()).toEqual([
			"rsrp",
			"rsrq",
			"sinr",
			"snr",
		]);
	});

	it("opens the detail card on either block alone", () => {
		expect(hasNormalizedReading({ signal_detail: fullDetail() })).toBe(true);
		expect(
			hasNormalizedReading({ registration_context: benchRegistration() }),
		).toBe(true);
		expect(hasNormalizedReading({})).toBe(false);
	});
});
