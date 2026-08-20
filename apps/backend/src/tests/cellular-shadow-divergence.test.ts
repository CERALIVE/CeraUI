/**
 * Shadow divergence classification.
 *
 * Three properties are worth more than the happy-path table: a field only ONE
 * side reports is not a mismatch (the observer has no signal or operator field at
 * all, so the opposite rule would emit a false record per modem per cycle), two
 * vocabularies for the same radio fold onto one ladder before they are compared,
 * and a row nobody can join is dropped rather than invented into an `only-in-*`.
 */
import { describe, expect, test } from "bun:test";

import {
	classifyShadowDivergences,
	collectShadowStates,
	foldGeneration,
	foldGenerations,
	foldSignalBucket,
	logShadowDivergences,
	mmcliModemToShadowState,
	OPAQUE_DEVICE_KEY_PREFIX,
	observationRowToShadowState,
	opaqueDeviceKey,
	redactShadowDivergences,
	SHADOW_COMPARABLE_FIELDS,
	type ShadowModemState,
} from "../modules/cellular/shadow-divergence.ts";

function state(
	ifname: string,
	over: Partial<Omit<ShadowModemState, "deviceKey">> = {},
): ShadowModemState {
	return {
		deviceKey: opaqueDeviceKey(ifname),
		present: true,
		...over,
	};
}

describe("the comparable shape is a six-field non-secret allowlist", () => {
	test("it names exactly the six dimensions the plan fixes", () => {
		expect([...SHADOW_COMPARABLE_FIELDS].sort()).toEqual([
			"networkType",
			"operatorName",
			"present",
			"registration",
			"signalBucket",
			"simPresent",
		]);
	});

	test("an mmcli modem carrying SIM and APN secrets yields none of them", () => {
		const mapped = mmcliModemToShadowState({
			ifname: "wwan0",
			sim_network: "Movistar",
			status: { signal: 80, network: "Movistar", roaming: false },
			network_type: { active: "4G" },
			config: {
				apn: "internet.example",
				username: "carrier-user",
				password: "s3cr3t-apn-pass",
			},
			iccid: "8934071100003862105",
			imsi: "214075550001234",
			eid: "8904903200500888260003389115729",
		});
		expect(mapped).toBeDefined();
		expect(Object.keys(mapped as object).sort()).toEqual([
			"deviceKey",
			"networkType",
			"operatorName",
			"present",
			"signalBucket",
			"simPresent",
		]);
	});

	test("the device key is opaque, stable, and not the join key", () => {
		const key = opaqueDeviceKey("wwan0");
		expect(key.startsWith(OPAQUE_DEVICE_KEY_PREFIX)).toBe(true);
		expect(key).not.toContain("wwan0");
		expect(opaqueDeviceKey("wwan0")).toBe(key);
		expect(opaqueDeviceKey("wwan1")).not.toBe(key);
	});
});

describe("the three divergence classes", () => {
	test("identical states diverge on nothing", () => {
		const mmcli = [state("wwan0", { networkType: "4G" })];
		const dbus = [state("wwan0", { networkType: "4G" })];
		expect(classifyShadowDivergences(mmcli, dbus)).toEqual([]);
	});

	test("a modem only mmcli sees is only-in-mmcli", () => {
		const result = classifyShadowDivergences([state("wwan0")], []);
		expect(result).toEqual([
			{ deviceKey: opaqueDeviceKey("wwan0"), kind: "only-in-mmcli" },
		]);
	});

	test("a modem only the observer sees is only-in-dbus", () => {
		const result = classifyShadowDivergences([], [state("wwan1")]);
		expect(result).toEqual([
			{ deviceKey: opaqueDeviceKey("wwan1"), kind: "only-in-dbus" },
		]);
	});

	test("a shared modem disagreeing on a mutually-reported field is a field-mismatch", () => {
		const result = classifyShadowDivergences(
			[state("wwan0", { networkType: "4G", simPresent: true })],
			[state("wwan0", { networkType: "5G", simPresent: true })],
		);
		expect(result).toEqual([
			{
				deviceKey: opaqueDeviceKey("wwan0"),
				kind: "field-mismatch",
				fields: [{ field: "networkType", mmcli: "4G", dbus: "5G" }],
			},
		]);
	});

	test("both one-sided classes are reported in the same pass", () => {
		const kinds = classifyShadowDivergences(
			[state("wwan0")],
			[state("wwan9")],
		).map((d) => d.kind);
		expect(kinds.sort()).toEqual(["only-in-dbus", "only-in-mmcli"]);
	});

	test("presence really is a comparable field, not just a join question", () => {
		const result = classifyShadowDivergences(
			[state("wwan0", { present: true })],
			[state("wwan0", { present: false })],
		);
		expect(result[0]?.fields).toEqual([
			{ field: "present", mmcli: true, dbus: false },
		]);
	});
});

