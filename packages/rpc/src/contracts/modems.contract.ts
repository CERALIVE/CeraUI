/**
 * Modems ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	modemConfigInputSchema,
	modemListSchema,
	modemScanInputSchema,
	modemScanOutputSchema,
	successResponseSchema,
} from '../schemas';

export const modemsContract = oc.router({
	/**
	 * Get all modems status
	 */
	getAll: oc.output(modemListSchema),

	/**
	 * Configure a modem
	 */
	configure: oc.input(modemConfigInputSchema).output(successResponseSchema),

	/**
	 * Scan for available networks
	 */
	scan: oc.input(modemScanInputSchema).output(modemScanOutputSchema),

	/**
	 * Subscribe to modem status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/modems/status' }),
});
