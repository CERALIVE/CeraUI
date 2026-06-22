/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Signed-path fixtures — device-side verification of PLATFORM-signed tokens (Task 21).
 *
 * The committed fixtures under `modules/pairing/__fixtures__/` are the wire
 * contract between the platform (which SIGNS with `paseto-ts` v4.public) and this
 * device (which VERIFIES with the independent `node:crypto` verifier in
 * `paseto-v4.ts`). They were produced once with a THROWAWAY Ed25519 keypair — only
 * the public key + 3 signed tokens are committed; the private key never touches
 * the repo (see `__fixtures__/README.md`).
 *
 * This is the device half of the end-to-end signed path; the platform half lives
 * in `ceralive-platform/apps/api/gateway/signed-path.test.ts`. Proving the same
 * tokens verify on BOTH independent crypto implementations is the cross-repo
 * interop guarantee — the fixtures, not a shared module, are the contract (Rule D).
 *
 * The clock is FROZEN: `verifyDeviceControlToken(token, now)` takes `now` as an
 * injected epoch-ms instant, so the ±30s window is deterministic and never
 * time-flaky — `Date.now()` is never on the tested path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEVICE_CONTROL_PURPOSE,
	DEVICE_TOKEN_PUBLIC_KEY_ENV,
	DEVICE_TOKEN_SKEW_SECONDS,
	verifyDeviceControlToken,
} from "../modules/pairing/device-token.ts";

const FIXTURE_DIR = join(import.meta.dir, "../modules/pairing/__fixtures__");

function fixture(name: string): string {
	return readFileSync(join(FIXTURE_DIR, name), "utf8").trim();
}

// PASERK `k4.public.<base64url>` → the raw-base64url 32-byte key the device's
// `PASETO_PUBLIC_KEY` env expects (importEd25519PublicKey decodes base64url). This
// strip IS the documented cross-encoding step: the platform holds the PASERK
// string, the device holds the raw key — one public key, two encodings.
const PASERK_PUBLIC_PREFIX = "k4.public.";
const PUBLIC_KEY_PASERK = fixture("test-public-key.txt");
const PUBLIC_KEY_RAW = PUBLIC_KEY_PASERK.slice(PASERK_PUBLIC_PREFIX.length);

const VALID_TOKEN = fixture("valid-device-control-token.txt");
const WRONG_PURPOSE_TOKEN = fixture("wrong-purpose-relay-config-token.txt");
const EXPIRED_TOKEN = fixture("expired-device-control-token.txt");

// FROZEN clock baked into the fixtures: the valid token's iat, in epoch ms. The
// valid token spans [NOW, NOW + 15min]; the expired token expired 15min before it.
const FROZEN_NOW_MS = 1_750_000_000_000;

// A provisioned key makes verification mandatory; mutate-and-restore so the gate
// never leaks into the other pairing suites running in the same process.
let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = PUBLIC_KEY_RAW;
});

afterEach(() => {
	if (savedKey === undefined) {
		delete process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV];
	} else {
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = savedKey;
	}
});

describe("signed-path fixtures — device verifies platform-signed tokens (Task 21)", () => {
	test("the public-key fixture is a PASERK k4.public string carrying a 32-byte key", () => {
		expect(PUBLIC_KEY_PASERK.startsWith(PASERK_PUBLIC_PREFIX)).toBe(true);
		// base64url of 32 raw bytes, no padding → 43 chars.
		expect(PUBLIC_KEY_RAW.length).toBe(43);
	});

	test("the valid device-control fixture is accepted under the frozen clock", () => {
		const claims = verifyDeviceControlToken(VALID_TOKEN, FROZEN_NOW_MS);

		expect(claims).not.toBeNull();
		expect(claims?.purpose).toBe(DEVICE_CONTROL_PURPOSE);
		expect(claims?.device_id).toBe("7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e");
		expect(claims?.tenant_id).toBe("ten_8b14e579");
		expect(claims?.serial).toBe("CERA-RK3588-000123");
		expect(claims?.role).toBe("owner");
	});

	test("the wrong-purpose (relay-config) fixture is rejected by the purpose gate", () => {
		// Correct signature, wrong audience — must be rejected BEFORE any claim is
		// trusted (device-token.ts purpose gate, lines 399-406). A relay-config
		// token never crosses into the control channel even when validly signed.
		expect(
			verifyDeviceControlToken(WRONG_PURPOSE_TOKEN, FROZEN_NOW_MS),
		).toBeNull();
	});

	test("the expired fixture is rejected beyond the ±30s skew band", () => {
		// Verified at the frozen clock, which is 15min past the token's exp — well
		// outside the ±30s band.
		expect(verifyDeviceControlToken(EXPIRED_TOKEN, FROZEN_NOW_MS)).toBeNull();
	});

	test("a forged public key rejects the otherwise-valid fixture (real signature check)", () => {
		// Flip a byte of the provisioned key → the Ed25519 signature no longer
		// verifies, proving acceptance is a genuine signature check, not a decode.
		const tampered = `${PUBLIC_KEY_RAW.slice(0, -4)}AAAA`;
		process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV] = tampered;

		expect(verifyDeviceControlToken(VALID_TOKEN, FROZEN_NOW_MS)).toBeNull();
	});

	test("the frozen clock makes the ±30s window deterministic (edge of the band)", () => {
		// The valid token's exp = FROZEN_NOW + 15min. exp + 30s skew is still inside
		// the band; exp + 31s is outside. Both evaluated against an injected clock —
		// no Date.now() on the tested path.
		const exp = FROZEN_NOW_MS / 1000 + 15 * 60;
		const atEdgeMs = (exp + DEVICE_TOKEN_SKEW_SECONDS) * 1000;
		const pastEdgeMs = (exp + DEVICE_TOKEN_SKEW_SECONDS + 1) * 1000;

		expect(verifyDeviceControlToken(VALID_TOKEN, atEdgeMs)).not.toBeNull();
		expect(verifyDeviceControlToken(VALID_TOKEN, pastEdgeMs)).toBeNull();
	});
});
