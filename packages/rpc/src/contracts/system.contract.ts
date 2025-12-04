/**
 * System ORPC Contract
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	autostartInputSchema,
	cloudProviderEndpointSchema,
	logOutputSchema,
	remoteConfigInputSchema,
	revisionsSchema,
	sensorsStatusSchema,
	successResponseSchema,
} from '../schemas';

export const systemContract = oc.router({
	/**
	 * Get system revisions/versions
	 */
	getRevisions: oc.output(revisionsSchema),

	/**
	 * Get sensor readings
	 */
	getSensors: oc.output(sensorsStatusSchema),

	/**
	 * Get application log
	 */
	getLog: oc.output(logOutputSchema),

	/**
	 * Get system log
	 */
	getSyslog: oc.output(logOutputSchema),

	/**
	 * Power off the device
	 */
	poweroff: oc.output(successResponseSchema),

	/**
	 * Reboot the device
	 */
	reboot: oc.output(successResponseSchema),

	/**
	 * Start software update
	 */
	startUpdate: oc.output(successResponseSchema),

	/**
	 * Start SSH service
	 */
	sshStart: oc.output(successResponseSchema),

	/**
	 * Stop SSH service
	 */
	sshStop: oc.output(successResponseSchema),

	/**
	 * Reset SSH password
	 */
	sshResetPassword: oc.output(
		z.object({
			success: z.boolean(),
			password: z.string().optional(),
		}),
	),

	/**
	 * Get available cloud providers
	 */
	getCloudProviders: oc.output(
		z.object({
			providers: z.array(cloudProviderEndpointSchema),
			current: cloudProviderEndpointSchema,
		}),
	),

	/**
	 * Set remote configuration (key and provider)
	 */
	setRemoteConfig: oc.input(remoteConfigInputSchema).output(successResponseSchema),

	/**
	 * Set autostart configuration
	 */
	setAutostart: oc.input(autostartInputSchema).output(successResponseSchema),

	/**
	 * Subscribe to sensor updates
	 */
	onSensorsChange: oc.route({ method: 'GET', path: '/system/sensors' }),

	/**
	 * Subscribe to update progress
	 */
	onUpdateProgress: oc.route({ method: 'GET', path: '/system/update' }),
});
