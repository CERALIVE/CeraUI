import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { availableNetworkSchema, modemListSchema } from "@ceraui/rpc/schemas";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { modemNetworkScan } from "../modules/modems/modem-network-scan.ts";
import { buildModemsMessage } from "../modules/modems/modem-status.ts";
import {
	getModem,
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

function makeModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "usb0",
		name: "RM520N-GL - 12345",
		sim_network: "T-Mobile",
		network_type: {
			supported: { "4g": { allowed: "4g", preferred: "none" } },
			active: "4g",
		},
		status: {
			connection: "connected",
			network: "T-Mobile",
			network_type: "4G",
			signal: 50,
			roaming: false,
		},
		...overrides,
	};
}

describe("available_networks wire-schema contract", () => {
	afterEach(cleanupModems);

	test("a saved-but-unscanned operator yields a schema-valid name-only entry", () => {
		setModem(
			0,
			makeModem({
				config: {
					autoconfig: false,
					apn: "internet",
					username: "user",
					password: "secret",
					roaming: true,
					network: "310260",
				},
			}),
		);

		const msg = buildModemsMessage();
		// This is the regression: with a required-availability schema the parse
		// threw (invalid_value) on the synthesized name-only entry.
		expect(modemListSchema.safeParse(msg).success).toBe(true);

		const entry = (
			msg["0"] as {
				available_networks?: Record<
					string,
					{ name: string; availability?: string }
				>;
			}
		).available_networks;
		expect(typeof entry?.["310260"]?.name).toBe("string");
		expect(entry?.["310260"]?.availability).toBeUndefined();
	});

	test("availableNetworkSchema accepts a name-only entry, rejects an unnormalised value", () => {
		expect(availableNetworkSchema.safeParse({ name: "T-Mobile" }).success).toBe(
			true,
		);
		expect(
			availableNetworkSchema.safeParse({
				name: "T-Mobile",
				availability: "available",
			}).success,
		).toBe(true);
		expect(
			availableNetworkSchema.safeParse({
				name: "T-Mobile",
				availability: "unavailable",
			}).success,
		).toBe(true);
		expect(
			availableNetworkSchema.safeParse({
				name: "T-Mobile",
				availability: "current",
			}).success,
		).toBe(false);
	});
});

describe("modemNetworkScan availability normalisation", () => {
	let priorMockMode: string | undefined;

	beforeAll(() => {
		priorMockMode = process.env.MOCK_MODE;
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});

	afterAll(() => {
		stopMockService();
		cleanupModems();
		if (priorMockMode === undefined) {
			delete process.env.MOCK_MODE;
		} else {
			process.env.MOCK_MODE = priorMockMode;
		}
	});

	afterEach(cleanupModems);

	test("normalises current→available and forbidden→unavailable onto the wire contract", async () => {
		setModem(
			0,
			makeModem({
				config: {
					autoconfig: false,
					apn: "",
					username: "",
					password: "",
					roaming: false,
					network: "",
				},
			}),
		);

		await modemNetworkScan(0);
		const an = getModem(0)?.available_networks ?? {};

		expect(an["310260"]?.availability).toBe("available");
		expect(an["310120"]?.availability).toBe("unavailable");
		for (const net of Object.values(an)) {
			expect(
				net.availability === undefined ||
					net.availability === "available" ||
					net.availability === "unavailable",
			).toBe(true);
		}

		expect(modemListSchema.safeParse(buildModemsMessage()).success).toBe(true);
	});
});
