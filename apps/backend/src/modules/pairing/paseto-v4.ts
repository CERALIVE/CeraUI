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
 * PASETO v4.public primitives (Ed25519), ADR-0006.
 *
 * Pure transport-format layer: PAE (pre-authentication encoding), base64url, and
 * the Ed25519 sign/verify mechanics. It knows nothing about device-token claims —
 * that policy lives in {@link ./device-token.ts}. Keeping the crypto here means
 * the PAE construction exists in exactly ONE place and is locked against the
 * official PASETO `v4.public` test vectors (see `tests/device-token.test.ts`).
 *
 * Why `node:crypto` (not Bun's WebCrypto): Bun's `node:crypto` Ed25519
 * sign/verify is SYNCHRONOUS, so the device-token verifier keeps its existing
 * synchronous contract (`DeviceTokenVerifier.verify`). WebCrypto's `subtle.verify`
 * is async and would force every caller — including the remote channel's
 * `on("open")` handler — to become async. There is no Bun-native Ed25519
 * `KeyObject` API, and this is signature verification, not random generation, so
 * the `randomBase64`-over-`crypto.randomBytes` convention does not apply here.
 *
 * The platform is the only signer in production (it holds `PASETO_SIGNING_KEY`);
 * {@link signV4Public} exists for tests and tooling — the device never signs.
 */

import {
	createPublicKey,
	type KeyObject,
	sign as nodeSign,
	verify as nodeVerify,
} from "node:crypto";

/** PASETO v4.public header. */
const V4_PUBLIC_HEADER = "v4.public.";
/** Ed25519 signature length (bytes). */
const ED25519_SIGNATURE_BYTES = 64;
/** Raw Ed25519 public key length (bytes). */
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Fixed ASN.1 SubjectPublicKeyInfo prefix for an Ed25519 public key. Prepending
 * it to the 32 raw key bytes yields a 44-byte SPKI DER that `createPublicKey`
 * accepts — the standard way to import a raw Ed25519 key via `node:crypto`.
 */
const ED25519_SPKI_PREFIX = Uint8Array.from([
	0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Little-endian 64-bit length encoding with the most-significant bit cleared,
 * per the PASETO PAE specification.
 */
function le64(n: number): Uint8Array {
	const out = new Uint8Array(8);
	let value = BigInt(n);
	for (let i = 0; i < 8; i++) {
		if (i === 7) value &= 0x7fn; // clear the top bit of the final byte (spec)
		out[i] = Number(value & 0xffn);
		value >>= 8n;
	}
	return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/**
 * PAE — Pre-Authentication Encoding (PASETO spec). Binds every piece (header,
 * message, footer, implicit assertion) length-prefixed so a signature cannot be
 * replayed across a different framing.
 */
function pae(pieces: Uint8Array[]): Uint8Array {
	const parts: Uint8Array[] = [le64(pieces.length)];
	for (const piece of pieces) {
		parts.push(le64(piece.length));
		parts.push(piece);
	}
	return concatBytes(parts);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlDecodeBytes(input: string): Uint8Array {
	const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
	return new Uint8Array(Buffer.from(normalized, "base64"));
}

/** Decode a base64 or base64url string (with or without padding) to bytes. */
function decodeBase64Flexible(input: string): Uint8Array {
	return base64UrlDecodeBytes(input.trim());
}

/**
 * Import a base64-encoded raw 32-byte Ed25519 public key (the `PASETO_PUBLIC_KEY`
 * env format, ADR-0006 D2) into a `node:crypto` `KeyObject`. Throws on any
 * malformed input — callers verifying tokens MUST treat a throw as "reject".
 */
export function importEd25519PublicKey(base64Raw: string): KeyObject {
	const raw = decodeBase64Flexible(base64Raw);
	if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
		throw new Error(
			`Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
		);
	}
	const der = concatBytes([ED25519_SPKI_PREFIX, raw]);
	return createPublicKey({
		key: Buffer.from(der),
		format: "der",
		type: "spki",
	});
}

/**
 * Export the raw 32-byte Ed25519 public key from a `KeyObject` as base64 — the
 * inverse of {@link importEd25519PublicKey}. Used by tests to derive the
 * `PASETO_PUBLIC_KEY` value for a freshly generated keypair.
 */
export function exportEd25519PublicKeyBase64(key: KeyObject): string {
	const spki = key.export({ format: "der", type: "spki" });
	const bytes = new Uint8Array(spki);
	return Buffer.from(
		bytes.subarray(bytes.length - ED25519_PUBLIC_KEY_BYTES),
	).toString("base64");
}

/** Decoded result of a successful {@link verifyV4Public} call. */
export interface VerifiedV4Public {
	/** The signed message body (the claims JSON, as a string). */
	payload: string;
	/** The decoded footer string (empty when absent). */
	footer: string;
}

/**
 * Sign a `v4.public` token. PRODUCTION DOES NOT CALL THIS — only the platform
 * signs (it holds the secret key). Present for tests/tooling and to keep the PAE
 * construction symmetric with {@link verifyV4Public}.
 */
export function signV4Public(
	payload: string,
	secretKey: KeyObject,
	footer = "",
	implicit = "",
): string {
	const message = textEncoder.encode(payload);
	const footerBytes = textEncoder.encode(footer);
	const m2 = pae([
		textEncoder.encode(V4_PUBLIC_HEADER),
		message,
		footerBytes,
		textEncoder.encode(implicit),
	]);
	const signature = new Uint8Array(nodeSign(null, m2, secretKey));
	const body = base64UrlEncodeBytes(concatBytes([message, signature]));
	let token = `${V4_PUBLIC_HEADER}${body}`;
	if (footer) token += `.${base64UrlEncodeBytes(footerBytes)}`;
	return token;
}

/**
 * Verify a `v4.public` token against an Ed25519 public key. Returns the decoded
 * payload + footer on success, or `null` on ANY failure (malformed token, wrong
 * header, bad base64, short body, or signature mismatch). Never throws.
 *
 * `implicit` is the implicit assertion bound into the signature; it defaults to
 * empty and must match the value used at signing time.
 */
export function verifyV4Public(
	token: string,
	publicKey: KeyObject,
	implicit = "",
): VerifiedV4Public | null {
	const parts = token.split(".");
	if (parts.length !== 3 && parts.length !== 4) return null;
	if (parts[0] !== "v4" || parts[1] !== "public") return null;

	let raw: Uint8Array;
	let footer = "";
	try {
		raw = base64UrlDecodeBytes(parts[2] ?? "");
		if (parts.length === 4) {
			footer = textDecoder.decode(base64UrlDecodeBytes(parts[3] ?? ""));
		}
	} catch {
		return null;
	}
	if (raw.length < ED25519_SIGNATURE_BYTES) return null;

	const message = raw.subarray(0, raw.length - ED25519_SIGNATURE_BYTES);
	const signature = raw.subarray(raw.length - ED25519_SIGNATURE_BYTES);
	const m2 = pae([
		textEncoder.encode(V4_PUBLIC_HEADER),
		message,
		textEncoder.encode(footer),
		textEncoder.encode(implicit),
	]);

	let ok = false;
	try {
		ok = nodeVerify(null, m2, publicKey, signature);
	} catch {
		return null;
	}
	if (!ok) return null;

	return { payload: textDecoder.decode(message), footer };
}
