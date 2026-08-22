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
  THE THREE CREDENTIAL PROCEDURES, AND WHY THEY ARE NOT `modemProcedure`.

  Every other modem procedure builds from `modemProcedure`, which adds the
  cellular readiness gate. These three build from `authedProcedure` DIRECTLY, and
  that is the whole point rather than an oversight: a router-mode dongle is
  architecturally invisible to ModemManager, and the operator most needs to fix a
  credential exactly while the cellular stack is still initializing — which is
  when `cellularReadyMiddleware` refuses everything. Gating them would make the
  fix unreachable in the state it exists for. They join
  `modems.getCapabilities`/`setCapabilities` as the non-entries in the
  mutation-entrypoint inventory: none takes a lease, none touches a radio.

  All three answer the SAME shape, carrying the RESOLVED lock state rather than
  an echo of the request — and carrying no password, no username, and no
  derivative of either. `modemCredentialsOutputSchema` is a plain `z.object`, so
  a field added upstream by mistake is STRIPPED rather than forwarded.
*/

import {
	type ModemCredentialsOutput,
	modemCredentialsInputSchema,
	modemCredentialsOutputSchema,
	setModemCredentialsInputSchema,
} from "@ceraui/rpc/schemas";
import type { CredentialTarget } from "../../modules/modems/modem-credential-verify.ts";
import {
	resolveCredentialTarget,
	verifyModemCredential,
} from "../../modules/modems/modem-credential-verify.ts";
import {
	clearModemCredential,
	modemCredentialKey,
	projectModemCredential,
	writeModemCredential,
} from "../../modules/modems/modem-credentials.ts";
import {
	forgetLockSession,
	readLockOpenEvidence,
	resolveModemLock,
} from "../../modules/modems/modem-lock-state.ts";
import { broadcastModems } from "../../modules/modems/modem-status.ts";
import { authedProcedure } from "./modems.procedure.ts";

/**
 * The one answer builder. It re-resolves the lock rather than predicting it, so
 * a caller can lock its surface to the device's own current state and never to
 * the outcome of the call it just made.
 */
function answerFor(
	target: CredentialTarget | undefined,
	success: boolean,
	error?: ModemCredentialsOutput["error"],
): ModemCredentialsOutput {
	if (target === undefined) {
		return { success, ...(error !== undefined ? { error } : {}) };
	}
	const resolved = resolveModemLock({
		identityKey: target.device.identityKey,
		openEvidence: readLockOpenEvidence(target.ifname),
		credential: projectModemCredential(target.device),
	});
	return {
		success,
		...(error !== undefined ? { error } : {}),
		lock_state: resolved.state,
		lock_detail: resolved.detail,
	};
}

/**
 * Store a router-WebUI login for one device.
 *
 * It performs ZERO device requests: the open verdict is the one the 30 s admin
 * read cycle already observed, so storing a credential cannot itself spend an
 * attempt against a lockout counter. A device DETECTED as open is refused —
 * writing a secret nothing will ever present is worse than no write at all.
 *
 * A newly stored credential DROPS any session verdict, because the previous
 * `unlocked` or `auth-failed` was about a different secret.
 */
export const setModemCredentialsProcedure = authedProcedure
	.input(setModemCredentialsInputSchema)
	.output(modemCredentialsOutputSchema)
	.handler(({ input }) => {
		const target = resolveCredentialTarget(input.device);
		if (target === undefined) {
			return answerFor(undefined, false, "unknown_device");
		}
		if (modemCredentialKey(target.device) === undefined) {
			return answerFor(target, false, "identity_unresolved");
		}
		if (readLockOpenEvidence(target.ifname) === "open") {
			return answerFor(target, false, "device_open");
		}

		forgetLockSession(target.device.identityKey);
		const stored = writeModemCredential(target.device, {
			username: input.username,
			password: input.password,
		});
		if (!stored) {
			return answerFor(target, false, "identity_unresolved");
		}
		broadcastModems();
		return answerFor(target, true);
	});

/**
 * Forget a device's stored login.
 *
 * Idempotent, and it drops the session verdict with it: a credential that no
 * longer exists cannot keep a row `unlocked`, and leaving one would advertise
 * operations the next request could not authenticate for.
 */
export const clearModemCredentialsProcedure = authedProcedure
	.input(modemCredentialsInputSchema)
	.output(modemCredentialsOutputSchema)
	.handler(({ input }) => {
		const target = resolveCredentialTarget(input.device);
		if (target === undefined) {
			return answerFor(undefined, false, "unknown_device");
		}
		clearModemCredential(target.device);
		forgetLockSession(target.device.identityKey);
		broadcastModems();
		return answerFor(target, true);
	});

/**
 * Present the stored login to the device once.
 *
 * The broadcast is what makes the unlock a CAPABILITY EXPANSION rather than a
 * private fact: the wire build re-resolves every row's lock and, past
 * `gateRouterAdminByLock`, the operations that were withheld while the device
 * was locked are offered through the SAME `modems` surface they always rode.
 */
export const verifyModemCredentialsProcedure = authedProcedure
	.input(modemCredentialsInputSchema)
	.output(modemCredentialsOutputSchema)
	.handler(async ({ input }) => {
		const outcome = await verifyModemCredential(input.device);
		broadcastModems();
		return answerFor(outcome.target, outcome.success, outcome.error);
	});
