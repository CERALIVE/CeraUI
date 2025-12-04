/**
 * System Procedures
 * Wraps existing system logic from modules/system/
 */

import { spawnSync } from "node:child_process";
import {
	autostartInputSchema,
	cloudProviderEndpointSchema,
	logOutputSchema,
	remoteConfigInputSchema,
	revisionsSchema,
	sensorsStatusSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import {
	getCloudProviders,
	setRemoteConfig,
} from "../../modules/remote/remote.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { setAutostart } from "../../modules/streaming/streamloop.ts";
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
		spawnSync("poweroff");
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
		spawnSync("reboot");
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
		startStopSsh(context.ws as unknown as import("ws").default, "start_ssh");
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
		startStopSsh(context.ws as unknown as import("ws").default, "stop_ssh");
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
		resetSshPassword(context.ws as unknown as import("ws").default);
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
	.output(successResponseSchema)
	.handler(({ input }) => {
		setAutostart({ autostart: input.autostart });
		return { success: true };
	});
