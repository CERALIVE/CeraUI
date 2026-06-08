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
 * still `proposed`, so this module is intentionally a STUB: it carries the real
 * claim shape and the real `v4.public.` header, validates `iat`/`exp` with the
 * ADR's ±30s skew band, but performs NO Ed25519 signing or verification yet.
 * When the ADR is accepted, {@link DeviceTokenVerifier} is the seam the real
 * Ed25519 verifier slots into without changing callers.
 */

import type {
	DeviceTokenClaims,
	SubscriptionStatus,
} from "@ceraui/rpc/schemas";
import { deviceTokenClaimsSchema } from "@ceraui/rpc/schemas";

/** PASETO v4.public header (ADR-0006). The stub keeps it so the shape is real. */
export const DEVICE_TOKEN_HEADER = "v4.public.";

/** Default token lifetime: 30 days, matching the pairing lifecycle horizon. */
export const DEVICE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Clock-skew tolerance band (ADR-0006: ±30s). */
export const DEVICE_TOKEN_SKEW_SECONDS = 30;

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
 * Stub verifier: decodes the payload, validates the claim shape and the
 * `iat`/`exp` window with ±30s skew. Returns `null` on any malformed,
 * out-of-window, or schema-invalid token. Performs no signature check yet.
 */
export function verifyStubDeviceToken(
	token: string,
	now: number = Date.now(),
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

export const stubDeviceTokenVerifier: DeviceTokenVerifier = {
	verify: verifyStubDeviceToken,
};
