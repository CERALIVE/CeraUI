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
  Boot SIM PIN auto-unlock hook.

  On boot, after the modem presence loop has discovered the modems and built each
  modem's `sim_lock`, this hook clears a PIN-locked SIM using the opt-in PIN
  stored by sim-secrets.ts — so a remembered SIM comes up without manual entry.

  Three invariants this module exists to enforce:

   1. BOUNDED. The PIN is submitted AT MOST ONCE per locked modem (the single
      submit itself is guaranteed by `unlockSimPin` in mmcli.ts). On the first
      non-success we STOP — we never walk a wrong PIN toward an irreversible PUK
      lockout, and we never loop.

   2. SELF-HEALING. A wrong/unusable stored PIN is CLEARED, so the next boot
      cannot resubmit it. The modem is then left for manual entry via the unlock
      RPC (the user re-enters and may opt to remember again).

   3. EMULATION-SAFE. Gated on `isRealDevice()` exactly like the kiosk/add-on
      boot actions — a dev/CI host never drives mmcli.

  Everything effectful (the real-device probe, the secrets store, the modem-state
  read, the actual unlock, and the post-unlock re-discovery) is injected through
  {@link SimAutoUnlockDeps} so the bounded/clear behaviour is unit-testable
  without hardware or files. The default `onUnlocked` re-discovers via a lazy
  dynamic import to avoid a static import cycle with modem-update-loop.ts.
*/

import { logger } from "../../helpers/logger.ts";
import { withModemUpdateLock } from "../network/state/device-lock.ts";
import { isRealDevice } from "../system/device-detection.ts";

import { type SimUnlockResult, unlockSimPin } from "./mmcli.ts";
import { getModem, getModemIds } from "./modems-state.ts";
import { clearSimPin, loadSimPin } from "./sim-secrets.ts";

/** A modem that ModemManager currently reports as SIM-PIN locked. */
export type LockedModem = {
	/** Numeric ModemManager id. */
	id: number;
	/** mmcli `-m` argument (the bare numeric index — accepted by MODEM_PATH_RE). */
	path: string;
};

/**
 * Injectable surface for the boot auto-unlock. Defaults wire the real OS probe,
 * the tmpfs secrets store, the live modem state, the serialized mmcli unlock and
 * a post-unlock re-discovery. Tests inject deterministic stand-ins.
 */
export type SimAutoUnlockDeps = {
	/** Real-device gate — boot actions never run on a dev/emulated host. */
	isRealDevice: () => Promise<boolean>;
	/** Read the opt-in stored PIN, or null when nothing is remembered. */
	loadSimPin: () => Promise<string | null>;
	/** Clear the stored PIN (after a wrong/unusable one — SIM-lockout guard). */
	clearSimPin: () => Promise<void>;
	/** Enumerate the currently SIM-PIN-locked modems from live state. */
	getLockedModems: () => Array<LockedModem>;
	/** Submit the PIN once (serialized against the modem update loop). */
	unlock: (modemPath: string, pin: string) => Promise<SimUnlockResult>;
	/** Re-discover after a successful unlock so the modem registers/connects. */
	onUnlocked: () => Promise<void>;
};

/**
 * Scan live modem state for SIM-PIN-locked modems. Only `sim-pin` qualifies:
 * `sim-puk`/`sim-puk2` cannot be cleared with a PIN, and `none`/`unknown` are
 * not blocking. The mmcli arg is the bare numeric id (accepted by MODEM_PATH_RE).
 */
export function findPinLockedModems(): Array<LockedModem> {
	const locked: Array<LockedModem> = [];
	for (const id of getModemIds()) {
		if (getModem(id)?.sim_lock?.required === "sim-pin") {
			locked.push({ id, path: String(id) });
		}
	}
	return locked;
}

/** Submit the PIN once, serialized against the modem update loop. */
async function unlockUnderLock(
	modemPath: string,
	pin: string,
): Promise<SimUnlockResult> {
	let result: SimUnlockResult = { state: "error" };
	await withModemUpdateLock(async () => {
		result = await unlockSimPin(modemPath, pin);
	});
	return result;
}

export const defaultSimAutoUnlockDeps: SimAutoUnlockDeps = {
	isRealDevice: () => isRealDevice(),
	loadSimPin,
	clearSimPin,
	getLockedModems: findPinLockedModems,
	unlock: unlockUnderLock,
	onUnlocked: async () => {
		// Lazy import breaks the static cycle with modem-update-loop.ts (which
		// imports this module to call the hook at boot).
		const { discoverModems } = await import("./modem-update-loop.ts");
		await discoverModems();
	},
};

/**
 * Boot hook: unlock SIM-PIN-locked modems from the stored opt-in PIN, ONCE.
 *
 * Returns silently (no-op) when: not a real device, no PIN is stored, or no
 * modem is SIM-PIN locked. Otherwise it attempts each locked modem in turn and
 * STOPS at the first failure — clearing the stored PIN so it is never resubmitted
 * — which is the bounded, no-loop contract. A successful unlock triggers one
 * re-discovery so the now-unlocked modem registers its connection.
 */
export async function maybeAutoUnlockSimPins(
	deps: SimAutoUnlockDeps = defaultSimAutoUnlockDeps,
): Promise<void> {
	// Boot-action gate: never drive mmcli from a dev/emulated host.
	if (!(await deps.isRealDevice())) {
		return;
	}

	const pin = await deps.loadSimPin();
	if (pin === null) {
		// Opt-in not enabled / nothing remembered — nothing to do.
		return;
	}

	const locked = deps.getLockedModems();
	if (locked.length === 0) {
		return;
	}

	let anyUnlocked = false;
	for (const modem of locked) {
		const result = await deps.unlock(modem.path, pin);

		if (result.state === "success") {
			logger.info(`SIM PIN auto-unlock: modem ${modem.id} unlocked`);
			anyUnlocked = true;
			continue;
		}

		if (result.state === "no-locked-modem") {
			// Raced to unlocked between the state read and the submit — nothing to
			// unlock here and no PIN was rejected, so keep the stored PIN.
			continue;
		}

		// wrong-pin | puk-required | error: do NOT retry. A definitively wrong or
		// unusable stored PIN is cleared so the next boot can't resubmit it
		// (SIM-lockout guard); the modem surfaces for manual entry via the unlock
		// RPC. Stop after this first failure: the stored PIN is shared, so it would
		// fail for the remaining locked modems too.
		logger.warn(
			`SIM PIN auto-unlock: modem ${modem.id} not unlocked (${result.state}); clearing stored PIN — manual entry required`,
		);
		await deps.clearSimPin();
		break;
	}

	if (anyUnlocked) {
		// A freshly unlocked SIM is now registrable — re-discover so it picks up
		// its NM connection. Runs after the unlock lock has been released (the
		// modem update lock is non-reentrant), so this acquires it cleanly.
		await deps.onUnlocked();
	}
}
