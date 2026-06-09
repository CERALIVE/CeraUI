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
 * Single-use loopback kiosk token (DC-3, docs/KIOSK_TOKEN_CONTRACT.md).
 *
 * At kiosk-service start the backend mints 32 bytes of entropy, hex-encodes it,
 * and writes it to a tmpfs path with 0600 permissions. The image kiosk.service
 * reads that file and appends `&kiosk_token=<hex>` to the Chromium launch URL.
 * The first GET that carries the token — and only from 127.0.0.1 — is exchanged
 * for a session cookie and the token is invalidated immediately (single-use).
 *
 * The token is raw entropy: not a PASETO token, not a claim code, never written
 * to durable disk, and never logged.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../helpers/logger.ts";

/** Query-parameter name carrying the kiosk token (fixed by the contract). */
export const KIOSK_TOKEN_PARAM = "kiosk_token";

/** Entropy of the kiosk token, in bytes (→ 64 hex characters). */
const TOKEN_BYTES = 32;

/** Production tmpfs directory. `/run` is tmpfs on systemd systems — never disk. */
const DEFAULT_RUN_DIR = "/run/ceralive";

/**
 * Resolve the tmpfs directory that holds the kiosk token. Overridable via
 * CERALIVE_RUN_DIR for tests, so the suite never writes to the real /run and
 * never needs root.
 */
function runDir(): string {
	return process.env.CERALIVE_RUN_DIR ?? DEFAULT_RUN_DIR;
}

/** Absolute path of the single-use kiosk token file (tmpfs only). */
export function kioskTokenPath(): string {
	return path.join(runDir(), "kiosk-token");
}

/**
 * Generate 32 bytes of cryptographic randomness, hex-encoded (64 chars).
 *
 * Uses `crypto.getRandomValues` + hex (per the contract) rather than the
 * `randomBase64` helper: the token is embedded in a shell ExecStart line and a
 * URL query parameter, where hex is unambiguous. This is NOT a PASETO token.
 */
function generateToken(): string {
	const buf = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(buf);
	return Buffer.from(buf).toString("hex");
}

/**
 * Mint a fresh single-use kiosk token: write the 64-character hex value to the
 * tmpfs path with 0600 permissions (no trailing newline). Called at
 * kiosk-service start; minting again simply rotates to a fresh token.
 *
 * @returns the newly minted token (also written to {@link kioskTokenPath}).
 */
export async function mintKioskToken(): Promise<string> {
	const token = generateToken();
	const dir = runDir();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });

	const file = kioskTokenPath();
	// tmpfs only — never durable disk. Bun.write does not honour a mode on an
	// existing file, so enforce 0600 explicitly afterwards.
	await Bun.write(file, token);
	await fs.chmod(file, 0o600);

	logger.info("Kiosk: minted single-use loopback token");
	return token;
}

/**
 * Invalidate the token: delete the tmpfs file. Idempotent — a missing file is
 * treated as already-invalidated.
 */
async function invalidateKioskToken(): Promise<void> {
	try {
		await fs.unlink(kioskTokenPath());
	} catch {
		// Already gone — single-use already enforced.
	}
}

/** Loopback addresses accepted for a kiosk-token exchange. */
export function isLoopbackIp(ip: string | undefined): boolean {
	if (!ip) {
		return false;
	}
	// IPv4 loopback (127.0.0.0/8), IPv6 loopback, and IPv4-mapped IPv6 loopback.
	return /^127\./.test(ip) || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Constant-time string comparison. Both operands are fixed-format hex, so the
 * length check leaks nothing useful; the body never short-circuits on the first
 * differing byte, so a mismatched token gives no timing oracle.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/** Build the `session` cookie that the kiosk browser uses to authenticate. */
function sessionCookie(token: string): string {
	// Loopback HTTP, so no `Secure`. Readable by the SPA (not HttpOnly) so the
	// kiosk page can authenticate the WebSocket with it — the same exposure as
	// the password-login `auth_token` the SPA already stores client-side.
	return `session=${token}; Path=/; SameSite=Strict; Max-Age=86400`;
}

function unauthorized(error: "loopback_only" | "token_invalid"): Response {
	return Response.json({ error }, { status: 401 });
}

/**
 * Handle a kiosk-token exchange on the HTTP entry.
 *
 * Returns `null` when the request carries no `kiosk_token` parameter, so the
 * caller falls through to the normal request flow. Otherwise returns the
 * exchange response:
 *   - non-loopback source IP            → 401 `{ error: "loopback_only" }` (file untouched)
 *   - valid token from loopback         → 200 + `Set-Cookie: session=...`
 *   - missing / mismatched token        → 401 `{ error: "token_invalid" }`
 *
 * The token is invalidated (file deleted) before the response is returned, and
 * regardless of whether the comparison succeeded — there is no reuse window and
 * no oracle distinguishing a mismatch from a reuse.
 *
 * @param req          the incoming GET request.
 * @param clientIp     the source IP, as reported by `server.requestIP()`.
 * @param issueSession mints a session token registered with the auth layer; its
 *                     return value is handed back as the `session` cookie.
 */
export async function handleKioskTokenExchange(
	req: Request,
	clientIp: string | undefined,
	issueSession: () => string,
): Promise<Response | null> {
	const url = new URL(req.url);
	const presented = url.searchParams.get(KIOSK_TOKEN_PARAM);
	if (presented === null) {
		// No kiosk token — let the normal auth flow handle this request.
		return null;
	}

	// 1. Loopback gate — reject LAN before reading the token file.
	if (!isLoopbackIp(clientIp)) {
		logger.warn("Kiosk: rejected token exchange from non-loopback source");
		return unauthorized("loopback_only");
	}

	// 2. Read the minted token from tmpfs (single value, no trailing newline).
	let stored: string;
	try {
		stored = (await Bun.file(kioskTokenPath()).text()).trim();
	} catch {
		// File absent/unreadable → already used or never minted.
		logger.warn("Kiosk: token exchange rejected (no live token)");
		return unauthorized("token_invalid");
	}

	// 3. Invalidate BEFORE responding, regardless of the comparison result, so a
	//    second request can never race the deletion and reuse is impossible.
	await invalidateKioskToken();

	// 4. Constant-time compare.
	if (stored.length === 0 || !timingSafeEqual(stored, presented.trim())) {
		logger.warn("Kiosk: token exchange rejected (token mismatch)");
		return unauthorized("token_invalid");
	}

	// 5. Issue the session cookie (same session-token mechanism as login).
	const session = issueSession();
	logger.info("Kiosk: loopback token exchanged for session");

	// 200 + Set-Cookie; the body strips the spent token from the URL so it does
	// not linger in browser history before the SPA loads from "/".
	return new Response(
		'<!doctype html><html><head><meta charset="utf-8">' +
			'<meta http-equiv="refresh" content="0; url=/"><title>CeraUI</title></head>' +
			"<body>Authenticating&hellip;</body></html>",
		{
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Set-Cookie": sessionCookie(session),
			},
		},
	);
}
