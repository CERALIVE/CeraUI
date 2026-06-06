import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { deviceTokenClaimsSchema } from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import {
	CLAIM_CODE_WINDOW_SECONDS,
	deriveClaimCode,
} from "../modules/pairing/claim-code.ts";
import {
	DEVICE_TOKEN_HEADER,
	DEVICE_TOKEN_SKEW_SECONDS,
	mintStubDeviceToken,
	stubDeviceTokenVerifier,
	verifyStubDeviceToken,
} from "../modules/pairing/device-token.ts";
import {
	completeMockPairing,
	MOCK_PLATFORM_SUB_STATUS,
	mockPlatformClaim,
} from "../modules/pairing/mock-platform.ts";
import { resolveRemoteKey, setRemoteKey } from "../modules/remote/remote.ts";

// Deterministic seed material so claim-code derivation and the issued token are
// fully reproducible. The live device serial/secret are pinned via env + config
// so generateClaimCode and mockPlatformClaim agree without touching hardware.
const SERIAL = "CERATESTSERIAL25";
const SECRET = "dGVzdC1zZWNyZXQtZm9yLW1vY2stcGxhdGZvcm0tdGFzazI1";

const WINDOW_MS = CLAIM_CODE_WINDOW_SECONDS * 1000;
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % WINDOW_MS) + 1_000;

const validCode = deriveClaimCode({ now: NOW, serial: SERIAL, secret: SECRET }).code;

beforeAll(() => {
	process.env.DEVICE_SERIAL = SERIAL;
	getConfig().pairing_secret = SECRET;
});

afterAll(() => {
	delete process.env.DEVICE_SERIAL;
});

describe("mock platform — claim validation + token issuance", () => {
	test("issues an ADR-0006-shaped device token for a valid claim code", async () => {
		const result = await mockPlatformClaim(validCode, {
			now: NOW,
			serial: SERIAL,
			secret: SECRET,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.token.startsWith(DEVICE_TOKEN_HEADER)).toBe(true);
		expect(() => deviceTokenClaimsSchema.parse(result.claims)).not.toThrow();
		expect(result.claims.device_id).toBe(SERIAL);
		expect(result.claims.sub_status).toBe(MOCK_PLATFORM_SUB_STATUS);
		expect(result.claims.exp).toBeGreaterThan(result.claims.iat);
	});

	test("rejects an invalid claim code without issuing a token", async () => {
		const result = await mockPlatformClaim("ZZZZZZZZ", {
			now: NOW,
			serial: SERIAL,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBe("invalid-claim-code");
	});

	test("rejects an expired claim code (beyond the skew band)", async () => {
		const result = await mockPlatformClaim(validCode, {
			now: NOW + WINDOW_MS * 2,
			serial: SERIAL,
			secret: SECRET,
		});
		expect(result.ok).toBe(false);
	});
});

describe("device token — stub verification contract (ADR-0006)", () => {
	test("verifier accepts a freshly issued token and reads its claims", async () => {
		const result = await mockPlatformClaim(validCode, {
			now: NOW,
			serial: SERIAL,
			secret: SECRET,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const claims = verifyStubDeviceToken(result.token, NOW);
		expect(claims).not.toBeNull();
		expect(claims?.device_id).toBe(SERIAL);
		// The exported verifier object delegates to the same implementation.
		expect(stubDeviceTokenVerifier.verify(result.token, NOW)).toEqual(claims);
	});

	test("rejects an expired token", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
			ttlSeconds: 100,
		});
		const past = NOW + (100 + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		expect(verifyStubDeviceToken(token, past)).toBeNull();
	});

	test("rejects a not-yet-valid (future iat) token", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW + 10_000 * 1000,
		});
		expect(verifyStubDeviceToken(token, NOW)).toBeNull();
	});

	test("rejects malformed tokens and wrong headers", () => {
		expect(verifyStubDeviceToken("not-a-token", NOW)).toBeNull();
		expect(verifyStubDeviceToken(`${DEVICE_TOKEN_HEADER}!!!notbase64!!!`, NOW)).toBeNull();
		expect(verifyStubDeviceToken("v2.local.whatever", NOW)).toBeNull();
	});

	test("tolerates clock skew inside the ±30s band", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
			ttlSeconds: 100,
		});
		// Just inside the future-iat skew band.
		expect(verifyStubDeviceToken(token, NOW - 20 * 1000)).not.toBeNull();
	});
});

describe("full device-side pairing sequence (mock)", () => {
	test("generate → validate → token → apply as remote key", async () => {
		let applied: string | undefined;
		const result = await completeMockPairing(undefined, {
			now: NOW,
			applyToken: (token) => {
				applied = token;
			},
		});

		expect(result.paired).toBe(true);
		expect(result.device_id).toBe(SERIAL);
		expect(result.sub_status).toBe(MOCK_PLATFORM_SUB_STATUS);
		expect(result.validUntil).toBeGreaterThan(NOW);

		expect(applied).toBeDefined();
		const claims = applied ? verifyStubDeviceToken(applied, NOW) : null;
		expect(claims?.device_id).toBe(SERIAL);
		// The applied token is exactly what the channel presents as its remote key.
		expect(resolveRemoteKey({ token: applied })).toBe(applied);
	});

	test("rejects a bad code and applies no token", async () => {
		let applied: string | undefined;
		const result = await completeMockPairing("ZZZZZZZZ", {
			now: NOW,
			applyToken: (token) => {
				applied = token;
			},
		});
		expect(result.paired).toBe(false);
		expect(result.error).toBeDefined();
		expect(applied).toBeUndefined();
	});
});

describe("remote_key channel — token acceptance + deprecated path", () => {
	test("a platform token becomes the active remote key (precedence over raw key)", () => {
		expect(resolveRemoteKey({ token: "device-token-abc" })).toBe("device-token-abc");
		expect(resolveRemoteKey({ remote_key: "legacy", token: "device-token-abc" })).toBe(
			"device-token-abc",
		);
	});

	test("deprecated raw remote_key path still resolves", () => {
		expect(resolveRemoteKey({ remote_key: "legacy-key" })).toBe("legacy-key");
		// The deprecated helper is retained for unpaired devices.
		expect(typeof setRemoteKey).toBe("function");
	});
});
