/**
 * System ORPC Contract
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	autostartInputSchema,
	logOutputSchema,
	remoteKeyInputSchema,
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
	 * Set remote key for remote management
	 */
	setRemoteKey: oc.input(remoteKeyInputSchema).output(successResponseSchema),

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
