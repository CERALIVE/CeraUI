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
