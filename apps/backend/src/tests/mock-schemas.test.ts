import { describe, expect, test } from "bun:test";

import {
	mockModems,
	mockWifiNetworks,
	mockWifiRadios,
} from "../mocks/mock-config.ts";
import {
	mockModemConfigSchema,
	mockWifiNetworkSchema,
	mockWifiRadioSchema,
	validateMockFixtures,
} from "../mocks/mock-schemas.ts";

describe("mock fixture schemas — Task 3", () => {
	test("every shipped modem fixture validates", () => {
		for (const modem of mockModems) {
			const result = mockModemConfigSchema.safeParse(modem);
			if (!result.success) {
				throw new Error(
					`modem ${modem.id} failed: ${JSON.stringify(result.error.issues)}`,
				);
			}
			expect(result.success).toBe(true);
		}
	});

	test("every shipped WiFi radio fixture validates", () => {
		for (const radio of mockWifiRadios) {
			const result = mockWifiRadioSchema.safeParse(radio);
			if (!result.success) {
				throw new Error(
					`radio ${radio.device} failed: ${JSON.stringify(result.error.issues)}`,
				);
			}
			expect(result.success).toBe(true);
		}
	});

	test("every shipped WiFi network fixture validates", () => {
		for (const network of mockWifiNetworks) {
			const result = mockWifiNetworkSchema.safeParse(network);
			if (!result.success) {
				throw new Error(
					`network ${network.ssid} failed: ${JSON.stringify(result.error.issues)}`,
				);
			}
			expect(result.success).toBe(true);
		}
	});

	test("validateMockFixtures() accepts all shipped fixtures", () => {
		expect(() => validateMockFixtures()).not.toThrow();
	});

	test("a modem fixture with a bad IMEI length is rejected with a descriptive error", () => {
		const firstModem = mockModems[0];
		if (!firstModem)
			throw new Error("expected at least one mock modem fixture");

		const malformed = { ...firstModem, imei: "12345" };
		const result = mockModemConfigSchema.safeParse(malformed);

		expect(result.success).toBe(false);
		if (result.success)
			throw new Error("expected malformed IMEI to be rejected");

		const imeiIssue = result.error.issues.find((issue) =>
			issue.path.includes("imei"),
		);
		expect(imeiIssue).toBeDefined();
		expect(imeiIssue?.message).toBe("IMEI must be exactly 15 digits");

		const drift = [
			"Task 3 — mock fixture drift detection",
			`Malformed fixture: mockModems[0] with imei='${malformed.imei}' (must be 15 digits)`,
			"",
			"Zod rejection:",
			...result.error.issues.map(
				(issue) =>
					`  • [${issue.path.join(".") || "<root>"}]: ${issue.message}`,
			),
		].join("\n");
		Bun.write("test-results/task-3-drift.txt", `${drift}\n`);
	});
});
