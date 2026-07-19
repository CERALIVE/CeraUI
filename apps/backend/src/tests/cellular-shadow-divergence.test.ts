import { describe, expect, test } from "bun:test";

import {
	classifyShadowDivergences,
	logShadowDivergences,
	mmcliModemToShadowState,
	observationRowToShadowState,
	redactShadowDivergences,
	SHADOW_DIVERGENCE_MSG,
	type ShadowModemState,
} from "../modules/cellular/shadow-divergence.ts";

function state(
	overrides: Partial<ShadowModemState> & { id: string },
): ShadowModemState {
	return { present: true, ...overrides };
}

function capture(): {
	lines: Array<{ msg: string; meta: unknown }>;
	log: (msg: string, meta: unknown) => void;
} {
	const lines: Array<{ msg: string; meta: unknown }> = [];
	return { lines, log: (msg, meta) => lines.push({ msg, meta }) };
}

describe("modem shadow — divergence classifier", () => {
	test("identical states produce zero divergences", () => {
		const mmcli = [
			state({
				id: "wwan0",
				registration: "registered",
				operatorName: "Carrier",
			}),
		];
		const dbus = [
			state({
				id: "wwan0",
				registration: "registered",
				operatorName: "Carrier",
			}),
		];
		expect(classifyShadowDivergences(mmcli, dbus)).toEqual([]);
	});

	test("a modem only mmcli sees is reported as only-in-mmcli", () => {
		const divs = classifyShadowDivergences([state({ id: "wwan0" })], []);
		expect(divs).toEqual([{ id: "wwan0", kind: "only-in-mmcli" }]);
	});

	test("a modem only the shadow observer sees is reported as only-in-dbus", () => {
		const divs = classifyShadowDivergences([], [state({ id: "wwan1" })]);
		expect(divs).toEqual([{ id: "wwan1", kind: "only-in-dbus" }]);
	});

	test("field mismatches on a shared modem are enumerated field-by-field", () => {
		const divs = classifyShadowDivergences(
			[state({ id: "wwan0", registration: "registered", networkType: "5g" })],
			[state({ id: "wwan0", registration: "searching", networkType: "5g" })],
		);
		expect(divs).toEqual([
			{
				id: "wwan0",
				kind: "field-mismatch",
				fields: [
					{ field: "registration", mmcli: "registered", dbus: "searching" },
				],
			},
		]);
	});
});

describe("modem shadow — redacted divergence logging (reuses logRedact)", () => {
	test("secret-shaped values in a divergence are redacted in the logged output", () => {
		// A divergence carrying secret-SHAPED and secret-KEYED values. logRedact must
		// scrub each before it reaches any transport.
		const divs = classifyShadowDivergences(
			[
				state({
					id: "wwan0",
					operatorName: "v4.public.LEAKED-paseto-token-abc",
				}),
			],
			[
				state({
					id: "wwan0",
					operatorName: "Bearer sk_live_SECRET_credential_value",
				}),
			],
		);
		const { lines, log } = capture();
		logShadowDivergences(divs, { log });

		expect(lines).toHaveLength(1);
		expect(lines[0]?.msg).toBe(SHADOW_DIVERGENCE_MSG);
		const serialized = JSON.stringify(lines[0]?.meta);
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).not.toContain("LEAKED-paseto-token-abc");
		expect(serialized).not.toContain("sk_live_SECRET_credential_value");
	});

	test("a value under a sensitive key (pin) is redacted", () => {
		// redactShadowDivergences must scrub a pin-keyed value via the shared helper.
		const redacted = redactShadowDivergences([
			{
				id: "wwan0",
				kind: "field-mismatch",
				fields: [{ field: "simPin", mmcli: "1234", dbus: "9999" }],
			},
		]);
		const serialized = JSON.stringify(redacted);
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).not.toContain("1234");
		expect(serialized).not.toContain("9999");
	});

	test("empty divergences never emit a log line", () => {
		const { lines, log } = capture();
		logShadowDivergences([], { log });
		expect(lines).toEqual([]);
	});
});

describe("modem shadow — secret-dropping state mappers", () => {
	test("mmcli mapper copies only non-secret fields and drops ICCID/PIN/APN/password", () => {
		const mapped = mmcliModemToShadowState({
			id: "wwan0",
			present: true,
			registration: "registered",
			operatorName: "Carrier",
			networkType: "5g",
			simPresent: true,
			// secrets that MUST NOT survive the mapping:
			iccid: "8934071100003141592",
			pin: "1234",
			apn: "secret.apn.example",
			password: "hunter2",
		});

		expect(mapped).toEqual({
			id: "wwan0",
			present: true,
			registration: "registered",
			operatorName: "Carrier",
			networkType: "5g",
			simPresent: true,
		});
		const serialized = JSON.stringify(mapped);
		expect(serialized).not.toContain("8934071100003141592");
		expect(serialized).not.toContain("1234");
		expect(serialized).not.toContain("secret.apn.example");
		expect(serialized).not.toContain("hunter2");
	});

	test("observation mapper keys on the equipment/slot id, never the subscription id (ICCID/EID)", () => {
		const mapped = observationRowToShadowState({
			identity: {
				logicalSlotId: "slot-usb-1-2",
				equipmentId: {
					provenance: "imei",
					value: "356938035643809",
					confidence: "high",
				},
				subscriptionId: "8934071100003141592", // ICCID — SENSITIVE, must be dropped
			},
			presence: "present",
			registration: { status: "registered" },
			simSlots: [{ index: 1, occupied: true, active: true, lock: "none" }],
		});

		expect(mapped.id).toBe("slot-usb-1-2");
		expect(mapped.present).toBe(true);
		expect(mapped.simPresent).toBe(true);
		const serialized = JSON.stringify(mapped);
		expect(serialized).not.toContain("8934071100003141592");
	});
});

describe("modem shadow — QA failure scenario (injected fake divergence, redacted-only)", () => {
	test("an injected mmcli-vs-dbus divergence is logged, and the log line leaks no secret", () => {
		// Fake harness: mmcli reports one thing, the shadow observer another — including
		// a secret-shaped value in the diverging field. The divergence MUST be logged,
		// but the logged content MUST be redacted-only.
		const mmcliStates = [
			mmcliModemToShadowState({
				id: "wwan0",
				present: true,
				registration: "registered",
				operatorName: "Carrier",
				iccid: "8934071100003141592",
				pin: "4321",
			}),
		];
		const dbusStates: ShadowModemState[] = [
			{
				id: "wwan0",
				present: true,
				registration: "searching",
				operatorName: "v4.public.another-leaked-token",
			},
		];

		const divs = classifyShadowDivergences(mmcliStates, dbusStates);
		expect(divs.length).toBeGreaterThan(0);

		const { lines, log } = capture();
		logShadowDivergences(divs, { log });

		expect(lines).toHaveLength(1);
		const serialized = JSON.stringify(lines[0]?.meta);
		// The divergence WAS logged...
		expect(serialized).toContain("wwan0");
		expect(serialized).toContain("registration");
		// ...but no secret survived — neither the ICCID/PIN (dropped by the mapper) nor
		// the token-shaped value (scrubbed by logRedact).
		expect(serialized).not.toContain("8934071100003141592");
		expect(serialized).not.toContain("4321");
		expect(serialized).not.toContain("another-leaked-token");
		expect(serialized).toContain("[REDACTED]");
	});
});
