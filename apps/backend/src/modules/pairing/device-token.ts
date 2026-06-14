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
 * Device token — PASETO v4.public verification (ADR-0006).
 *
 * ADR-0006 selects PASETO v4.public (Ed25519) for the device token, verified
 * on-device against a public key provisioned at image-build time. The crypto
 * primitives (PAE, Ed25519 sign/verify, key import) live in {@link ./paseto-v4.ts}
 * and are locked against the official PASETO `v4.public` test vectors; THIS
 * module is the claim-policy layer on top of them.
 *
 * Two distinct tokens share those primitives but are NEVER interchangeable
 * (ADR-0006 two-audience rule):
 *   - relay-config token  → {@link verifyStubDeviceToken} (BCRPT relay,
 *     `modules/remote/remote.ts`). Claims: {@link DeviceTokenClaims}.
 *   - device-control token → {@link verifyDeviceControlToken} (the new control
 *     channel). Claims: {@link DeviceControlTokenClaims}; `purpose` MUST equal
 *     `"device-control"`, checked before any claim is trusted, so a relay-config
 *     token cannot authenticate the control channel.
 *
 * Verification is GATED on the `PASETO_PUBLIC_KEY` env var (ADR-0006 D2). There
 * is NO hardcoded/baked key anywhere here — the env var's PRESENCE selects the
 * path:
 *   - key present → REAL Ed25519 v4.public verification. An unsigned or forged
 *     token is rejected; there is NO fallback to the unsigned path when the key
 *     is set. An unusable key (not 32 base64 bytes) refuses every token.
 *   - key absent  → MVP opaque-token path: claim shape + `iat`/`exp` window
 *     validated, signature NOT checked, a clear warn-once is logged. This keeps
 *     the current key-less device fleet working until the Ed25519 key is
 *     provisioned at image build.
 *
 * Clock skew: `iat`/`exp` are validated with the ADR-0006 ±30s band.
 *
 * Edge E-1: the `sub_status` claim (relay-config) reflects subscription standing
 * AT ISSUANCE, not live billing state. Real-time enforcement of a lapse is
 * bounded by `exp` plus a re-pair. Mid-token revocation is out of scope (no
 * refresh/revocation path this cycle).
 */

