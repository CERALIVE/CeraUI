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
 * The shapes the two halves of a USB-composition switch share.
 *
 * They live apart from both so the pure-read dispatch and the engine execution
 * can import them without importing each other — the transition is one flow, but
 * a cycle between its halves would make either one impossible to test alone.
 */

import type {
	CertifiedCatalog,
	UsbModeTransitionOutcome,
	UsbModeTransitionRequest,
} from "@ceralive/modem-control";
import type {
	SetUsbModeFailureReason,
	SetUsbModeOutput,
} from "@ceraui/rpc/schemas";

import type { ResolvedModemIdentity } from "./usb-mode-identity.ts";

/**
 * The engine surface this module drives. Structurally `UsbModeTransition` — named
 * separately so a test double never has to construct the real class (which needs
 * five hardware ports) just to prove a gate fired first.
 */
export interface UsbModeTransitionEngine {
	execute(request: UsbModeTransitionRequest): Promise<UsbModeTransitionOutcome>;
}

/** Injectable surface. Defaults read real udev/NM state and resolve NO engine. */
export interface UsbModeDispatchDeps {
	/** Resolve the physical device behind a legacy modem id (a real udev read). */
	resolveIdentity(deviceId: string): Promise<ResolvedModemIdentity | undefined>;
	/** The certified catalog the SKU is matched against. */
	readonly catalog: CertifiedCatalog;
	/** The NM connection uuid carrying this modem, resolved only past the catalog. */
	resolveConnectionId(ifname: string): Promise<string | undefined>;
	/** The MM `Device` UID to inhibit by; cached because the modem disappears. */
	resolveInhibitUid(
		identity: ResolvedModemIdentity,
	): Promise<string | undefined>;
	/** Build the transition engine. `undefined` ⇒ no mutation ports are wired. */
	createEngine(
		identity: ResolvedModemIdentity,
	): UsbModeTransitionEngine | undefined;
	/**
	 * Wait for the re-enumerated device to REGISTER and carry a data path again.
	 *
	 * The engine's postcondition proves the composition mode changed; it does not
	 * prove the link came back. The armed rollback is cancelled only once BOTH
	 * hold, because a modem that switched perfectly and never re-registered is
	 * exactly the state an operator needs the pre-state kept for.
	 */
	confirmDataPath(ifname: string): Promise<boolean>;
	/** ONE immediate re-discovery + `modems` broadcast after a verified success. */
	rediscover(): Promise<void>;
	now(): number;
}

/** A refusal this module produces, in the wire vocabulary of `setUsbMode`. */
export type DispatchRefusal = Extract<
	SetUsbModeOutput["error"],
	| "uncertified"
	| "transition_failed"
	| "streaming_active"
	| "transition_in_progress"
	| "recovery_pending"
	| "mutation_blocked"
	| "device_decommissioned"
	| "rebaseline_required"
>;

/** The dispatch outcome, already in wire shape. */
export type UsbModeDispatchResult =
	| { readonly success: true }
	| {
			readonly success: false;
			readonly error: DispatchRefusal;
			readonly reason?: SetUsbModeFailureReason;
	  };

export function refuse(
	error: DispatchRefusal,
	reason?: SetUsbModeFailureReason,
): UsbModeDispatchResult {
	return reason === undefined
		? { success: false, error }
		: { success: false, error, reason };
}
