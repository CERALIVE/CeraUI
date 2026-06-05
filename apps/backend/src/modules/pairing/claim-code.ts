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
 * Device-side claim-code generation (device-pairing-claim-code change).
 *
 * Generates a short-lived, human-typeable claim-code the user submits on the
 * platform to bind this device to their account. The code is:
 *
 *   - Time-bounded: valid for a fixed window (default 5 minutes). Stable within
 *     the window, deterministically rotates once the window elapses.
 *   - Cryptographically seeded: HMAC-SHA256 over (device serial + window index)
 *     keyed by a persistent crypto-random per-device secret. Unguessability
 *     comes from the secret key, not from the (public) serial.
 *   - Unambiguous: the HMAC digest is mapped onto an alphabet that excludes
 *     visually-similar characters (0/O, 1/I/L) via unbiased rejection sampling.
 *   - Skew-tolerant: a submitted code validates across a ±30s boundary band
 *     (ADR-0006), so a code generated just before a window boundary still
 *     verifies just after it, and vice-versa.
 *
 * Token issuance (PASETO v4.public, ADR-0006) is intentionally NOT implemented
 * here — that ADR is still `proposed`. See {@link issueDeviceToken}.
 */

import os from "node:os";

import { CLAIM_CODE_ALPHABET, type ClaimCodeOutput } from "@ceraui/rpc/schemas";

