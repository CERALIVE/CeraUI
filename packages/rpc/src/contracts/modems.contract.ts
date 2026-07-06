/**
 * Modems ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	modemConfigInputSchema,
	modemConfigOutputSchema,
	modemListSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	simPukUnlockInputSchema,
	simPukUnlockOutputSchema,
	simUnlockInputSchema,
	simUnlockOutputSchema,
} from '../schemas';

export const modemsContract = oc.router({
	/**
	 * Get all modems status
	 */
	getAll: oc.output(modemListSchema),

	/**
	 * Configure a modem
	 */
	configure: oc.input(modemConfigInputSchema).output(modemConfigOutputSchema),

	/**
	 * Scan for available networks
	 */
	scan: oc.input(modemScanInputSchema).output(modemScanOutputSchema),

	/**
	 * Submit a SIM PIN to unlock a PIN-locked modem
	 */
	unlockSim: oc.input(simUnlockInputSchema).output(simUnlockOutputSchema),

	/**
	 * Submit a SIM PUK + new PIN to recover a PUK-locked modem
	 */
	unlockSimPuk: oc.input(simPukUnlockInputSchema).output(simPukUnlockOutputSchema),

	/**
	 * Subscribe to modem status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/modems/status' }),
});
