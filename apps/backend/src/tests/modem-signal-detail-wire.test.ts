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

/**
 * MM SIGNAL DETAIL, CELL CONTEXT AND SIM EVIDENCE REACH THE WIRE — AS READINGS
 * THAT KEEP THEIR REASON.
 *
 * The whole point of these three blocks is that an absent value still SAYS
 * SOMETHING, so the suite is organized around the distinctions a bare `null`
 * would have destroyed rather than around the happy path:
 *
 *   · `unsupported`   — the source cannot express this datum at all
 *   · `not-reported`  — it answered and this reading was not in the answer
 *   · `not-observed`  — nobody read the interface it lives on
 *   · `malformed`     — it was there and could not be decoded
 *
 * Every fixture is driven through the REAL `foldDbusModemViews` and the REAL
 * `projectModemWire`, because a hand-built view literal sits downstream of the
 * derivation under test and would prove only that the projector copies fields.
 */

import { describe, expect, test } from "bun:test";

import {
	modemSchema,
	modemSignalDetailSchema,
	modemSimPresenceEvidenceSchema,
} from "@ceraui/rpc/schemas";

import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import { redactShadowPayload } from "../modules/cellular/shadow-redaction.ts";
import {
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import { readSimPresenceEvidence } from "../modules/modems/sim-presence.ts";
import {
	MM_FAILED_REASON_SIM_MISSING,
	MM_LOCATION_SOURCE_3GPP_LAC_CI,
	type ModemFixture,
	modemObjects,
} from "./support/mm-tree-fixture.ts";

const MODEM_PATH = "/org/freedesktop/ModemManager1/Modem/0";
const SIM_PATH = "/org/freedesktop/ModemManager1/SIM/0";

/** A board-shaped LTE reading: the three quantities an LTE dict really carries. */
const LTE_DICT = { rsrp: -95, rsrq: -11, snr: 12.5 } as const;
/** An NR dict on the same NSA attach — DIFFERENT carriers, different numbers. */
const NR5G_DICT = { rsrp: -80, rsrq: -9, snr: 20 } as const;

function foldOne(fixture: Partial<ModemFixture> = {}) {
	const [view] = foldDbusModemViews(
		modemObjects({ path: MODEM_PATH, ifname: "wwan0", ...fixture }),
	);
	if (view === undefined) {
		throw new Error("fold produced no view");
	}
	return view;
}

function signalOf(fixture: Partial<ModemFixture> = {}) {
	const detail = foldOne(fixture).signalDetail;
	if (detail === undefined) {
		throw new Error("fold produced no signal detail");
	}
	return detail;
}

function contextOf(fixture: Partial<ModemFixture> = {}) {
	const context = foldOne(fixture).registrationContext;
	if (context === undefined) {
		throw new Error("fold produced no registration context");
	}
	return context;
}

function wireEntry(fixture: Partial<ModemFixture> = {}) {
	const projected = projectModemWire([fromDbusView(foldOne(fixture))], {
		hasGsmAutoconfig: false,
	});
	const entry = projected.message["0"];
	if (entry === undefined) {
		throw new Error("projection produced no entry for modem 0");
	}
	return entry;
}

describe("the extended Modem.Signal reading reaches the wire", () => {
	test("an LTE dict supplies rsrp / rsrq / snr verbatim", () => {
		const signal = signalOf({ extendedSignal: { Lte: LTE_DICT } });

		expect(signal.rsrp).toEqual({ state: "known", value: -95 });
		expect(signal.rsrq).toEqual({ state: "known", value: -11 });
		expect(signal.snr).toEqual({ state: "known", value: 12.5 });
	});

	test("on an NSA attach the NEWER RAT wins and NOTHING is merged", () => {
		const signal = signalOf({
			extendedSignal: { Nr5g: NR5G_DICT, Lte: LTE_DICT },
		});

		// The two dicts measure two different carriers, so a ladder must pick one
		// reading. Averaging or summing them would publish a number no radio ever
		// measured.
		expect(signal.rsrp).toEqual({ state: "known", value: -80 });
		expect(signal.rsrq).toEqual({ state: "known", value: -9 });
		expect(signal.snr).toEqual({ state: "known", value: 20 });
	});

	test("an LTE-only modem falls back to the Lte rung when Nr5g is silent", () => {
		const signal = signalOf({
			extendedSignal: { Nr5g: {}, Lte: LTE_DICT },
		});

		expect(signal.rsrp).toEqual({ state: "known", value: -95 });
	});

	test("`sinr` is claimed from the Evdo dict, which is the only one that has it", () => {
		const signal = signalOf({ extendedSignal: { Evdo: { sinr: 7.5 } } });

		expect(signal.sinr).toEqual({ state: "known", value: 7.5 });
	});

	test("an LTE/NR modem answers `not-reported` for sinr — NEVER `unsupported`", () => {
		const signal = signalOf({
			extendedSignal: { Nr5g: NR5G_DICT, Lte: LTE_DICT },
		});

		// ModemManager CAN express SINR (its Evdo dict does), so claiming the
		// source cannot would be a capability claim MM itself disproves. This
		// modem simply did not report one — a read-class unknown.
		expect(signal.sinr).toEqual({ state: "unknown", reason: "not-reported" });
		expect(signal.sinr).not.toEqual({
			state: "unknown",
			reason: "unsupported",
		});
	});

	test("an unread Signal interface is `not-observed`, which is NOT `not-reported`", () => {
		const signal = signalOf();

		for (const metric of [signal.rsrp, signal.rsrq, signal.snr, signal.sinr]) {
			expect(metric).toEqual({ state: "unknown", reason: "not-observed" });
		}
	});

	test("a PRIMED interface whose dicts are empty is `not-reported`", () => {
		const signal = signalOf({ extendedSignal: { Lte: {}, Nr5g: {} } });

		// The distinction this asserts is the whole contract: "we never looked"
		// and "we looked and the modem said nothing" are different operator facts
		// and reach the wire as different reasons.
		for (const metric of [signal.rsrp, signal.rsrq, signal.snr]) {
			expect(metric).toEqual({ state: "unknown", reason: "not-reported" });
		}
		expect(signalOf().rsrp).toEqual({
			state: "unknown",
			reason: "not-observed",
		});
	});

	test("a member that is present and undecodable is `malformed`, not absent", () => {
		const signal = signalOf({
			extendedSignal: { Lte: { rsrp: "n/a", rsrq: -11 } },
		});

		expect(signal.rsrp).toEqual({ state: "unknown", reason: "malformed" });
		expect(signal.rsrq).toEqual({ state: "known", value: -11 });
	});

	test.each(["rsrp", "rsrq", "snr", "sinr"] as const)(
		"`%s` is always STATED — a value or a reason, never omitted",
		(member) => {
			for (const fixture of [
				{},
				{ extendedSignal: {} },
				{ extendedSignal: { Lte: LTE_DICT } },
				{ extendedSignal: { Evdo: { sinr: 7.5 } } },
			] satisfies Partial<ModemFixture>[]) {
				const signal = signalOf(fixture);
				expect(Object.hasOwn(signal, member)).toBe(true);
				expect(signal[member].state).toMatch(/^(known|unknown)$/);
			}
		},
	);

	test("the whole block parses against the published schema", () => {
		expect(() =>
			modemSignalDetailSchema.parse(
				signalOf({ extendedSignal: { Lte: LTE_DICT, Evdo: { sinr: 7.5 } } }),
			),
		).not.toThrow();
	});
});

describe("qualityRecent — the boolean beside the percentage", () => {
	test.each([true, false])(
		"`SignalQuality`'s `(ub)` boolean %p reaches the wire",
		(recent) => {
			expect(signalOf({ signalRecent: recent }).quality_recent).toEqual({
				state: "known",
				value: recent,
			});
		},
	);

	test("a stale reading does NOT change the percentage `status.signal` carries", () => {
		const stale = wireEntry({ signal: 40, signalRecent: false });

		// The two are separate facts about one measurement: the percentage is
		// unchanged and byte-identical to the pre-existing wire, while the recency
		// rides the additive block.
		expect(stale.status?.signal).toBe(40);
		expect(stale.signal_detail?.quality_recent).toEqual({
			state: "known",
			value: false,
		});
	});

	test("a modem that published no SignalQuality reports `not-reported`", () => {
		expect(signalOf({ omitSignalQuality: true }).quality_recent).toEqual({
			state: "unknown",
			reason: "not-reported",
		});
	});
});

describe("registration context — which network, which cell", () => {
	test("the operator NAME and CODE are carried as text, unparsed", () => {
		const context = contextOf({ operatorName: "TIGO", operatorCode: "732103" });

		expect(context.operator_name).toEqual({ state: "known", value: "TIGO" });
		// TEXT, never a number: the MNC width is significant, so a numeric
		// round-trip of `732103` and `73210` would name the same network twice.
		expect(context.operator_code).toEqual({
			state: "known",
			value: "732103",
		});
	});

	test("ModemManager's empty string is ABSENCE, not an empty operator name", () => {
		const context = contextOf({ operatorName: "", operatorCode: "" });

		expect(context.operator_name).toEqual({
			state: "unknown",
			reason: "not-reported",
		});
		expect(context.operator_code).toEqual({
			state: "unknown",
			reason: "not-reported",
		});
	});

	test("the `3gpp-lac-ci` entry yields CID and TAC, in MM's own hex spelling", () => {
		const context = contextOf({
			location: {
				[MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103,1A2B,0A1B2C3D,00FF",
			},
		});

		// Read as decimal, `0A1B2C3D` renders `169552957`, which matches nothing
		// `mmcli` or a vendor UI shows. The tokens stay the source's own text.
		expect(context.cell_id).toEqual({ state: "known", value: "0A1B2C3D" });
		expect(context.tac).toEqual({ state: "known", value: "00FF" });
	});

	test("a 2G/3G attach has no TAC, and only the TAC says so", () => {
		const context = contextOf({
			location: { [MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103,1A2B,0A1B2C3D," },
		});

		expect(context.cell_id).toEqual({ state: "known", value: "0A1B2C3D" });
		expect(context.tac).toEqual({ state: "unknown", reason: "not-reported" });
	});

	test("an undecodable value makes BOTH malformed — never a half-decoded cell", () => {
		const context = contextOf({
			location: { [MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103" },
		});

		expect(context.cell_id).toEqual({ state: "unknown", reason: "malformed" });
		expect(context.tac).toEqual({ state: "unknown", reason: "malformed" });
	});

	test("with no Location interface the honest answer is `not-observed`", () => {
		const context = contextOf();

		// This IS the shipped steady state, and it is the fence rather than a gap:
		// MM masks the Location property unless `Location.Setup` ran with
		// `signal_location = true`, which is permanently forbidden here.
		expect(context.cell_id).toEqual({
			state: "unknown",
			reason: "not-observed",
		});
		expect(context.tac).toEqual({ state: "unknown", reason: "not-observed" });
	});

	test("an EXPOSED but silent Location interface is `not-reported` instead", () => {
		const context = contextOf({ location: {} });

		expect(context.cell_id).toEqual({
			state: "unknown",
			reason: "not-reported",
		});
	});

	test("the block claims no EARFCN, under either of MM's two key names", () => {
		const serialized = JSON.stringify(
			contextOf({
				location: {
					[MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103,1A2B,0A1B2C3D,00FF",
				},
			}),
		);

		// MM publishes `earfcn` (LTE) and `nrarfcn` (5GNR) only per-cell, for two
		// DIFFERENT quantities, so one normalized slot would have to merge them or
		// silently pick a RAT. This block makes no ARFCN claim at all.
		expect(serialized).not.toContain("earfcn");
		expect(serialized).not.toContain("arfcn");
	});
});

describe("SIM presence evidence — WHICH FACT decided the answer", () => {
	test("a named SIM object is the evidence for `present`", () => {
		const view = foldOne({ simPath: SIM_PATH });

		expect(view.simPresence).toBe("present");
		expect(view.simPresenceEvidence).toEqual({
			kind: "sim-object-path",
			field: "sim",
			value: SIM_PATH,
		});
	});

	test("a populated SLOT is its own evidence, and the empty `/` slot is skipped", () => {
		const view = foldOne({
			simSlots: ["/", "/org/freedesktop/ModemManager1/SIM/2"],
		});

		expect(view.simPresence).toBe("present");
		expect(view.simPresenceEvidence).toEqual({
			kind: "sim-slot-object-path",
			field: "simSlots",
			value: "/org/freedesktop/ModemManager1/SIM/2",
		});
	});

	test("`absent` names the failed reason that produced it", () => {
		const view = foldOne({ stateFailedReason: MM_FAILED_REASON_SIM_MISSING });

		expect(view.simPresence).toBe("absent");
		expect(view.simPresenceEvidence).toEqual({
			kind: "state-failed-reason",
			field: "failedReason",
			value: "sim-missing",
		});
	});

	test("`unknown` names the fields it INSPECTED, so silence is auditable", () => {
		const view = foldOne();

		expect(view.simPresence).toBeUndefined();
		expect(view.simPresenceEvidence).toEqual({
			kind: "no-evidence",
			inspected: ["sim", "simSlots", "failedReason"],
		});
	});

	test("evidence rides an UNKNOWN row too — it is never present-only-when-decisive", () => {
		// A present-only-when-decisive field could be raised and never lowered on
		// a merging consumer (the `policy_route_missing` latch), and the `unknown`
		// row is precisely the one an operator needs the evidence for.
		expect(foldOne().simPresenceEvidence).toBeDefined();
		expect(wireEntry().sim_presence_evidence).toBeDefined();
	});

	test("`absent` is reachable through EXACTLY ONE evidence kind", () => {
		const readings = [
			readSimPresenceEvidence({}),
			readSimPresenceEvidence({ sim: "/" }),
			readSimPresenceEvidence({ sim: SIM_PATH }),
			readSimPresenceEvidence({ simSlots: ["/", "/"] }),
			readSimPresenceEvidence({ simSlots: [SIM_PATH] }),
			readSimPresenceEvidence({ failedReason: "sim-missing" }),
			readSimPresenceEvidence({ failedReason: "unknown-capabilities" }),
			readSimPresenceEvidence({ sim: SIM_PATH, failedReason: "sim-missing" }),
		];

		// This is the audit that makes "never inferred from a blank field" a
		// property rather than a promise: nothing but MM's own positive
		// `sim-missing` statement may ever answer `absent`.
		const absentKinds = readings
			.filter((reading) => reading.presence === "absent")
			.map((reading) => reading.evidence.kind);
		expect(new Set(absentKinds)).toEqual(new Set(["state-failed-reason"]));
		expect(absentKinds.length).toBe(1);
	});

	test("a named SIM object OUTRANKS a stale sim-missing failure", () => {
		const reading = readSimPresenceEvidence({
			sim: SIM_PATH,
			failedReason: "sim-missing",
		});

		expect(reading.presence).toBe("present");
	});

	test("every evidence shape parses against the published union", () => {
		for (const fixture of [
			{},
			{ simPath: SIM_PATH },
			{ simSlots: ["/", "/org/freedesktop/ModemManager1/SIM/2"] },
			{ stateFailedReason: MM_FAILED_REASON_SIM_MISSING },
		] satisfies Partial<ModemFixture>[]) {
			expect(() =>
				modemSimPresenceEvidenceSchema.parse(
					foldOne(fixture).simPresenceEvidence,
				),
			).not.toThrow();
		}
	});
});

describe("the projection is ADDITIVE — nothing existing moved", () => {
	test("all three blocks reach the wire entry and it parses as a modem", () => {
		const entry = wireEntry({
			operatorName: "TIGO",
			operatorCode: "732103",
			simPath: SIM_PATH,
			extendedSignal: { Lte: LTE_DICT },
			location: {
				[MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103,1A2B,0A1B2C3D,00FF",
			},
		});

		expect(entry.signal_detail?.rsrp).toEqual({ state: "known", value: -95 });
		expect(entry.registration_context?.operator_code).toEqual({
			state: "known",
			value: "732103",
		});
		expect(entry.sim_presence_evidence?.kind).toBe("sim-object-path");
		expect(() => modemSchema.parse(entry)).not.toThrow();
	});

	test("the legacy `status` block is untouched by the new detail", () => {
		const before = wireEntry({ operatorName: "TIGO", signal: 61 });
		const after = wireEntry({
			operatorName: "TIGO",
			signal: 61,
			operatorCode: "732103",
			extendedSignal: { Lte: LTE_DICT },
		});

		expect(after.status).toEqual(before.status);
		expect(after.network_type).toEqual(before.network_type);
		expect(after.ifname).toBe(before.ifname);
	});

	test("an mmcli row gains NONE of the three — absence is that backend's answer", () => {
		const modem: Modem = {
			ifname: "wwan0",
			name: "Quectel RM530N-GL",
			network_type: { supported: {}, active: null },
			status: {
				connection: "connected",
				network_type: "5G",
				signal: 72,
				roaming: false,
			},
		};

		const entry = projectModemWire([fromMmcliModem(0, modem)], {
			hasGsmAutoconfig: false,
		}).message["0"];

		// The mmcli path observes no `Modem.Signal` interface at all, so publishing
		// four `not-observed` metrics would claim a read it never attempted.
		expect(Object.hasOwn(entry ?? {}, "signal_detail")).toBe(false);
		expect(Object.hasOwn(entry ?? {}, "registration_context")).toBe(false);
		expect(Object.hasOwn(entry ?? {}, "sim_presence_evidence")).toBe(false);
	});

	test("a payload predating all three still parses, and gains no default", () => {
		const legacy = {
			ifname: "wwan0",
			name: "legacy",
			network_type: { supported: [], active: null },
		};
		const parsed = modemSchema.parse(legacy);

		expect(Object.hasOwn(parsed, "signal_detail")).toBe(false);
		expect(Object.hasOwn(parsed, "registration_context")).toBe(false);
		expect(Object.hasOwn(parsed, "sim_presence_evidence")).toBe(false);
	});
});

describe("no unredacted diagnostics ride the new blocks", () => {
	const RICH = {
		operatorName: "TIGO",
		operatorCode: "732103",
		simPath: SIM_PATH,
		iccid: "8934071100000000001",
		ownNumbers: ["+573001112233"],
		equipmentId: "356938035643809",
		extendedSignal: { Lte: LTE_DICT, Evdo: { sinr: 7.5 } },
		location: {
			[MM_LOCATION_SOURCE_3GPP_LAC_CI]: "732,103,1A2B,0A1B2C3D,00FF",
		},
	} satisfies Partial<ModemFixture>;

	test("the three blocks carry no subscriber identifier at all", () => {
		const entry = wireEntry(RICH);
		const serialized = JSON.stringify({
			signal_detail: entry.signal_detail,
			registration_context: entry.registration_context,
			sim_presence_evidence: entry.sim_presence_evidence,
		});

		// The sensitive values ARE on the row (`iccid`, `own_numbers`) and are
		// governed by their own established rules; what this asserts is that the
		// three NEW blocks introduced no second carrier for any of them.
		for (const secret of [
			"8934071100000000001",
			"+573001112233",
			"356938035643809",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("the SIM evidence value is an object PATH, never a card identifier", () => {
		const evidence = wireEntry(RICH).sim_presence_evidence;

		expect(evidence).toEqual({
			kind: "sim-object-path",
			field: "sim",
			value: SIM_PATH,
		});
		expect(SIM_PATH).toMatch(/^\/org\/freedesktop\/ModemManager1\/SIM\/\d+$/);
	});

	test("the existing shadow redaction passes the blocks through unchanged", () => {
		const entry = wireEntry(RICH);
		const blocks = {
			signal_detail: entry.signal_detail,
			registration_context: entry.registration_context,
			sim_presence_evidence: entry.sim_presence_evidence,
		};

		// A diagnostic dump of these blocks is SAFE, and this proves it against
		// the real redactor rather than by inspection: nothing in them is a
		// sensitive key, so the shape survives intact and no value is blanked.
		expect(redactShadowPayload(blocks)).toEqual(blocks);
		expect(JSON.stringify(redactShadowPayload(blocks))).not.toContain(
			"[REDACTED]",
		);
	});

	test("a sensitive sibling on the SAME row is still redacted", () => {
		const entry = wireEntry(RICH);
		const redacted = JSON.stringify(redactShadowPayload(entry));

		// The non-vacuity control for the test above: the redactor really is
		// running, and it really does blank the classes it owns.
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain("8934071100000000001");
	});
});
