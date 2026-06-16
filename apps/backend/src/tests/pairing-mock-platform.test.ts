import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { deviceTokenClaimsSchema } from "@ceraui/rpc/schemas";

import { getConfig } from "../modules/config.ts";
import {
	CLAIM_CODE_WINDOW_SECONDS,
	deriveClaimCode,
} from "../modules/pairing/claim-code.ts";
import {
	DEVICE_TOKEN_HEADER,
	DEVICE_TOKEN_PUBLIC_KEY_ENV,
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
import {
	exportEd25519PublicKeyBase64,
	signV4Public,
} from "../modules/pairing/paseto-v4.ts";
import {
	buildAuthEncoderPayload,
	resolveRemoteKey,
	setRemoteKey,
} from "../modules/remote/remote.ts";

// Deterministic seed material so claim-code derivation and the issued token are
// fully reproducible. The live device serial/secret are pinned via env + config
// so generateClaimCode and mockPlatformClaim agree without touching hardware.
const SERIAL = "CERATESTSERIAL25";
const SECRET = "dGVzdC1zZWNyZXQtZm9yLW1vY2stcGxhdGZvcm0tdGFzazI1";

const WINDOW_MS = CLAIM_CODE_WINDOW_SECONDS * 1000;
const NOW = 1_700_000_000_000 - (1_700_000_000_000 % WINDOW_MS) + 1_000;

const validCode = deriveClaimCode({
	now: NOW,
	serial: SERIAL,
	secret: SECRET,
}).code;

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
		expect(
			verifyStubDeviceToken(`${DEVICE_TOKEN_HEADER}!!!notbase64!!!`, NOW),
		).toBeNull();
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
		expect(resolveRemoteKey({ token: "device-token-abc" })).toBe(
			"device-token-abc",
		);
		expect(
			resolveRemoteKey({ remote_key: "legacy", token: "device-token-abc" }),
		).toBe("device-token-abc");
	});

	test("deprecated raw remote_key path still resolves", () => {
		expect(resolveRemoteKey({ remote_key: "legacy-key" })).toBe("legacy-key");
		// The deprecated helper is retained for unpaired devices.
		expect(typeof setRemoteKey).toBe("function");
	});
});

describe("auth/encoder frame — device-token standing + opaque fallback", () => {
	test("presents a device token and reads its sub_status standing", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: MOCK_PLATFORM_SUB_STATUS,
			now: NOW,
			ttlSeconds: 100,
		});
		const payload = buildAuthEncoderPayload(token, 16, NOW);
		expect(payload.key).toBe(token);
		expect(payload.version).toBe(16);
		expect(payload.sub_status).toBe(MOCK_PLATFORM_SUB_STATUS);
	});

	test("omits sub_status for a legacy opaque key (backward compat)", () => {
		const payload = buildAuthEncoderPayload("legacy-operator-key", 16, NOW);
		expect(payload.key).toBe("legacy-operator-key");
		expect(payload.version).toBe(16);
		expect(payload.sub_status).toBeUndefined();
	});

	test("omits sub_status for an expired token but still presents the key", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
			ttlSeconds: 100,
		});
		const past = NOW + (100 + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		const payload = buildAuthEncoderPayload(token, 16, past);
		expect(payload.key).toBe(token);
		expect(payload.sub_status).toBeUndefined();
	});
});

// A provisioned PASETO_PUBLIC_KEY makes signature verification mandatory; the env
// var is mutated per-test, so snapshot and restore it to keep the gate from
// leaking into the key-absent auth/encoder suite above (a stray key would refuse
// every opaque token).
describe("auth/encoder frame — real PASETO verification when key provisioned", () => {
	const NOW_SECONDS = Math.floor(NOW / 1000);

	let savedKey: string | undefined;
	let platform: { publicKey: KeyObject; privateKey: KeyObject };

	function signRelayToken(
		claims: Record<string, unknown>,
		secret: KeyObject = platform.privateKey,
	): string {
		return signV4Public(JSON.stringify(claims), secret);
	}

	function relayClaims(overrides: Record<string, unknown> = {}) {
		return {
			device_id: SERIAL,
			sub_status: MOCK_PLATFORM_SUB_STATUS,
			iat: NOW_SECONDS,
			exp: NOW_SECONDS + 3600,
			...overrides,
		};
	}

	beforeEach(() => {
		savedKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
		platform = generateKeyPairSync("ed25519");
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = exportEd25519PublicKeyBase64(
			platform.publicKey,
		);
	});

	afterEach(() => {
		if (savedKey === undefined) {
			delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
		} else {
			process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = savedKey;
		}
	});

	test("a validly signed token authorizes — sub_status is read and presented", () => {
		const token = signRelayToken(relayClaims());
		const payload = buildAuthEncoderPayload(token, 16, NOW);
		expect(payload.key).toBe(token);
		expect(payload.version).toBe(16);
		expect(payload.sub_status).toBe(MOCK_PLATFORM_SUB_STATUS);
	});

	test("a token signed by a DIFFERENT key is rejected — sub_status omitted, key still presented", () => {
		const attacker = generateKeyPairSync("ed25519");
		const forged = signRelayToken(relayClaims(), attacker.privateKey);
		const payload = buildAuthEncoderPayload(forged, 16, NOW);
		expect(payload.key).toBe(forged);
		expect(payload.sub_status).toBeUndefined();
	});

	test("an unsigned (opaque) token is rejected when the key is provisioned", () => {
		const unsigned = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});
		const payload = buildAuthEncoderPayload(unsigned, 16, NOW);
		expect(payload.key).toBe(unsigned);
		expect(payload.sub_status).toBeUndefined();
	});

	test("a validly signed but expired token is rejected beyond the ±30s skew band", () => {
		const expiredAt = NOW_SECONDS - 60;
		const token = signRelayToken(
			relayClaims({ iat: expiredAt - 3600, exp: expiredAt }),
		);
		const past = (expiredAt + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		const payload = buildAuthEncoderPayload(token, 16, past);
		expect(payload.key).toBe(token);
		expect(payload.sub_status).toBeUndefined();
	});

	test("the gate is key-conditional: the same unsigned token is refused with a key, accepted on the opaque fallback without one", () => {
		const unsigned = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});

		const withKey = buildAuthEncoderPayload(unsigned, 16, NOW);
		expect(withKey.sub_status).toBeUndefined();

		delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
		const withoutKey = buildAuthEncoderPayload(unsigned, 16, NOW);
		expect(withoutKey.sub_status).toBe("ACTIVE");
	});
});
