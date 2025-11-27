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
 * Authentication Compatibility Layer
 *
 * Re-exports from the new RPC system for backward compatibility.
 * New code should import from src/rpc/procedures/auth.procedure.ts directly.
 *
 * @deprecated Use imports from src/rpc/index.ts directly for new code
 */

// Re-export auth socket functions from compat layer
export {
	addAuthedSocket,
	deleteAuthedSocket,
	isAuthedSocket,
} from "../../rpc/compat.ts";
// Re-export password hash functions from new RPC auth procedure
export {
	getPasswordHash,
	setPasswordHash,
} from "../../rpc/procedures/auth.procedure.ts";

// Re-export types
export type AuthMessage = {
	auth: {
		password?: unknown;
		token?: unknown;
		persistent_token: boolean;
	};
};

/**
 * @deprecated Use setPassword procedure from RPC
 */
export function setPassword() {
	// No-op: Handled by RPC procedures
}

/**
 * @deprecated Use tryAuth procedure from RPC
 */
export async function tryAuth() {
	// No-op: Handled by RPC procedures
}

/**
 * @deprecated Use logout procedure from RPC
 */
export function handleLogout() {
	// No-op: Handled by RPC procedures
}

/**
 * Strip passwords from objects for logging
 */
function isRecord(obj: unknown): obj is Record<string, unknown> {
	return obj
		? typeof obj === "object" &&
				!Array.isArray(obj) &&
				Object.getOwnPropertySymbols(obj).length <= 0
		: false;
}

export function stripPasswords(obj: unknown) {
	if (!isRecord(obj)) return obj;

	const copy = { ...obj };
	for (const p in copy) {
		if (p === "password") {
			copy[p] = "<password not logged>";
		} else if (p in copy) {
			copy[p] = stripPasswords(copy[p]);
		}
	}
	return copy;
}
