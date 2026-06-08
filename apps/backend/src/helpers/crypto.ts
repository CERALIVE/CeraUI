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
 * Bun-native crypto helpers.
 * Replaces node:crypto usage across the codebase.
 */

/**
 * Generate `byteLength` cryptographically-random bytes and return them
 * as a base64-encoded string.
 *
 * Equivalent to `crypto.randomBytes(byteLength).toString("base64")` but
 * uses Bun's built-in `crypto.getRandomValues` — no node:crypto import needed.
 *
 * @param byteLength Number of random bytes (e.g. 32 → 44-char base64 string)
 */
export function randomBase64(byteLength: number): string {
	const buf = new Uint8Array(byteLength);
	crypto.getRandomValues(buf);
	return Buffer.from(buf).toString("base64");
}

/**
 * Compute an HMAC-SHA256 over `message` keyed by `key`, returning the raw
 * 32-byte digest.
 *
 * Uses Bun's native `CryptoHasher` in HMAC mode — no node:crypto import needed.
 * A hasher cannot be reused after `digest()`, so a fresh one is created per call.
 *
 * @param key     Secret key (raw bytes or string).
 * @param message Message to authenticate (UTF-8 string).
 */
export function hmacSha256(
	key: Uint8Array | string,
	message: string,
): Uint8Array {
	const hasher = new Bun.CryptoHasher("sha256", key);
	hasher.update(message);
	return new Uint8Array(hasher.digest());
}

/**
 * Compute a hex-encoded SHA-256 digest of `data`.
 *
 * Bun-native (`CryptoHasher`) — used to fingerprint provisioned identity
 * material (e.g. a cert-work client cert) without pulling in node:crypto.
 */
export function sha256Hex(data: Uint8Array | string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(data);
	return hasher.digest("hex");
}
