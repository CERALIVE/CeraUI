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
 * Single-use, short-lived preview-proxy token store (Task 20).
 *
 * Mirrors the kiosk single-use token pattern (`modules/ui/kiosk-token.ts`) but
 * lives entirely IN MEMORY: the token authenticates a fresh `/preview` WebSocket
 * upgrade whose `SocketData` starts unauthenticated, so it must be minted over an
 * already-authenticated RPC socket (`system.mintPreviewToken`) and consumed on
 * first use. It is raw entropy — never a PASETO token, never persisted, never
 * logged, and it is passed as a URL query parameter so the RPC password/credential
 * never appears in the dial URL.
 */

/** Time-to-live of a freshly minted preview token, in milliseconds. */
export const PREVIEW_TOKEN_TTL_MS = 30_000;

/** Entropy of the preview token, in bytes (→ 64 hex characters). */
const TOKEN_BYTES = 32;

const liveTokens = new Map<string, number>();

function generateToken(): string {
	const buf = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(buf);
	return Buffer.from(buf).toString("hex");
}

function pruneExpired(now: number): void {
	for (const [token, expiresAt] of liveTokens) {
		if (expiresAt <= now) {
			liveTokens.delete(token);
		}
	}
}

/**
 * Mint a fresh single-use preview token valid for {@link PREVIEW_TOKEN_TTL_MS}.
 * Expired entries are swept opportunistically so an unused token never lingers.
 */
export function mintPreviewToken(now: number = Date.now()): {
	token: string;
	ttlMs: number;
} {
	pruneExpired(now);
	const token = generateToken();
	liveTokens.set(token, now + PREVIEW_TOKEN_TTL_MS);
	return { token, ttlMs: PREVIEW_TOKEN_TTL_MS };
}

/**
 * Validate and CONSUME a preview token. The token is removed on the first lookup
 * regardless of the outcome, so reuse is impossible and an expired-vs-consumed
 * miss is indistinguishable. Returns `true` only for a token that was live and
 * unexpired at the moment of consumption.
 */
export function consumePreviewToken(
	token: string,
	now: number = Date.now(),
): boolean {
	const expiresAt = liveTokens.get(token);
	if (expiresAt === undefined) {
		return false;
	}
	liveTokens.delete(token);
	return expiresAt > now;
}

/** Test seam: clear every outstanding token so a suite starts from empty state. */
export function resetPreviewTokens(): void {
	liveTokens.clear();
}
