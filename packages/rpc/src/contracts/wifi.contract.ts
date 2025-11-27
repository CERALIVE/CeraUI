/**
 * WiFi ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	hotspotConfigInputSchema,
	hotspotToggleInputSchema,
	successResponseSchema,
	wifiConnectInputSchema,
	wifiDisconnectInputSchema,
	wifiForgetInputSchema,
	wifiNewInputSchema,
	wifiOperationOutputSchema,
	wifiScanInputSchema,
	wifiStatusSchema,
} from '../schemas';

export const wifiContract = oc.router({
	/**
	 * Get WiFi status for all interfaces
	 */
	getStatus: oc.output(wifiStatusSchema),

	/**
	 * Connect to a saved WiFi network
	 */
	connect: oc.input(wifiConnectInputSchema).output(wifiOperationOutputSchema),

	/**
	 * Disconnect from current WiFi network
	 */
	disconnect: oc.input(wifiDisconnectInputSchema).output(wifiOperationOutputSchema),

	/**
	 * Connect to a new WiFi network
	 */
	connectNew: oc.input(wifiNewInputSchema).output(wifiOperationOutputSchema),

	/**
	 * Forget a saved WiFi network
	 */
	forget: oc.input(wifiForgetInputSchema).output(successResponseSchema),

	/**
	 * Scan for available WiFi networks
	 */
	scan: oc.input(wifiScanInputSchema).output(successResponseSchema),

	/**
	 * Start hotspot mode
	 */
	hotspotStart: oc.input(hotspotToggleInputSchema).output(successResponseSchema),

	/**
	 * Stop hotspot mode
	 */
	hotspotStop: oc.input(hotspotToggleInputSchema).output(successResponseSchema),

	/**
	 * Configure hotspot settings
	 */
	hotspotConfigure: oc.input(hotspotConfigInputSchema).output(successResponseSchema),

	/**
	 * Subscribe to WiFi status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/wifi/status' }),
});
