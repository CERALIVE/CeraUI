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
 * Opt-in SIM PIN secrets store (boot auto-unlock).
 *
 * When the operator opts in to "remember PIN", the confirmed-correct PIN is
 * persisted to a tmpfs secrets file with 0600 permissions so the boot
 * auto-unlock hook (sim-autounlock.ts) can clear a PIN-locked SIM without manual
 * entry. The PIN is a SECRET, so it is deliberately kept OUT of `config.json`
 * (the runtime config schema has no `simPin` field) and lives only here.
 *
 * Why tmpfs and not durable config:
 *   - `/run` is tmpfs on systemd systems — the secret never touches durable
 *     disk and is gone on power-off, matching the kiosk loopback token contract
 *     (`modules/ui/kiosk-token.ts`), the canonical 0600 tmpfs-secret pattern.
 *   - Storing a PIN in `config.json` would back it up, sync it, and expose it to
 *     every config reader; a separate 0600 file scopes the blast radius.
 *
 * Bun-native I/O: content is written with `Bun.write` and read with `Bun.file`.
 * `Bun.write` does not honour a file mode on an existing file, so 0600 is
 * enforced explicitly afterwards via `node:fs/promises` chmod — the same
 * directory/metadata exception kiosk-token.ts already uses (mkdir/chmod/unlink).
 */

import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../helpers/logger.ts";

/** Production tmpfs directory. `/run` is tmpfs on systemd systems — never disk. */
const DEFAULT_RUN_DIR = "/run/ceralive";

/** Secrets file name under the run dir. */
const SIM_PIN_SECRET_FILE = "sim-pin.secret";

/**
 * Resolve the tmpfs directory that holds the SIM PIN secret. Overridable via
 * `CERALIVE_RUN_DIR` (same override kiosk-token.ts honours) so the test suite
 * never writes to the real `/run` and never needs root.
 */
function runDir(): string {
	return process.env.CERALIVE_RUN_DIR ?? DEFAULT_RUN_DIR;
}

/** Absolute path of the SIM PIN secrets file (tmpfs only, never config.json). */
export function simPinSecretPath(): string {
	return path.join(runDir(), SIM_PIN_SECRET_FILE);
}

/**
 * Persist a SIM PIN to the 0600 tmpfs secrets file (opt-in "remember PIN").
 *
 * The directory is created 0700 if absent; the secret is written with no
 * trailing newline and then chmod-ed to 0600. Callers MUST only store a PIN that
 * has been confirmed correct (a successful unlock) — never a candidate the SIM
 * has rejected — so boot auto-unlock never resubmits a known-wrong PIN.
 */
export async function storeSimPin(pin: string): Promise<void> {
	const dir = runDir();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });

	const file = simPinSecretPath();
	// tmpfs only — never durable disk. Bun.write ignores a mode on an existing
	// file, so enforce 0600 explicitly afterwards (mirrors mintKioskToken).
	await Bun.write(file, pin);
	await fs.chmod(file, 0o600);

	logger.info("SIM: stored PIN to secrets file for boot auto-unlock");
}

/**
 * Read the stored SIM PIN, or `null` when nothing is stored (opt-in disabled,
 * never set, or already cleared). A missing/unreadable file and an empty file
 * both collapse to `null` — never throws.
 */
export async function loadSimPin(): Promise<string | null> {
	try {
		const pin = (await Bun.file(simPinSecretPath()).text()).trim();
		return pin.length > 0 ? pin : null;
	} catch {
		// Absent/unreadable → treated as "no stored PIN".
		return null;
	}
}

/**
 * Remove the stored SIM PIN. Idempotent — a missing file is treated as already
 * cleared. Called on opt-out and, critically, after a wrong stored PIN so the
 * next boot cannot resubmit it (SIM-lockout guard).
 */
export async function clearSimPin(): Promise<void> {
	try {
		await fs.unlink(simPinSecretPath());
	} catch {
		// Already gone — nothing to clear.
	}
}
