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

/*
  Single-use token → cookie-backed browsing session for the dongle admin proxy.

  It is the preview-token pattern with the ONE difference the surface forces: a
  preview is one socket, an admin UI is a whole browsing session of many
  requests, so a single-use token cannot authenticate each one. The token is
  minted over the already-authenticated RPC socket and exchanged EXACTLY ONCE for
  an HttpOnly cookie scoped to the proxy prefix — the operator's password never
  rides a URL, and every later request in the session is cookie-authenticated on
  CeraUI's own origin, like the rest of the UI.

  In memory only. Never persisted, never logged, and scoped so it grants access
  to nothing but the proxy path.
*/

import { DONGLE_ADMIN_PATH_PREFIX } from "@ceraui/rpc/schemas";

/** How long a freshly minted token may be exchanged for a session. */
export const DONGLE_ADMIN_TOKEN_TTL_MS = 30_000;

/** How long an opened admin session stays valid. */
export const DONGLE_ADMIN_SESSION_TTL_MS = 30 * 60_000;

const TOKEN_BYTES = 32;

const liveTokens = new Map<string, number>();
const liveSessions = new Map<string, number>();

function generateSecret(): string {
	const buf = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(buf);
	return Buffer.from(buf).toString("hex");
}

function prune(store: Map<string, number>, now: number): void {
	for (const [key, expiresAt] of store) {
		if (expiresAt <= now) store.delete(key);
	}
}

/** Mint a single-use token valid for {@link DONGLE_ADMIN_TOKEN_TTL_MS}. */
export function mintDongleAdminToken(now: number = Date.now()): string {
	prune(liveTokens, now);
	const token = generateSecret();
	liveTokens.set(token, now + DONGLE_ADMIN_TOKEN_TTL_MS);
	return token;
}

/**
 * Consume a token and open a session, or `undefined`.
 *
 * The token is deleted on the first lookup whatever the outcome, so reuse is
 * impossible and an expired miss is indistinguishable from a consumed one.
 */
export function exchangeDongleAdminToken(
	token: string,
	now: number = Date.now(),
): string | undefined {
	const expiresAt = liveTokens.get(token);
	if (expiresAt === undefined) return undefined;
	liveTokens.delete(token);
	if (expiresAt <= now) return undefined;
	prune(liveSessions, now);
	const session = generateSecret();
	liveSessions.set(session, now + DONGLE_ADMIN_SESSION_TTL_MS);
	return session;
}

/** Is this an open admin session? Sessions are reusable within their TTL. */
export function isDongleAdminSession(
	session: string | undefined,
	now: number = Date.now(),
): boolean {
	if (session === undefined || session === "") return false;
	const expiresAt = liveSessions.get(session);
	if (expiresAt === undefined) return false;
	if (expiresAt <= now) {
		liveSessions.delete(session);
		return false;
	}
	return true;
}

/**
 * The `Set-Cookie` opening an admin session.
 *
 * `HttpOnly` because nothing in the SPA reads it, `SameSite=Strict` because the
 * session is only ever entered from CeraUI's own origin, and `Path` scoped to
 * the proxy prefix so it is never presented to any other CeraUI route. No
 * `Secure`: the device legitimately serves plain HTTP on the LAN, and a `Secure`
 * cookie would silently never be stored there.
 */
export function dongleAdminSessionCookie(session: string): string {
	const maxAge = Math.floor(DONGLE_ADMIN_SESSION_TTL_MS / 1000);
	return `ceraui_dongle_admin=${session}; Path=${DONGLE_ADMIN_PATH_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Read one cookie value out of a request `Cookie` header. */
export function readCookie(
	header: string | null,
	name: string,
): string | undefined {
	if (header === null) return undefined;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
	}
	return undefined;
}

/** Strip CeraUI's own session cookies before forwarding the rest to the dongle. */
export function cookiesForDongle(header: string | null): string {
	if (header === null) return "";
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => {
			const name = part.slice(0, Math.max(0, part.indexOf("=")));
			return name !== "ceraui_dongle_admin" && name !== "session";
		})
		.join("; ");
}

/** Test seam: drop every outstanding token and session. */
export function resetDongleAdminSessions(): void {
	liveTokens.clear();
	liveSessions.clear();
}
