import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	completePlatformPairing,
	getPlatformUrl,
	platformClaimErrorForStatus,
} from "../modules/pairing/platform-claim.ts";

const SERIAL = "CERATESTSERIAL22";
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

/** Build a fetch stub that records the request and returns a canned Response. */
function stubFetch(response: Response): {
	fetchImpl: typeof fetch;
	calls: { url: string; body: unknown }[];
} {
	const calls: { url: string; body: unknown }[] = [];
	const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = input instanceof URL ? input.toString() : String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body });
		return response;
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("platform claim — error-status mapping", () => {
	test("maps documented platform statuses to stable machine codes", () => {
		expect(platformClaimErrorForStatus(400)).toBe("invalid-claim-code");
		expect(platformClaimErrorForStatus(402)).toBe("subscription-required");
		expect(platformClaimErrorForStatus(409)).toBe("claim-code-consumed");
		expect(platformClaimErrorForStatus(410)).toBe("claim-code-expired");
		expect(platformClaimErrorForStatus(500)).toBe("platform-error-500");
	});
});

describe("getPlatformUrl — env sourcing", () => {
	test("reads PLATFORM_URL and treats blank/whitespace as unset", () => {
		expect(getPlatformUrl()).toBe(PLATFORM_URL);
		process.env.PLATFORM_URL = "   ";
		expect(getPlatformUrl()).toBeUndefined();
		delete process.env.PLATFORM_URL;
		expect(getPlatformUrl()).toBeUndefined();
	});
});

describe("completePlatformPairing — real POST /api/claim", () => {
	test("posts claimCode+serial to <PLATFORM_URL>/api/claim and applies the token", async () => {
		const { fetchImpl, calls } = stubFetch(
			new Response(JSON.stringify(CLAIM_RESPONSE), { status: 200 }),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(true);
		expect(result.device_id).toBe(CLAIM_RESPONSE.deviceId);
		expect(applied).toBe(CLAIM_RESPONSE.deviceToken);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`${PLATFORM_URL}/api/claim`);
		expect(calls[0]?.body).toEqual({ claimCode: "ABCDEFGH", serial: SERIAL });
	});

	test("surfaces 402 subscription-required and applies no token", async () => {
		const { fetchImpl } = stubFetch(
			new Response(JSON.stringify({ error: "subscription_required" }), {
				status: 402,
			}),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("subscription-required");
		expect(applied).toBeUndefined();
	});

	test("surfaces 409 consumed / 410 expired / 400 invalid without a token", async () => {
		for (const [status, error] of [
			[409, "claim-code-consumed"],
			[410, "claim-code-expired"],
			[400, "invalid-claim-code"],
		] as const) {
			const { fetchImpl } = stubFetch(new Response("{}", { status }));
			let applied: string | undefined;
			const result = await completePlatformPairing("ABCDEFGH", {
				applyToken: (token) => {
					applied = token;
				},
				serial: SERIAL,
				fetchImpl,
			});
			expect(result.paired).toBe(false);
			expect(result.error).toBe(error);
			expect(applied).toBeUndefined();
		}
	});

	test("maps a network/timeout failure to network-error", async () => {
		const fetchImpl = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("network-error");
		expect(applied).toBeUndefined();
	});

	test("rejects a malformed success body as invalid-platform-response", async () => {
		const { fetchImpl } = stubFetch(
			new Response(JSON.stringify({ deviceToken: 123 }), { status: 200 }),
		);
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("invalid-platform-response");
		expect(applied).toBeUndefined();
	});

	test("errors when PLATFORM_URL is not configured", async () => {
		delete process.env.PLATFORM_URL;
		let applied: string | undefined;

		const result = await completePlatformPairing("ABCDEFGH", {
			applyToken: (token) => {
				applied = token;
			},
			serial: SERIAL,
			fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
		});

		expect(result.paired).toBe(false);
		expect(result.error).toBe("platform-not-configured");
		expect(applied).toBeUndefined();
	});
});
