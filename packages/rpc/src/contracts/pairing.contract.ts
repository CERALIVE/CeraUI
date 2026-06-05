/**
 * Pairing ORPC Contract
 *
 * Device-side claim-code generation surface for the device-pairing-claim-code
 * change. The device produces a short-lived, human-typeable code the user
 * submits on the platform to bind the device to their account.
 */
import { oc } from '@orpc/contract';

import { claimCodeOutputSchema } from '../schemas';

export const pairingContract = oc.router({
	/**
	 * Generate (or return the still-valid) device claim-code.
	 *
	 * Time-bounded and cryptographically seeded: the code is stable within its
	 * validity window and deterministically rotates once the window elapses.
	 */
	generateClaimCode: oc.output(claimCodeOutputSchema),
});
