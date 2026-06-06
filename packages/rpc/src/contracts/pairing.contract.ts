/**
 * Pairing ORPC Contract
 *
 * Device-side claim-code generation surface for the device-pairing-claim-code
 * change. The device produces a short-lived, human-typeable code the user
 * submits on the platform to bind the device to their account.
 */
import { oc } from '@orpc/contract';

import {
	claimCodeOutputSchema,
	completePairingInputSchema,
	completePairingOutputSchema,
} from '../schemas';

export const pairingContract = oc.router({
	/**
	 * Generate (or return the still-valid) device claim-code.
	 *
	 * Time-bounded and cryptographically seeded: the code is stable within its
	 * validity window and deterministically rotates once the window elapses.
	 */
	generateClaimCode: oc.output(claimCodeOutputSchema),

	/**
	 * Complete pairing against the (mock) platform: submit a claim-code, receive
	 * a device token, and store it as the active remote key. Mock-mode only until
	 * the real platform claim endpoint lands.
	 */
	completePairing: oc
		.input(completePairingInputSchema)
		.output(completePairingOutputSchema),
});