import { getConfig, saveConfig } from "../config.ts";
import { hmacSha256, randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";

/** Default validity window: 5 minutes. */
export const CLAIM_CODE_WINDOW_SECONDS = 5 * 60;

/** Clock-skew tolerance band around each window boundary (ADR-0006: ±30s). */
export const CLAIM_CODE_SKEW_SECONDS = 30;

/**
 * Generated code length. 8 chars from the 31-symbol unambiguous alphabet gives
 * ~39.6 bits of HMAC-derived entropy — comfortably inside the schema's 6–8
 * bound without weakening it.
 */
export const CLAIM_CODE_LENGTH = 8;

const ALPHABET_LEN = CLAIM_CODE_ALPHABET.length;
// Largest multiple of ALPHABET_LEN that fits in a byte; bytes at or above this
// are rejected so the alphabet mapping stays unbiased (no modulo skew).
const REJECTION_CEILING = Math.floor(256 / ALPHABET_LEN) * ALPHABET_LEN;

// Cache only the discovered (proc/hostname) serial. An explicit DEVICE_SERIAL
// env override is read fresh on every call so it always wins and stays testable.
let cachedSerial: string | undefined;

/**
 * Read a stable per-device identifier used to namespace the claim-code to this
 * device. Resolution order:
 *   1. `DEVICE_SERIAL` env override (always wins; never cached).
 *   2. `Serial` line from `/proc/cpuinfo` (ARM SBCs expose it here).
 *   3. `os.hostname()` fallback (dev / x86 where cpuinfo has no Serial).
 *
 * The serial is not a secret — it only binds the code to a device identity the
 * platform can attribute. Unguessability comes from the HMAC key.
 */
export async function getDeviceSerial(): Promise<string> {
	const envSerial = process.env.DEVICE_SERIAL?.trim();
	if (envSerial) return envSerial;

	if (cachedSerial !== undefined) return cachedSerial;

	try {
		const cpuinfo = await Bun.file("/proc/cpuinfo").text();
		for (const line of cpuinfo.split("\n")) {
			const match = /^Serial\s*:\s*(\S+)/.exec(line);
			if (match?.[1]) {
				cachedSerial = match[1];
				return cachedSerial;
			}
		}
	} catch {
		// /proc/cpuinfo unreadable (non-Linux / dev) — fall through to hostname.
	}

	cachedSerial = os.hostname() || "ceralive-device";
	return cachedSerial;
}

/**
 * Resolve the persistent HMAC secret that seeds claim-code derivation. Created
 * once on first use (crypto-random, 32 bytes base64), persisted to config so
 * codes stay stable across backend restarts within a window, and never leaves
 * the device.
 */
export function getPairingSecret(): string {
	const config = getConfig();
	if (!config.pairing_secret) {
		config.pairing_secret = randomBase64(32);
		saveConfig();
		logger.info("pairing: generated new claim-code seed secret");
	}
	return config.pairing_secret;
}

/**
 * Map an HMAC digest onto `length` unambiguous-alphabet characters using
 * unbiased rejection sampling. With 32 digest bytes feeding an 8-char code the
 * stream never realistically runs dry, but if it ever did we re-hash with an
 * incrementing counter to extend it deterministically (so the same window
 * always yields the same code).
 */
function codeForWindow(
	secret: string,
	serial: string,
	windowIndex: number,
	length: number,
): string {
	let out = "";
	let counter = 0;
	let digest = hmacSha256(secret, `${serial}:${windowIndex}`);
	let i = 0;

	while (out.length < length) {
		if (i >= digest.length) {
			counter += 1;
			digest = hmacSha256(secret, `${serial}:${windowIndex}:${counter}`);
			i = 0;
		}
		const byte = digest[i] ?? 0;
		i += 1;
		if (byte < REJECTION_CEILING) {
			out += CLAIM_CODE_ALPHABET[byte % ALPHABET_LEN];
		}
	}

	return out;
}

export interface ClaimCodeParams {
	/** Epoch milliseconds at which the code is being derived. */
	now: number;
	/** Device serial (namespaces the code to this device). */
	serial: string;
	/** Persistent base64 HMAC secret (the unguessability key). */
	secret: string;
	/** Validity window length in seconds (default {@link CLAIM_CODE_WINDOW_SECONDS}). */
	windowSeconds?: number;
	/** Code length (default {@link CLAIM_CODE_LENGTH}). */
	length?: number;
}

/**
 * Pure, deterministic claim-code derivation. The same (secret, serial, window)
 * always yields the same code, so the value is stable within a window and
 * rotates exactly when `validUntil` is crossed.
 */
export function deriveClaimCode(params: ClaimCodeParams): ClaimCodeOutput {
	const windowSeconds = params.windowSeconds ?? CLAIM_CODE_WINDOW_SECONDS;
	const length = params.length ?? CLAIM_CODE_LENGTH;
	const windowMs = windowSeconds * 1000;
	const windowIndex = Math.floor(params.now / windowMs);
	const validUntil = (windowIndex + 1) * windowMs;
	const code = codeForWindow(params.secret, params.serial, windowIndex, length);
	return { code, validUntil, windowSeconds };
}

export interface ClaimCodeVerifyParams extends ClaimCodeParams {
	/** Submitted code to verify. */
	code: string;
	/** Skew tolerance in seconds (default {@link CLAIM_CODE_SKEW_SECONDS}). */
	skewSeconds?: number;
}

/** Constant-time string comparison to avoid leaking match position via timing. */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Verify a submitted claim-code against the device's current window, tolerating
 * up to ±skewSeconds of clock drift across the window boundaries (ADR-0006:
 * ±30s). A code from an adjacent window validates while `now` sits within the
 * skew band of that window's boundary, so the boundary transition is seamless
 * in both directions.
 */
export function verifyClaimCode(params: ClaimCodeVerifyParams): boolean {
	const windowSeconds = params.windowSeconds ?? CLAIM_CODE_WINDOW_SECONDS;
	const length = params.length ?? CLAIM_CODE_LENGTH;
	const skewMs = (params.skewSeconds ?? CLAIM_CODE_SKEW_SECONDS) * 1000;
	const windowMs = windowSeconds * 1000;
	const current = Math.floor(params.now / windowMs);

	for (const k of [current - 1, current, current + 1]) {
		const start = k * windowMs;
		const end = start + windowMs;
		// Accept window k when `now` falls inside its [start, end) span widened
		// by the skew band on both sides. The current window always qualifies; a
		// neighbour qualifies only within `skewMs` of the shared boundary.
		if (params.now >= start - skewMs && params.now < end + skewMs) {
			const candidate = codeForWindow(params.secret, params.serial, k, length);
			if (constantTimeEqual(candidate, params.code)) return true;
		}
	}
	return false;
}

/**
 * Generate (or return the still-valid) claim-code for this device at `now`.
 * Reads the device serial and persistent secret, then derives the per-window
 * code. Stable within a window; rotates after `validUntil`.
 */
export async function generateClaimCode(
	now: number = Date.now(),
): Promise<ClaimCodeOutput> {
	const serial = await getDeviceSerial();
	const secret = getPairingSecret();
	return deriveClaimCode({ now, serial, secret });
}

/**
 * TODO(ADR-0006, Task 25): device token issuance is deferred.
 *
 * ADR-0006 (PASETO v4.public) is still `proposed`. Until it is accepted, the
 * device does NOT mint or verify any token — claim-code generation above is
 * standalone, and the remote channel keeps using the opaque `remote_key` path
 * in `modules/remote/remote.ts` unchanged. Once the ADR lands, the platform
 * claim endpoint returns a signed token that the device stores as its
 * `remote_key`; wire that here.
 */
export function issueDeviceToken(): null {
	return null;
}