describe("divergence logging", () => {
	test("a genuine divergence is visible once, then repeated state is debug-only", () => {
		const visible: unknown[] = [];
		const debug: unknown[] = [];
		const seen = new Set<string>();
		const divergence = classifyShadowDivergences([state("wwan0")], []);

		logShadowDivergences(divergence, {
			seen,
			log: (_message, meta) => visible.push(meta),
			debug: (_message, meta) => debug.push(meta),
		});
		logShadowDivergences(divergence, {
			seen,
			log: (_message, meta) => visible.push(meta),
			debug: (_message, meta) => debug.push(meta),
		});

		expect(visible).toHaveLength(1);
		expect(debug).toHaveLength(1);
	});

	test("a changed divergence remains visible after a prior state", () => {
		const visible: unknown[] = [];
		const seen = new Set<string>();

		logShadowDivergences(classifyShadowDivergences([state("wwan0")], []), {
			seen,
			log: (_message, meta) => visible.push(meta),
		});
		logShadowDivergences(
			classifyShadowDivergences(
				[state("wwan0", { networkType: "4G" })],
				[state("wwan0", { networkType: "5G" })],
			),
			{
				seen,
				log: (_message, meta) => visible.push(meta),
			},
		);

		expect(visible).toHaveLength(2);
	});
});

describe("absence is not a mismatch", () => {
	test("a field only mmcli reports is skipped, not reported", () => {
		const result = classifyShadowDivergences(
			[state("wwan0", { signalBucket: "good", operatorName: "Movistar" })],
			[state("wwan0")],
		);
		expect(result).toEqual([]);
	});

	test("a field only the observer reports is skipped too", () => {
		const result = classifyShadowDivergences(
			[state("wwan0")],
			[state("wwan0", { registration: "home" })],
		);
		expect(result).toEqual([]);
	});

	test("a one-sided field does not mask a real mismatch beside it", () => {
		const result = classifyShadowDivergences(
			[state("wwan0", { signalBucket: "good", networkType: "4G" })],
			[state("wwan0", { networkType: "3G" })],
		);
		expect(result[0]?.fields).toEqual([
			{ field: "networkType", mmcli: "4G", dbus: "3G" },
		]);
	});
});

describe("vocabularies fold before they are compared", () => {
	test("mmcli 3G+ and the observer's umts are the same rung", () => {
		expect(foldGeneration("3G+")).toBe("3G");
		expect(foldGeneration("umts")).toBe("3G");
	});

	test("a 5G-NSA RAT set folds to the highest generation present", () => {
		expect(foldGenerations(["lte", "5gnr"])).toBe("5G");
	});

	test("an unknown token folds to nothing rather than to a guess", () => {
		expect(foldGeneration("cdma1x")).toBeUndefined();
		expect(foldGenerations(["cdma1x"])).toBeUndefined();
	});

	test("a 5G-NSA device does not diverge from mmcli's own highest-gen rule", () => {
		const mmcli = mmcliModemToShadowState({
			ifname: "wwan0",
			network_type: { active: "5G" },
		});
		const dbus = observationRowToShadowState({
			dataInterface: { present: true, name: "wwan0" },
			presence: "present",
			registration: { status: "home", activeRats: new Set(["lte", "5gnr"]) },
		});
		expect(
			classifyShadowDivergences(
				[mmcli as ShadowModemState],
				[dbus as ShadowModemState],
			),
		).toEqual([]);
	});

	test("signal quality is bucketed, so a two-point sampling drift is not a finding", () => {
		expect(foldSignalBucket(78)).toBe("excellent");
		expect(foldSignalBucket(80)).toBe("excellent");
		expect(foldSignalBucket(0)).toBe("none");
		expect(foldSignalBucket(undefined)).toBeUndefined();
		expect(foldSignalBucket(Number.NaN)).toBeUndefined();
	});
});

