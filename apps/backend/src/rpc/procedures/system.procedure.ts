/**
 * System Procedures
 * Wraps existing system logic from modules/system/
 */

import {
	autostartInputSchema,
	autostartOutputSchema,
	cloudProviderEndpointSchema,
	KIOSK_UNAVAILABLE_ERROR,
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
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import type WebSocket from "ws";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import {
	getCloudProviders,
	setRemoteConfig,
} from "../../modules/remote/remote.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { setAutostart } from "../../modules/streaming/streamloop.ts";
import {
	getKioskStatus,
	isRealDevice,
	kioskConfigure,
	kioskOsk,
	kioskStart,
	kioskStop,
} from "../../modules/system/kiosk.ts";
import { getRevisions } from "../../modules/system/revisions.ts";
import { getSensors } from "../../modules/system/sensors.ts";
import {
	isUpdating,
	startSoftwareUpdate,
} from "../../modules/system/software-updates.ts";
import { resetSshPassword, startStopSsh } from "../../modules/system/ssh.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get revisions procedure
 */
export const getRevisionsProcedure = authedProcedure
	.output(revisionsSchema)
	.handler(() => {
		return getRevisions();
	});

/**
 * Get sensors procedure
 */
export const getSensorsProcedure = authedProcedure
	.output(sensorsStatusSchema)
	.handler(() => {
		return getSensors();
	});

/**
 * Get application log procedure
 */
export const getLogProcedure = authedProcedure
	.input(logInputSchema)
	.output(logOutputSchema)
	.handler(async () => {
		// getLog sends directly to socket, we need to adapt it
		// For now, return empty - this will be handled via subscription
		return { log: "" };
	});

/**
 * Get system log procedure
 */
export const getSyslogProcedure = authedProcedure
	.output(logOutputSchema)
	.handler(async () => {
		return { log: "" };
	});

/**
 * Power off procedure
 */
export const poweroffProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		logger.info("System: poweroff requested");
		Bun.spawnSync(["poweroff"]);
		return { success: true };
	});

/**
 * Reboot procedure
 */
export const rebootProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		logger.info("System: reboot requested");
		Bun.spawnSync(["reboot"]);
		return { success: true };
	});

/**
 * Start update procedure
 */
export const startUpdateProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		logger.info("System: software update started");
		startSoftwareUpdate();
		return { success: true };
	});

/**
 * Start SSH procedure
 */
export const sshStartProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(({ context }) => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		void startStopSsh(context.ws as unknown as WebSocket, "start_ssh");
		return { success: true };
	});

/**
 * Stop SSH procedure
 */
export const sshStopProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(({ context }) => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		void startStopSsh(context.ws as unknown as WebSocket, "stop_ssh");
		return { success: true };
	});

/**
 * Reset SSH password procedure
 */
export const sshResetPasswordProcedure = authedProcedure
	.output(
		z.object({
			success: z.boolean(),
			password: z.string().optional(),
		}),
	)
	.handler(({ context }) => {
		void resetSshPassword(context.ws as unknown as WebSocket);
		return { success: true };
	});

/**
 * Get available cloud providers
 */
export const getCloudProvidersProcedure = authedProcedure
	.output(
		z.object({
			providers: z.array(cloudProviderEndpointSchema),
			current: cloudProviderEndpointSchema,
		}),
	)
	.handler(() => {
		return getCloudProviders();
	});

/**
 * Set remote configuration (key and provider)
 */
export const setRemoteConfigProcedure = authedProcedure
	.input(remoteConfigInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input }) => {
		await setRemoteConfig({
			remote_key: input.remote_key,
			token: input.token,
			provider: input.provider,
			custom_provider: input.custom_provider,
		});
		return { success: true };
	});

/**
 * Set autostart procedure
 */
export const setAutostartProcedure = authedProcedure
	.input(autostartInputSchema)
	.output(autostartOutputSchema)
	.handler(({ input }) => {
		const autostart = setAutostart(input.autostart);
		return { success: true, applied: { autostart } };
	});

/**
 * Get the live kiosk status (DC-2): persisted toggle + live polled state.
 */
export const kioskStatusProcedure = authedProcedure
	.output(kioskStatusSchema)
	.handler(() => {
		return getKioskStatus();
	});

/**
 * Kiosk toggle-on (T1). Fires unmask + enable --now + polling without blocking;
 * the synchronous prelude lets us return the committed enabled-stopped state.
 */
export const kioskStartProcedure = authedProcedure
	.output(kioskToggleOutputSchema)
	.handler(async () => {
		if (!(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		void kioskStart();
		const status = getKioskStatus();
		return {
			success: true,
			applied: { enabled: status.enabled, state: status.state },
		};
	});

/**
 * Kiosk toggle-off (T3). Stops/disables/masks the unit; returns the committed
 * disabled state synchronously.
 */
export const kioskStopProcedure = authedProcedure
	.output(kioskToggleOutputSchema)
	.handler(async () => {
		if (!(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		void kioskStop();
		const status = getKioskStatus();
		return {
			success: true,
			applied: { enabled: status.enabled, state: status.state },
		};
	});

/**
 * Persist the kiosk display profile (display + touch + motion + performance).
 */
export const kioskConfigureProcedure = authedProcedure
	.input(kioskConfigureInputSchema)
	.output(kioskConfigureOutputSchema)
	.handler(async ({ input }) => {
		if (!(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		const applied = kioskConfigure(input);
		return { success: true, applied };
	});

/**
 * Show/hide the on-device on-screen keyboard (wvkbd) via SIGUSR2/SIGUSR1.
 */
export const kioskOskProcedure = authedProcedure
	.input(kioskOskInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input }) => {
		if (!(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		await kioskOsk(input.visible);
		return { success: true };
	});