import type {
	DeviceTokenClaims,
	SubscriptionStatus,
} from "@ceraui/rpc/schemas";
import { deviceTokenClaimsSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import { importEd25519PublicKey, verifyV4Public } from "./paseto-v4.ts";

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
 * Run the REAL PASETO v4.public Ed25519 check and return the verified payload
 * JSON string, or `null` on any failure. An unusable key (not 32 base64 bytes)
 * makes {@link importEd25519PublicKey} throw — that is logged once-per-call at
 * error level and treated as "reject", never as "accept unverified".
 */
function verifyRealPayload(token: string, publicKeyB64: string): string | null {
	try {
		const key = importEd25519PublicKey(publicKeyB64);
		const verified = verifyV4Public(token, key);
		return verified ? verified.payload : null;
	} catch (err) {
		logger.error(
			`${DEVICE_TOKEN_PUBLIC_KEY_ENV} is not a usable base64 Ed25519 public key (refusing the token): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return null;
	}
}

/**
 * REAL Ed25519 verification for the relay-config token (ADR-0006). Verifies the
 * `v4.public` signature against the provisioned public key, validates the claim
 * shape, and enforces the `iat`/`exp` ±30s window. Returns the validated claims,
 * or `null` on any failure — it NEVER falls back to the unsigned path when a key
 * is provisioned.
 */
function verifyWithProvisionedKey(
	token: string,
	publicKey: string,
	now: number,
): DeviceTokenClaims | null {
	const payloadJson = verifyRealPayload(token, publicKey);
	if (payloadJson === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
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

// Warn-once latch: emit the "running without signature verification" notice at
// most once per process rather than on every reconnect/verify call.
let warnedUnverified = false;

/**
 * Verify a relay-config device token (ADR-0006), gated on key provisioning.
 *
 * 1. basic format check (`v4.public.` header);
 * 2. if `PASETO_PUBLIC_KEY` is set, run REAL Ed25519 verification
 *    ({@link verifyWithProvisionedKey}); a forged/unsigned/expired token is
 *    rejected and there is NO fallback to the unsigned path;
 * 3. if no key is provisioned, run the MVP opaque-token path (claim shape +
 *    window validated, signature NOT checked) with a clear warn-once.
 *
 * Returns the validated claims, or `null` on any failure.
 */
export function verifyStubDeviceToken(
	token: string,
	now: number = Date.now(),
): DeviceTokenClaims | null {
	// (1) Basic format gate: must carry the real PASETO v4.public header.
	if (!token.startsWith(DEVICE_TOKEN_HEADER)) return null;

	// (2) A provisioned public key means real verification is mandatory.
	const publicKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV]?.trim();
	if (publicKey) {
		return verifyWithProvisionedKey(token, publicKey, now);
	}

	// (3) No provisioned key → MVP opaque-token path, with a clear warning.
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

// =============================================================================
// Device-control channel token (ADR-0006 v2.0 addendum, spec §10)
// =============================================================================

/**
 * The `purpose` value a token MUST carry to authenticate the device-control
 * channel. A relay-config token (or any other audience) is rejected (ADR-0006
 * two-audience rule, spec §10).
 */
export const DEVICE_CONTROL_PURPOSE = "device-control";

/** Control-channel roles (spec §12). v2.0 issues `owner` only. */
const deviceControlRoleSchema = z.enum(["owner", "copilot", "viewer"]);

/**
 * Canonical device-control token claims (spec §10). DISTINCT from the
 * relay-config {@link DeviceTokenClaims}: snake_case `tenant_id`, plus `role`,
 * `purpose`, `jti`, and the optional `aud`. Each repo defines its own validator
 * (spec §10 alignment note); this is the device-side validator.
 */
export const deviceControlTokenClaimsSchema = z.object({
	device_id: z.string().min(1),
	tenant_id: z.string().min(1),
	serial: z.string().min(1),
	role: deviceControlRoleSchema,
	purpose: z.literal(DEVICE_CONTROL_PURPOSE),
	jti: z.string().min(1),
	iat: z.number().int().nonnegative(),
	exp: z.number().int().nonnegative(),
	aud: z.string().min(1).optional(),
});
export type DeviceControlTokenClaims = z.infer<
	typeof deviceControlTokenClaimsSchema
>;

export interface MintStubDeviceControlTokenParams {
	deviceId: string;
	tenantId: string;
	serial: string;
	role?: z.infer<typeof deviceControlRoleSchema>;
	jti: string;
	aud?: string;
	/** Issued-at instant, epoch ms (defaults to now). */
	now?: number;
	/** Token lifetime in seconds (defaults to the spec §10 15-minute TTL). */
	ttlSeconds?: number;
}

/** Control-channel TTL: 15 minutes (spec §10 short TTL + refresh). */
export const DEVICE_CONTROL_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Mint an UNSIGNED device-control token (dev/test only). Mirrors
 * {@link mintStubDeviceToken}: it carries the real claim shape behind the real
 * `v4.public.` header but is NOT signed. Production tokens are signed by the
 * platform; tests sign with {@link signV4Public} from `./paseto-v4.ts`.
 */
export function mintStubDeviceControlToken(
	params: MintStubDeviceControlTokenParams,
): string {
	const nowSeconds = Math.floor((params.now ?? Date.now()) / 1000);
	const ttl = params.ttlSeconds ?? DEVICE_CONTROL_TOKEN_TTL_SECONDS;
	const claims: DeviceControlTokenClaims = {
		device_id: params.deviceId,
		tenant_id: params.tenantId,
		serial: params.serial,
		role: params.role ?? "owner",
		purpose: DEVICE_CONTROL_PURPOSE,
		jti: params.jti,
		iat: nowSeconds,
		exp: nowSeconds + ttl,
		...(params.aud !== undefined ? { aud: params.aud } : {}),
	};
	return `${DEVICE_TOKEN_HEADER}${base64UrlEncode(JSON.stringify(claims))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the `v4.public.<body>` payload as a JSON string WITHOUT verifying. */
function decodeUnsignedPayload(token: string): string | null {
	const parts = token.split(".");
	const body = parts[2];
	if (parts[0] !== "v4" || parts[1] !== "public" || body === undefined) {
		return null;
	}
	try {
		return base64UrlDecode(body);
	} catch {
		return null;
	}
}

// Warn-once latch for the control-channel unsigned dev path (separate from the
// relay-config latch so each surfaces its own notice exactly once per process).
let warnedControlUnverified = false;

/**
 * Verify a DEVICE-CONTROL token (spec §10), gated on key provisioning.
 *
 * 1. format gate (`v4.public.` header);
 * 2. key present → REAL Ed25519 verification; key absent → MVP unsigned dev
 *    path with a warn-once (the key-less fleet still resolves identity locally);
 * 3. PURPOSE GATE: reject unless `purpose === "device-control"` BEFORE any other
 *    claim is trusted — a relay-config token cannot cross audiences;
 * 4. validate the full control claim shape;
 * 5. enforce the `iat`/`exp` ±30s window.
 *
 * Returns the validated claims, or `null` on any failure.
 */
export function verifyDeviceControlToken(
	token: string,
	now: number = Date.now(),
): DeviceControlTokenClaims | null {
	// (1) Basic format gate.
	if (!token.startsWith(DEVICE_TOKEN_HEADER)) return null;

	// (2) Key presence selects real verification vs the MVP unsigned dev path.
	const publicKey = process.env[DEVICE_TOKEN_PUBLIC_KEY_ENV]?.trim();
	let payloadJson: string | null;
	if (publicKey) {
		payloadJson = verifyRealPayload(token, publicKey);
	} else {
		if (!warnedControlUnverified) {
			warnedControlUnverified = true;
			logger.warn(
				`${DEVICE_TOKEN_PUBLIC_KEY_ENV} is not set: accepting device-control tokens WITHOUT signature verification (MVP unsigned path, ADR-0006). Provision an Ed25519 public key to enable real verification.`,
			);
		}
		payloadJson = decodeUnsignedPayload(token);
	}
	if (payloadJson === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		return null;
	}

	// (3) PURPOSE GATE (ADR-0006 two-audience rule): a relay-config token MUST
	// NOT authenticate the control channel, even with a valid signature.
	if (!isRecord(parsed) || parsed.purpose !== DEVICE_CONTROL_PURPOSE) {
		logger.warn(
			'device-control token rejected: purpose is not "device-control"',
		);
		return null;
	}

	// (4) Validate the full control claim shape.
	const result = deviceControlTokenClaimsSchema.safeParse(parsed);
	if (!result.success) return null;
	const claims = result.data;

	// (5) Enforce the ±30s expiry window.
	const nowSeconds = Math.floor(now / 1000);
	if (nowSeconds + DEVICE_TOKEN_SKEW_SECONDS < claims.iat) return null;
	if (nowSeconds - DEVICE_TOKEN_SKEW_SECONDS > claims.exp) return null;

	return claims;
}