describe("conservative mmcli mappings", () => {
	test("registration is claimed only when mmcli PROVES roaming", () => {
		expect(
			mmcliModemToShadowState({ ifname: "wwan0", status: { roaming: true } })
				?.registration,
		).toBe("roaming");
		expect(
			mmcliModemToShadowState({ ifname: "wwan0", status: { roaming: false } })
				?.registration,
		).toBeUndefined();
	});

	test("simPresent is positive-evidence-only, never a false", () => {
		expect(
			mmcliModemToShadowState({ ifname: "wwan0" })?.simPresent,
		).toBeUndefined();
		expect(
			mmcliModemToShadowState({ ifname: "wwan0", sim_network: "Movistar" })
				?.simPresent,
		).toBe(true);
		expect(
			mmcliModemToShadowState({
				ifname: "wwan0",
				sim_lock: { required: "sim-pin" },
			})?.simPresent,
		).toBe(true);
	});

	test("a removed modem is present:false", () => {
		expect(
			mmcliModemToShadowState({ ifname: "wwan0", removed: true })?.present,
		).toBe(false);
	});
});

describe("conservative observer mappings", () => {
	test("the observer's own `unknown` registration is not a state to compare", () => {
		expect(
			observationRowToShadowState({
				dataInterface: { present: true, name: "wwan0" },
				registration: { status: "unknown", activeRats: new Set() },
			})?.registration,
		).toBeUndefined();
	});

	test("an EMPTY slot list is 'no slots reported', not 'no SIM'", () => {
		expect(
			observationRowToShadowState({
				dataInterface: { present: true, name: "wwan0" },
				simSlots: [],
			})?.simPresent,
		).toBeUndefined();
		expect(
			observationRowToShadowState({
				dataInterface: { present: true, name: "wwan0" },
				simSlots: [{ index: 1, occupied: false, active: true, lock: "none" }],
			})?.simPresent,
		).toBe(false);
	});

	test("the subscription id (ICCID/EID) is never read as a join key", () => {
		const mapped = observationRowToShadowState({
			presence: "present",
			identity: {
				equipmentId: { value: "351756051523999" },
				subscriptionId: "8934071100003862105",
				runtimePath: "/org/freedesktop/ModemManager1/Modem/0",
			},
			dataInterface: { present: false },
		});
		expect(mapped).toBeUndefined();
	});
});

describe("an unjoinable row is dropped, never invented into a divergence", () => {
	test("collectShadowStates counts what it could not join", () => {
		const set = collectShadowStates(
			[{ ifname: "wwan0" }, { ifname: undefined }, { ifname: "wwan1" }],
			mmcliModemToShadowState,
		);
		expect(set.states).toHaveLength(2);
		expect(set.unjoinable).toBe(1);
	});

	test("an observer row with no data interface never becomes only-in-dbus", () => {
		const dbus = collectShadowStates(
			[{ presence: "present", dataInterface: { present: false } }],
			observationRowToShadowState,
		);
		expect(dbus.states).toEqual([]);
		expect(dbus.unjoinable).toBe(1);
		expect(classifyShadowDivergences([], dbus.states)).toEqual([]);
	});
});

describe("the log payload is redacted and keyed by the opaque id", () => {
	test("field mismatches are re-keyed by field name for the key-based redactors", () => {
		const payload = redactShadowDivergences([
			{
				deviceKey: opaqueDeviceKey("wwan0"),
				kind: "field-mismatch",
				fields: [{ field: "networkType", mmcli: "4G", dbus: "5G" }],
			},
		]) as { count: number; divergences: Array<Record<string, unknown>> };
		expect(payload.count).toBe(1);
		expect(payload.divergences[0]?.fields).toEqual({
			networkType: { mmcli: "4G", dbus: "5G" },
		});
	});
});
