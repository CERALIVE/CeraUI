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
 * Mock platform claim endpoint (device-pairing-claim-code change, Task 25).
 *
 * Stands in for the real `ceralive-platform` claim endpoint (Tasks 7-13, not in
 * the device image) so the full device-side pairing sequence is exercisable
 * end-to-end without the platform. Given a claim-code it verifies the code
 * against this device's own secret+serial (the platform would verify the
 * device's submitted code), then issues a stub device token (ADR-0006). It does
 * NOT implement real validation/issuance — billing checks, DeviceConnection
 * binding, and Ed25519 signing all live on the real platform.
 */

import type {
	DeviceTokenClaims,
	SubscriptionStatus,
} from "@ceraui/rpc/schemas";

import {
	generateClaimCode,
	getDeviceSerial,
	getPairingSecret,
	verifyClaimCode,
} from "./claim-code.ts";
import {
	DEVICE_TOKEN_TTL_SECONDS,
	mintStubDeviceToken,
	verifyStubDeviceToken,
} from "./device-token.ts";

/** Subscription standing the mock platform grants on a successful claim. */
export const MOCK_PLATFORM_SUB_STATUS: SubscriptionStatus = "ACTIVE";

export type MockPlatformClaimResult =
	| { ok: true; token: string; claims: DeviceTokenClaims }
	| { ok: false; error: string };

export interface MockPlatformClaimOptions {
	/** Evaluation instant, epoch ms (defaults to now). */
	now?: number;
	/** Override the device serial (defaults to the live device serial). */
	serial?: string;
	/** Override the pairing secret (defaults to the live device secret). */
	secret?: string;
	/** Subscription standing to encode in the token. */
	subStatus?: SubscriptionStatus;
	/** Issued token lifetime in seconds. */
	ttlSeconds?: number;
}

/**
 * Validate a submitted claim-code and, if it verifies, issue a device token.
 * Returns a discriminated result so callers handle accept/reject explicitly.
 */
export async function mockPlatformClaim(
	code: string,
	options: MockPlatformClaimOptions = {},
): Promise<MockPlatformClaimResult> {
	const now = options.now ?? Date.now();
	const serial = options.serial ?? (await getDeviceSerial());
	const secret = options.secret ?? getPairingSecret();

	const valid = verifyClaimCode({ now, serial, secret, code });
	if (!valid) {
		return { ok: false, error: "invalid-claim-code" };
	}

	const token = mintStubDeviceToken({
		deviceId: serial,
		subStatus: options.subStatus ?? MOCK_PLATFORM_SUB_STATUS,
		now,
		ttlSeconds: options.ttlSeconds ?? DEVICE_TOKEN_TTL_SECONDS,
	});

	const claims = verifyStubDeviceToken(token, now);
	if (!claims) {
		return { ok: false, error: "token-issue-failed" };
	}

	return { ok: true, token, claims };
}

export interface CompleteMockPairingResult {
	paired: boolean;
	device_id?: string;
	sub_status?: SubscriptionStatus;
	validUntil?: number;
	error?: string;
}

export interface CompleteMockPairingDeps {
	/** Persist the issued token as the active remote key and reconnect the channel. */
	applyToken: (token: string) => Promise<void> | void;
	now?: number;
}

/**
 * Drive the device-side pairing sequence end-to-end: optionally regenerate the
 * live code (when none is supplied), claim it against the mock platform, and on
 * success hand the issued token to `applyToken` (which stores it as the active
 * remote key and reconnects the channel). `applyToken` is injected so the
 * orchestration is testable without the live remote socket.
 */
export async function completeMockPairing(
	code: string | undefined,
	deps: CompleteMockPairingDeps,
): Promise<CompleteMockPairingResult> {
	const now = deps.now ?? Date.now();
	const submitted = code ?? (await generateClaimCode(now)).code;

	const result = await mockPlatformClaim(submitted, { now });
	if (!result.ok) {
		return { paired: false, error: result.error };
	}

	await deps.applyToken(result.token);

	return {
		paired: true,
		device_id: result.claims.device_id,
		sub_status: result.claims.sub_status,
		validUntil: result.claims.exp * 1000,
	};
}
