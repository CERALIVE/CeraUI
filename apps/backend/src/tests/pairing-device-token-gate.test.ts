import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	DEVICE_TOKEN_PUBLIC_KEY_ENV,
	DEVICE_TOKEN_SKEW_SECONDS,
	mintStubDeviceToken,
	verifyStubDeviceToken,
} from "../modules/pairing/device-token.ts";

// PASETO verification is gated on the provisioned public key (ADR-0006 D2). The
// env var is mutated per-test, so snapshot and restore it to keep the gate from
// leaking into the other pairing suites (a stray key would refuse every token).
const SERIAL = "CERATESTSERIAL25";
const NOW = 1_700_000_000_000;

let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	} else {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = savedKey;
	}
});

describe("device token — gated verification (ADR-0006, PASETO_PUBLIC_KEY)", () => {
	test("no key provisioned → MVP opaque path accepts a valid token", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});
		const claims = verifyStubDeviceToken(token, NOW);
		expect(claims).not.toBeNull();
		expect(claims?.device_id).toBe(SERIAL);
	});

	test("key provisioned → refuses an otherwise-valid token (never silently accepts)", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});
		// Sanity: this exact token is accepted on the no-key (MVP) path.
		expect(verifyStubDeviceToken(token, NOW)).not.toBeNull();

		// With a key provisioned the real Ed25519 verifier is gated/not-yet-
		// implemented, so the token MUST be refused rather than accepted unsigned.
		// The value is irrelevant — only its presence triggers the gate, and there
		// is no hardcoded key the stub could fall back to.
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = "ZmFrZS1lZDI1NTE5LXB1Yi1rZXk";
		expect(verifyStubDeviceToken(token, NOW)).toBeNull();
	});

	test("blank/whitespace key is treated as unset (no hardcoded fallback) → MVP path", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
		});
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = "   ";
		expect(verifyStubDeviceToken(token, NOW)).not.toBeNull();
	});

	test("no key provisioned → expired token is rejected (±30s skew enforced)", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
			ttlSeconds: 100,
		});
		const past = NOW + (100 + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		expect(verifyStubDeviceToken(token, past)).toBeNull();
	});

	test("key provisioned → an expired token is still refused (not silently accepted)", () => {
		const token = mintStubDeviceToken({
			deviceId: SERIAL,
			subStatus: "ACTIVE",
			now: NOW,
			ttlSeconds: 100,
		});
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = "ZmFrZS1lZDI1NTE5LXB1Yi1rZXk";
		const past = NOW + (100 + DEVICE_TOKEN_SKEW_SECONDS + 5) * 1000;
		expect(verifyStubDeviceToken(token, past)).toBeNull();
	});
});
