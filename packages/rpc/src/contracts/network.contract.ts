/**
 * Network interfaces ORPC Contract
 */
import { oc } from '@orpc/contract';

import { netifConfigInputSchema, netifConfigOutputSchema, netifMessageSchema } from '../schemas';

export const networkContract = oc.router({
	/**
	 * Get all network interfaces status
	 */
	getInterfaces: oc.output(netifMessageSchema),

	/**
	 * Configure a network interface
	 */
	configure: oc.input(netifConfigInputSchema).output(netifConfigOutputSchema),

	/**
	 * Subscribe to network interface status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/network/status' }),
});
