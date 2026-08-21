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
 * The FCC auto-unlock POLICY OF RECORD.
 *
 * It is deliberately NOT in `config.json`. Two consumers read this document and
 * only one of them is CeraUI: `ceralive-fcc-reconcile` — a dependency-free POSIX
 * shell script shipped by `ceralive-modem-support` — parses it at boot, before
 * ModemManager probes a radio, to re-materialize the admin-tier symlink. A shared
 * document with a shell reader has to be its own small file with its own stable
 * shape; folding it into `config.json` would make that script a JSON parser for
 * the whole device configuration.
 *
 * The path is pinned to `/data` because `/etc` rides the rootfs, which is exactly
 * what a RAUC A/B slot swap REPLACES. The symlink is derived; this file is the
 * record. `CERALIVE_FCC_POLICY_PATH` overrides it for tests, mirroring the
 * `CERALIVE_RUN_DIR` seam `kiosk-token.ts` and `sim-secrets.ts` already use.
 *
 * CORRUPTION IS FAIL-SAFE AND THE BYTES ARE KEPT. An unparseable document loads as
 * EMPTY — no model enabled — and is left on disk rather than rewritten. Enabling a
 * regulatory-unlock procedure is not something to infer from a file we could not
 * read, and replacing the evidence would make the next diagnosis impossible. The
 * shell reconciler makes the identical all-or-nothing judgement, so the two halves
 * agree on what a damaged file means.
 */

import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { FCC_UNLOCK_KEY_RE } from "@ceraui/rpc/schemas";

import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";

export const FCC_UNLOCK_SCHEMA_VERSION = 1;

export const FCC_UNLOCK_POLICY_PATH: string =
	process.env.CERALIVE_FCC_POLICY_PATH ??
	"/data/ceralive/fcc-unlock-policy.json";

type PersistedPolicy = {
	schemaVersion: number;
	savedAtMs: number;
	unlock: Record<string, boolean>;
};

/**
 * WHOLE-DOCUMENT validation, never per-key skipping: a half-applied
 * regulatory-unlock policy is a policy nobody wrote.
 */
function parsePolicy(raw: string): Record<string, boolean> | undefined {
	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof doc !== "object" || doc === null) return undefined;
	const record = doc as Record<string, unknown>;
	if (record.schemaVersion !== FCC_UNLOCK_SCHEMA_VERSION) return undefined;
	const unlock = record.unlock;
	if (typeof unlock !== "object" || unlock === null || Array.isArray(unlock)) {
		return undefined;
	}
	const parsed: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(
		unlock as Record<string, unknown>,
	)) {
		if (!FCC_UNLOCK_KEY_RE.test(key) || typeof value !== "boolean") {
			return undefined;
		}
		parsed[key] = value;
	}
	return parsed;
}

export async function loadFccUnlockPolicy(): Promise<Record<string, boolean>> {
	let raw: string;
	try {
		raw = await readFile(FCC_UNLOCK_POLICY_PATH, "utf8");
	} catch {
		// Absent is the state on every device that never opted in, and it is the
		// safe default: nothing enabled.
		return {};
	}
	const parsed = parsePolicy(raw);
	if (parsed === undefined) {
		// Metadata only — the raw document is never logged. It may name hardware,
		// and it is the operator's file, not ours to reprint.
		logger.warn("fcc-unlock: policy is unreadable; treating as empty", {
			module: "modems",
			path: FCC_UNLOCK_POLICY_PATH,
			bytes: Buffer.byteLength(raw, "utf8"),
		});
		return {};
	}
	return parsed;
}

export async function saveFccUnlockPolicy(
	unlock: Record<string, boolean>,
): Promise<void> {
	await mkdir(path.dirname(FCC_UNLOCK_POLICY_PATH), { recursive: true });
	const state: PersistedPolicy = {
		schemaVersion: FCC_UNLOCK_SCHEMA_VERSION,
		savedAtMs: Date.now(),
		unlock,
	};
	// The trailing newline is for the shell reconciler's reader, not decoration.
	writeFileAtomicSync(FCC_UNLOCK_POLICY_PATH, `${JSON.stringify(state)}\n`);
	// chmod AFTER the write (not an open flag) so the mode is 0600 regardless of
	// umask — the same rule `sim-secrets.ts` follows for the same reason.
	await chmod(FCC_UNLOCK_POLICY_PATH, 0o600);
}
