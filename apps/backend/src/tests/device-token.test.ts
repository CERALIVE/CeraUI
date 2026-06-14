import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
	DEVICE_CONTROL_PURPOSE,
	DEVICE_TOKEN_PUBLIC_KEY_ENV,
	DEVICE_TOKEN_SKEW_SECONDS,
	mintStubDeviceControlToken,
	mintStubDeviceToken,
	verifyDeviceControlToken,
	verifyStubDeviceToken,
} from "../modules/pairing/device-token.ts";
import {
	exportEd25519PublicKeyBase64,
	importEd25519PublicKey,
	signV4Public,
	verifyV4Public,
} from "../modules/pairing/paseto-v4.ts";
import {
	CONTROL_HUB_URL_ENV,
	resolveControlChannelEndpoint,
} from "../modules/remote/control-endpoint.ts";

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);

// A provisioned key makes verification mandatory; mutate-and-restore so the gate
// never leaks into the other pairing suites running in the same process.
let savedKey: string | undefined;

// The platform's signing keypair for the suite. The public half is what the
// device is provisioned with; the private half stands in for PASETO_SIGNING_KEY.
let platform: { publicKey: KeyObject; privateKey: KeyObject };
let platformPublicKeyB64: string;

beforeEach(() => {
	savedKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	platform = generateKeyPairSync("ed25519");
	platformPublicKeyB64 = exportEd25519PublicKeyBase64(platform.publicKey);
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	} else {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = savedKey;
	}
});

function controlClaims(overrides: Record<string, unknown> = {}) {
	return {
		device_id: "7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e",
		tenant_id: "ten_8b14e579",
		serial: "CERA-RK3588-000123",
		role: "owner",
		aud: "ceralive-control-plane",
		purpose: DEVICE_CONTROL_PURPOSE,
		jti: "8b14e579-4d0f-4c8b-9594-2a3b4c5d6e7f",
		iat: NOW_SECONDS,
		exp: NOW_SECONDS + 15 * 60,
		...overrides,
	};
}

function signControlToken(
	claims: Record<string, unknown>,
	secret: KeyObject = platform.privateKey,
): string {
	return signV4Public(JSON.stringify(claims), secret);
}

describe("device-control token — real PASETO v4.public verification (spec §10)", () => {
	test("a validly signed token is accepted and its claims returned", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const token = signControlToken(controlClaims());

		const claims = verifyDeviceControlToken(token, NOW);

		expect(claims).not.toBeNull();
		expect(claims?.device_id).toBe("7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e");
		expect(claims?.tenant_id).toBe("ten_8b14e579");
		expect(claims?.purpose).toBe(DEVICE_CONTROL_PURPOSE);
		expect(claims?.role).toBe("owner");
	});

	test("an unsigned (forged) token is rejected when the public key is set", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		// Unsigned stub token: real claim shape, real header, NO signature.
		const unsigned = mintStubDeviceControlToken({
			deviceId: "7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e",
			tenantId: "ten_8b14e579",
			serial: "CERA-RK3588-000123",
			jti: "8b14e579-4d0f-4c8b-9594-2a3b4c5d6e7f",
			now: NOW,
		});

		expect(verifyDeviceControlToken(unsigned, NOW)).toBeNull();
	});

	test("a token signed by a DIFFERENT key is rejected (signature mismatch)", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const attacker = generateKeyPairSync("ed25519");
		const forged = signControlToken(controlClaims(), attacker.privateKey);

		expect(verifyDeviceControlToken(forged, NOW)).toBeNull();
	});

	test("a validly signed relay-config (wrong-purpose) token is rejected", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		// Correct signature, wrong audience: purpose gate must reject it before
		// trusting any claim, proving audience separation is not just a side
		// effect of signature failure.
		const wrongPurpose = signControlToken(
			controlClaims({ purpose: "relay-config" }),
		);

		expect(verifyDeviceControlToken(wrongPurpose, NOW)).toBeNull();
	});

	test("an expired token is rejected beyond the ±30s skew band", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const expiredAt = NOW_SECONDS - 60;
		const token = signControlToken(
			controlClaims({ iat: expiredAt - 900, exp: expiredAt }),
		);

		const past = (expiredAt + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		expect(verifyDeviceControlToken(token, past)).toBeNull();
	});

	test("a token within the ±30s skew band is still accepted", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const expiredAt = NOW_SECONDS;
		const token = signControlToken(
			controlClaims({ iat: expiredAt - 900, exp: expiredAt }),
		);

		const justAfter = (expiredAt + DEVICE_TOKEN_SKEW_SECONDS - 5) * 1000;
		expect(verifyDeviceControlToken(token, justAfter)).not.toBeNull();
	});

	test("a token missing required claims is rejected even when signed", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const { tenant_id: _omitted, ...withoutTenant } = controlClaims();
		const token = signControlToken(withoutTenant);

		expect(verifyDeviceControlToken(token, NOW)).toBeNull();
	});
});

