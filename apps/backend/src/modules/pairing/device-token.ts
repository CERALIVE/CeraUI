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
 * Device token — verification contract + stub issuer (ADR-0006).
 *
 * ADR-0006 selects PASETO v4.public (Ed25519) for the device token, verified
 * on-device against a public key provisioned at image-build time. That ADR is
 * still `proposed` and the Ed25519 key is not yet provisioned, so this module
 * is intentionally a STUB: it carries the real claim shape and the real
 * `v4.public.` header, validates `iat`/`exp` with the ADR's ±30s skew band, but
 * performs NO Ed25519 signing or verification yet.
 *
 * Verification is GATED on the `PASETO_PUBLIC_KEY` env var (the provisioned
 * public key, ADR-0006 D2). There is NO hardcoded/baked key anywhere here — the
 * env var's PRESENCE selects the path:
 *   - key absent  → MVP opaque-token path: claim shape + window validated,
 *                   signature NOT checked, a clear warning is logged.
 *   - key present → the real Ed25519 verifier is invoked. That path is still
 *                   blocked (see {@link verifyWithProvisionedKey}); it refuses
 *                   the token rather than ever accept it unverified.
 * When the ADR is accepted and the key is provisioned, the real Ed25519 verify
 * slots into {@link verifyWithProvisionedKey} without changing callers.
 */

import type {
	DeviceTokenClaims,
	SubscriptionStatus,
} from "@ceraui/rpc/schemas";
import { deviceTokenClaimsSchema } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

/** PASETO v4.public header (ADR-0006). The stub keeps it so the shape is real. */
export const DEVICE_TOKEN_HEADER = "v4.public.";

/** Default token lifetime: 30 days, matching the pairing lifecycle horizon. */
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Clock-skew tolerance band (ADR-0006: ±30s). */
export const DEVICE_TOKEN_SKEW_SECONDS = 30;

/**
 * Env var carrying the base64 Ed25519 public key provisioned at image-build
 * time (ADR-0006 D2). Its PRESENCE — not any baked-in default — gates real
 * verification: there is no hardcoded key anywhere in this module.
 */
export const DEVICE_TOKEN_PUBLIC_KEY_ENV = "PASETO_PUBLIC_KEY";

function base64UrlEncode(input: string): string {
	return Buffer.from(input, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
	const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
	return Buffer.from(normalized, "base64").toString("utf8");
}

export interface MintDeviceTokenParams {
	deviceId: string;
	subStatus: SubscriptionStatus;
	/** Issued-at instant, epoch ms (defaults to now). */
	now?: number;
	ttlSeconds?: number;
}

/**
 * Mint a stub device token. Encodes the ADR-0006 claims as a base64url payload
 * behind the real `v4.public.` header. NOT signed — see the module note.
 */
export function mintStubDeviceToken(params: MintDeviceTokenParams): string {
	const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
	const ttl = params.ttlSeconds ?? DEVICE_TOKEN_TTL_SECONDS;
	const claims: DeviceTokenClaims = {
		device_id: params.deviceId,
		sub_status: params.subStatus,
		iat: nowSeconds,
		exp: nowSeconds + ttl,
	};
	return `${DEVICE_TOKEN_HEADER}${base64UrlEncode(JSON.stringify(claims))}`;
}

/**
 * The verification contract (ADR-0006). On the real path this parses the
 * `v4.public` token, verifies the Ed25519 signature against the provisioned
 * public key, and returns the validated claims (or `null` on any failure).
 */
export interface DeviceTokenVerifier {
	verify(token: string, now?: number): DeviceTokenClaims | null;
}

/**
 * Decode the stub payload and validate the claim shape and the `iat`/`exp`
 * window with ±30s skew. Performs NO signature check — this is the unsigned MVP
 * path used when no public key is provisioned. Returns `null` on any malformed,
 * out-of-window, or schema-invalid token.
 */
function decodeStubClaims(
	token: string,
	now: number,
): DeviceTokenClaims | null {
	if (!token.startsWith(DEVICE_TOKEN_HEADER)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(
			base64UrlDecode(token.slice(DEVICE_TOKEN_HEADER.length)),
		);
	} catch {
		return null;
	}

	const result = deviceTokenClaimsSchema.safeParse(parsed);
	if (!result.success) return null;
	const claims = result.data;

	const nowSeconds = Math.floor(now / 1000);
	if (nowSeconds + DEVICE_TOKEN_SKEW_SECONDS < claims.iat) return null;
	if (nowSeconds - DEVICE_TOKEN_SKEW_SECONDS > claims.exp) return null;

	return claims;
}

/**
 * Real Ed25519 verification seam — GATED / NOT YET IMPLEMENTED.
 *
 * TODO(high-priority-debt): Real Ed25519 verification blocked on ADR-0006
 * sign-off (D1) + Ed25519 key provisioning (D2). When unblocked: use paseto-ts
 * to verify against the image-build-provisioned public key with ±30s skew.
 *
 * A provisioned `PASETO_PUBLIC_KEY` signals the operator expects REAL
 * verification. Because that verifier does not exist yet, this MUST NOT fall
 * back to the unsigned path and silently accept the token — it refuses
 * (returns `null`) and logs at error level. The real implementation will
 * consume `token` / `publicKey` / `now` to run the Ed25519 check.
 */
function verifyWithProvisionedKey(
	_token: string,
	_publicKey: string,
	_now: number,
): DeviceTokenClaims | null {
	logger.error(
		`${DEVICE_TOKEN_PUBLIC_KEY_ENV} is set but PASETO v4.public Ed25519 verification is not implemented yet (ADR-0006 pending D1 sign-off + D2 key provisioning); refusing the token instead of accepting it unverified`,
	);
	return null;
}

// Warn-once latch: emit the "running without signature verification" notice at
// most once per process rather than on every reconnect/verify call.
let warnedUnverified = false;

/**
 * Verify a device token (ADR-0006), gated on key provisioning. This is the seam
 * the real Ed25519 verifier slots into.
 *
 * 1. basic format check (`v4.public.` header);
 * 2/3. if `PASETO_PUBLIC_KEY` is set, invoke the real verifier — see
 *      {@link verifyWithProvisionedKey} for the `TODO(high-priority-debt)`. That
 *      path (5) NEVER silently accepts: it refuses until real verify lands;
 * 4. if no key is provisioned, run the MVP opaque-token path (claim shape +
 *    window validated, signature NOT checked) with a clear log warning.
 *
 * Returns the validated claims, or `null` on any failure.
 */
export function verifyStubDeviceToken(
	token: string,
	now: number = Date.now(),
): DeviceTokenClaims | null {
	// (1) Basic format gate: must carry the real PASETO v4.public header.
	if (!token.startsWith(DEVICE_TOKEN_HEADER)) return null;

	// (2)/(3) A provisioned public key means real verification is expected.
	// (5) Never silently accept while the real verifier is gated — refuse.
	const publicKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV]?.trim();
	if (publicKey) {
		return verifyWithProvisionedKey(token, publicKey, now);
	}

	// (4) No provisioned key → MVP opaque-token path, with a clear warning.
	if (!warnedUnverified) {
		warnedUnverified = true;
		logger.warn(
			`${DEVICE_TOKEN_PUBLIC_KEY_ENV} is not set: accepting device tokens WITHOUT signature verification (MVP opaque-token path, ADR-0006 stub). Provision an Ed25519 public key to enable real verification.`,
		);
	}

	return decodeStubClaims(token, now);
}

export const stubDeviceTokenVerifier: DeviceTokenVerifier = {
	verify: verifyStubDeviceToken,
};
