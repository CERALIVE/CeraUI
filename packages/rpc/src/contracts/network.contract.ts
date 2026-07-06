/**
 * Network interfaces ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	netifConfigInputSchema,
	netifConfigOutputSchema,
	netifMessageSchema,
	setIngestEnabledInputSchema,
	setIngestEnabledOutputSchema,
} from '../schemas';

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
	 * Enable/disable a LAN RTMP/SRT network-ingest gateway (operator desired state)
	 */
	setIngestEnabled: oc.input(setIngestEnabledInputSchema).output(setIngestEnabledOutputSchema),

	/**
	 * Subscribe to network interface status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/network/status' }),
});