describe("device-control token — unsigned dev path (no key provisioned)", () => {
	test("an unsigned token is accepted when no public key is set", () => {
		const token = mintStubDeviceControlToken({
			deviceId: "dev-device",
			tenantId: "dev-tenant",
			serial: "DEVSERIAL01",
			jti: "dev-jti-0001",
			now: NOW,
		});

		const claims = verifyDeviceControlToken(token, NOW);
		expect(claims?.purpose).toBe(DEVICE_CONTROL_PURPOSE);
	});

	test("the purpose gate still rejects a wrong-purpose token on the dev path", () => {
		const body = Buffer.from(
			JSON.stringify(controlClaims({ purpose: "relay-config" })),
			"utf8",
		)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const token = `v4.public.${body}`;

		expect(verifyDeviceControlToken(token, NOW)).toBeNull();
	});
});

describe("relay-config token — real verification when key provisioned", () => {
	test("a validly signed relay-config token is accepted", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const token = signV4Public(
			JSON.stringify({
				device_id: "CERASERIAL0001",
				sub_status: "ACTIVE",
				iat: NOW_SECONDS,
				exp: NOW_SECONDS + 3600,
			}),
			platform.privateKey,
		);

		const claims = verifyStubDeviceToken(token, NOW);
		expect(claims?.device_id).toBe("CERASERIAL0001");
		expect(claims?.sub_status).toBe("ACTIVE");
	});

	test("an unsigned relay-config token is rejected when the key is set", () => {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = platformPublicKeyB64;
		const unsigned = mintStubDeviceToken({
			deviceId: "CERASERIAL0001",
			subStatus: "ACTIVE",
			now: NOW,
		});

		expect(verifyStubDeviceToken(unsigned, NOW)).toBeNull();
	});
});

describe("control channel endpoint pinning (spec §10)", () => {
	test("custom_provider cannot redirect the control channel to another host", () => {
		const endpoint = resolveControlChannelEndpoint(
			{
				remote_provider: "custom",
				custom_provider: {
					name: "attacker",
					host: "evil.example.com",
					path: "/ws/remote",
					secure: true,
				},
			},
			{ [CONTROL_HUB_URL_ENV]: "wss://hub.ceralive.tv/ws/control" },
		);

		expect(endpoint.host).toBe("hub.ceralive.tv");
		expect(endpoint.url).toBe("wss://hub.ceralive.tv/ws/control");
		expect(endpoint.host).not.toBe("evil.example.com");
		expect(endpoint.pinned).toBe(true);
	});

	test("a missing pin fails closed (throws, never falls back to operator host)", () => {
		expect(() =>
			resolveControlChannelEndpoint(
				{ custom_provider: { name: "x", host: "evil.example.com" } },
				{},
			),
		).toThrow();
	});

	test("a non-ws(s) pinned URL is rejected", () => {
		expect(() =>
			resolveControlChannelEndpoint(undefined, {
				[CONTROL_HUB_URL_ENV]: "https://hub.ceralive.tv/ws/control",
			}),
		).toThrow();
	});
});

describe("PASETO v4.public — official spec test vectors (interop lock)", () => {
	// Genuine vectors from github.com/paseto-standard/test-vectors (v4.json).
	// They lock the PAE + base64url + Ed25519 construction against the spec so a
	// real platform-signed token verifies on-device.
	const PUBLIC_KEY_HEX =
		"1eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2";
	const PAYLOAD =
		'{"data":"this is a signed message","exp":"2022-01-01T00:00:00+00:00"}';

	const publicKeyB64 = Buffer.from(PUBLIC_KEY_HEX, "hex").toString("base64");

	test("4-S-1 (no footer) verifies", () => {
		const key = importEd25519PublicKey(publicKeyB64);
		const token =
			"v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA";
		const result = verifyV4Public(token, key);
		expect(result?.payload).toBe(PAYLOAD);
		expect(result?.footer).toBe("");
	});

	test("4-S-2 (with footer) verifies", () => {
		const key = importEd25519PublicKey(publicKeyB64);
		const token =
			"v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9v3Jt8mx_TdM2ceTGoqwrh4yDFn0XsHvvV_D0DtwQxVrJEBMl0F2caAdgnpKlt4p7xBnx1HcO-SPo8FPp214HDw.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9";
		const result = verifyV4Public(token, key);
		expect(result?.payload).toBe(PAYLOAD);
		expect(result?.footer).toBe(
			'{"kid":"zVhMiPBP9fRf2snEcT7gFTioeA9COcNy9DfgL1W60haN"}',
		);
	});

	test("4-S-3 (footer + implicit assertion) verifies", () => {
		const key = importEd25519PublicKey(publicKeyB64);
		const token =
			"v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9NPWciuD3d0o5eXJXG5pJy-DiVEoyPYWs1YSTwWHNJq6DZD3je5gf-0M4JR9ipdUSJbIovzmBECeaWmaqcaP0DQ.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9";
		const implicit = '{"test-vector":"4-S-3"}';
		expect(verifyV4Public(token, key, implicit)?.payload).toBe(PAYLOAD);
		// Wrong implicit assertion must fail — it is bound into the signature.
		expect(verifyV4Public(token, key, "")).toBeNull();
	});
});
