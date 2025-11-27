/**
 * Status ORPC Contract (aggregated status subscription)
 */
import { oc } from '@orpc/contract';

import { relayMessageSchema, statusResponseSchema } from '../schemas';

export const statusContract = oc.router({
	/**
	 * Get full application status
	 */
	getStatus: oc.output(statusResponseSchema),

	/**
	 * Get relay accounts and servers
	 */
	getRelays: oc.output(relayMessageSchema.nullable()),

	/**
	 * Subscribe to all status changes (aggregated)
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/status' }),
});
