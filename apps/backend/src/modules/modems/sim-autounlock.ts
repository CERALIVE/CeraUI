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

  DECISION: this hook is PIN1-ONLY, and PIN2 is deliberately out of scope.

  The hook exists because an unverified PIN1 makes a modem useless — it cannot
  register, so the link it was going to contribute to the bond simply is not
  there, and an operator who reboots before going live has no way to know until
  the stream fails. PIN2 is not that. It gates the Fixed-Dialling-Number list
  and some call-cost settings; ModemManager's own state machine exempts it from
  LOCKED because "the device is operational without it", so a PIN2-locked modem
  registers, connects and bonds exactly like an unlocked one. There is no
  boot-time failure for a PIN2 auto-unlock to prevent.

  Against that zero benefit sits real cost. Auto-submitting PIN2 would mean
  persisting a SECOND credential to the tmpfs secrets store, and spending one of
  only ~3 PIN2 attempts unattended on every boot — where the recovery from
  exhaustion is a PUK2 that operators very often do not have, since carriers
  print it far less prominently than PUK1. The PIN1 hook can justify that
  exposure by restoring service; a PIN2 hook would be risking an irreversible
  lockout to enable a feature nothing on this device uses.

  So PIN2 is operator-initiated only, through the `modems.unlockSimPin2` RPC.
  If FDN ever becomes something CeraUI actually drives, revisit this — but
  revisit the PUK2-exhaustion risk with it, not just the plumbing.

  WHY THIS HOOK HAS TO EXIST AT ALL: an unlock DOES NOT PERSIST (todo 46).

  `Sim.SendPin` is a verification transaction against the UICC, not a setting.
  The unlocked state is SIM security state, so it is re-applied the moment the
  card is re-initialised after a power cycle, and ModemManager caches nothing to
  replay — its generic implementation formats the PIN into `AT+CPIN`, submits it,
  and frees the string with the request context (`src/mm-base-sim.c`). There is
  no daemon-wide PIN cache to survive an MM restart, so nothing in the stack
  remembers a successful unlock. That is precisely the gap this hook fills, and
  it is why the answer to "can the device just remember it" is a stored secret
  plus a boot-time resubmit rather than a flag someone forgot to set.

  The ONE mechanism that genuinely persists is `Sim.EnablePin(pin, false)`,
  which turns the card's own PIN-verification facility off (generic backend:
  `AT+CLCK="SC",0,"PIN"`) and survives power cycles because it changes the SIM,
  not the session. CeraUI deliberately does not call it: disabling the SIM lock
  outright is the operator's security decision to make on their own phone, not a
  side effect of using a streaming encoder.

  AND IT HAS NO PIN2 EQUIVALENT. `EnablePin` takes no PIN-kind argument and every
  protocol backend hardcodes PIN1 (`mm-sim-qmi.c` selects `PIN1` explicitly), so
  a PIN2 lock cannot be persistently cleared through ModemManager at all — it
  returns on every boot for as long as FDN stays enabled on the card. That makes
  the case against a PIN2 boot hook stronger, not weaker: the recurrence is
  permanent, so an unattended resubmit would spend one of ~3 attempts on EVERY
  boot, forever, to clear something that blocks nothing.

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
