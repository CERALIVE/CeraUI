import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	completePlatformPairing,
	PAIRING_SECRET_REGISTER_MAX_ATTEMPTS,
	registerPairingSecret,
} from "../modules/pairing/platform-claim.ts";

const SERIAL = "CERATESTSERIAL22";
const SECRET = "dGVzdC1wYWlyaW5nLXNlY3JldC1iYXNlNjQ=";
const PLATFORM_URL = "https://platform.test.example";

const CLAIM_RESPONSE = {
	deviceToken: "ct_abc123opaque",
	tokenType: "opaque",
	deviceId: "device-id-xyz",
	tenantId: "tenant-id-abc",
	serial: SERIAL,
	claimedAt: "2026-06-08T10:00:00.000Z",
};

let savedPlatformUrl: string | undefined;

beforeEach(() => {
	savedPlatformUrl = process.env.PLATFORM_URL;
	process.env.PLATFORM_URL = PLATFORM_URL;
});

afterEach(() => {
	if (savedPlatformUrl === undefined) delete process.env.PLATFORM_URL;
	else process.env.PLATFORM_URL = savedPlatformUrl;
});

function recordingFetch(responder: () => Response | Promise<Response>): {
	fetchImpl: typeof fetch;
	calls: { url: string; body: unknown }[];
} {
	const calls: { url: string; body: unknown }[] = [];
	const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = input instanceof URL ? input.toString() : String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body });
		return responder();
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

const noDelay = async () => {};

describe("registerPairingSecret — isRealDevice gate", () => {
	test("fires once on a real device and posts {serial, pairingSecret}", async () => {
		const { fetchImpl, calls } = recordingFetch(
			() => new Response("{}", { status: 200 }),
		);

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => true,
			delayImpl: noDelay,
		});

		expect(result).toEqual({ registered: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${PLATFORM_URL}/api/device/pairing-secret`);
		expect(calls[0]?.body).toEqual({ serial: SERIAL, pairingSecret: SECRET });
	});

	test("is a no-op in mock/emulated mode (isRealDevice false) — no request", async () => {
		const { fetchImpl, calls } = recordingFetch(
			() => new Response("{}", { status: 200 }),
		);

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => false,
			delayImpl: noDelay,
		});

		expect(result).toEqual({ registered: false, skipped: true });
		expect(calls).toHaveLength(0);
	});
});

describe("registerPairingSecret — resilience", () => {
	test("retries an HTTP error up to the cap then gives up without throwing", async () => {
		const { fetchImpl, calls } = recordingFetch(
			() => new Response("{}", { status: 503 }),
		);

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => true,
			delayImpl: noDelay,
		});

		expect(result.registered).toBe(false);
		expect(result.error).toBe("platform-error-503");
		expect(calls).toHaveLength(PAIRING_SECRET_REGISTER_MAX_ATTEMPTS);
	});

	test("retries a network failure then resolves network-error (never throws)", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			throw new Error("connection refused");
		}) as unknown as typeof fetch;

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => true,
			delayImpl: noDelay,
		});

		expect(result.registered).toBe(false);
		expect(result.error).toBe("network-error");
		expect(attempts).toBe(PAIRING_SECRET_REGISTER_MAX_ATTEMPTS);
	});

	test("recovers when a retry succeeds after a transient failure", async () => {
		let attempts = 0;
		const fetchImpl = (async () => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => true,
			delayImpl: noDelay,
		});

		expect(result).toEqual({ registered: true });
		expect(attempts).toBe(2);
	});

	test("surfaces platform-not-configured on a real device with no PLATFORM_URL", async () => {
		delete process.env.PLATFORM_URL;
		const { fetchImpl, calls } = recordingFetch(
			() => new Response("{}", { status: 200 }),
		);

		const result = await registerPairingSecret({
			serial: SERIAL,
			secret: SECRET,
			fetchImpl,
			isRealDeviceImpl: async () => true,
			delayImpl: noDelay,
		});

		expect(result).toEqual({
			registered: false,
			error: "platform-not-configured",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("completePlatformPairing — registration integration", () => {
	test("registers the secret before claiming, and pairing succeeds", async () => {
		const seen: string[] = [];
		const { fetchImpl } = recordingFetch(
			() => new Response(JSON.stringify(CLAIM_RESPONSE), { status: 200 }),
		);

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: () => {},
			serial: SERIAL,
			fetchImpl,
			registerSecret: async () => {
				seen.push("register");
				return { registered: true };
			},
		});

		expect(seen).toEqual(["register"]);
		expect(result.paired).toBe(true);
		expect(result.device_id).toBe(CLAIM_RESPONSE.deviceId);
	});

	test("a failed registration never blocks pairing", async () => {
		const { fetchImpl } = recordingFetch(
			() => new Response(JSON.stringify(CLAIM_RESPONSE), { status: 200 }),
		);

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: () => {},
			serial: SERIAL,
			fetchImpl,
			registerSecret: async () => ({
				registered: false,
				error: "network-error",
			}),
		});

		expect(result.paired).toBe(true);
		expect(result.device_id).toBe(CLAIM_RESPONSE.deviceId);
	});
});
