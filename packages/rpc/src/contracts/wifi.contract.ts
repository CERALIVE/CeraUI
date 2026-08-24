/**
 * WiFi ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	hotspotConfigInputSchema,
	hotspotToggleInputSchema,
	setWifiAdapterModeInputSchema,
	setWifiAdapterModeOutputSchema,
	setWifiCountryInputSchema,
	setWifiCountryOutputSchema,
	successResponseSchema,
	wifiAdapterModeStatusSchema,
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
	 * Set the device regulatory country. Applies `iw reg set` and re-derives the
	 * hotspot channel set from the kernel's post-regdomain answer.
	 */
	setCountry: oc.input(setWifiCountryInputSchema).output(setWifiCountryOutputSchema),

	/**
	 * The observed mode, the persisted preference, and the TOTAL offered set for
	 * every adapter. A pull rather than a field on `getStatus`, so the offered set
	 * and its refusal reasons travel together with the mode they qualify.
	 */
	getAdapterModes: oc.output(wifiAdapterModeStatusSchema),

	/**
	 * Switch one adapter between `station`, `hotspot` and `hybrid`. `accepted`
	 * promises a terminal `wifi` -> `adapter_mode` frame, never that the radio has
	 * already reached the mode.
	 */
	setAdapterMode: oc.input(setWifiAdapterModeInputSchema).output(setWifiAdapterModeOutputSchema),

	/**
	 * Subscribe to WiFi status changes
	 */
	onStatusChange: oc,
});
