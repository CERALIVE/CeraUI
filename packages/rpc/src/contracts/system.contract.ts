/**
 * System ORPC Contract
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
	allowCellularOnceInputSchema,
	autostartInputSchema,
	autostartOutputSchema,
	cloudProviderEndpointSchema,
	kioskConfigureInputSchema,
	kioskConfigureOutputSchema,
	kioskOskInputSchema,
	kioskStatusSchema,
	kioskToggleOutputSchema,
	logInputSchema,
	logOutputSchema,
	remoteConfigInputSchema,
	revisionsSchema,
	sensorsStatusSchema,
	sshPersistentInputSchema,
	successResponseSchema,
	updateCapabilitiesSchema,
	updateDetailsSchema,
	updateSettingsInputSchema,
	updateSettingsSchema,
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
	getLog: oc.input(logInputSchema).output(logOutputSchema),

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
	getUpdateSettings: oc.output(updateSettingsSchema),
	setUpdateSettings: oc.input(updateSettingsInputSchema).output(updateSettingsSchema),
	getUpdateCapabilities: oc.output(updateCapabilitiesSchema),

	/**
	 * The update orchestrator's operator actions (Todo 36). Both bypass IDLE;
	 * neither bypasses the stream-admission block. A refusal answers
	 * `{success:false, error:<reason>}` and is never a silent no-op.
	 */
	checkUpdatesNow: oc.output(successResponseSchema),
	installUpdatesNow: oc.output(successResponseSchema),
	allowCellularOnce: oc.input(allowCellularOnceInputSchema).output(successResponseSchema),

	/**
	 * The Updates dialog's read of everything the `update_orchestrator` push
	 * does not carry (Todo 41): both RAUC slots, OS versions, check clocks, a
	 * pending cellular approval, and the last update-transport selection.
	 */
	getUpdateDetails: oc.output(updateDetailsSchema),

	/**
	 * Start SSH service
	 */
	sshStart: oc.output(successResponseSchema),

	/**
	 * Stop SSH service
	 */
	sshStop: oc.output(successResponseSchema),

	/**
	 * Set whether the SSH service survives a reboot.
	 *
	 * Deliberately SEPARATE from sshStart/sshStop: persistence and the running
	 * state are two independent axes, so an operator can run SSH for one session
	 * without committing it to boot, or arm it for boot without starting it now.
	 */
	sshSetPersistent: oc.input(sshPersistentInputSchema).output(successResponseSchema),

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
	setAutostart: oc.input(autostartInputSchema).output(autostartOutputSchema),

	/**
	 * Get the live kiosk status (persisted toggle + live polled state — DC-2)
	 */
	kioskStatus: oc.output(kioskStatusSchema),

	/**
	 * Kiosk toggle-on (T1)
	 */
	kioskStart: oc.output(kioskToggleOutputSchema),

	/**
	 * Kiosk toggle-off (T3)
	 */
	kioskStop: oc.output(kioskToggleOutputSchema),

	/**
	 * Persist the kiosk display profile (display + touch + motion + performance)
	 */
	kioskConfigure: oc.input(kioskConfigureInputSchema).output(kioskConfigureOutputSchema),

	/**
	 * Show/hide the on-device on-screen keyboard (wvkbd)
	 */
	kioskOsk: oc.input(kioskOskInputSchema).output(successResponseSchema),

	/**
	 * Subscribe to sensor updates
	 */
	onSensorsChange: oc,

	/**
	 * Subscribe to update progress
	 */
	onUpdateProgress: oc,
});
