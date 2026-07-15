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
	previewTokenOutputSchema,
	remoteConfigInputSchema,
	revisionsSchema,
	sensorsStatusSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
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
	resolveActiveKioskDeps,
} from "../../modules/system/kiosk.ts";
import { getLog } from "../../modules/system/logs.ts";
import { getRevisions } from "../../modules/system/revisions.ts";
import { getSensors } from "../../modules/system/sensors.ts";
import {
	isUpdating,
	startSoftwareUpdate,
} from "../../modules/system/software-updates.ts";
import { resetSshPassword, startStopSsh } from "../../modules/system/ssh.ts";
import { mintPreviewToken } from "../../modules/ui/preview-token.ts";
import { simulateDevReboot } from "../events.ts";
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
		return revisionsSchema.parse(getRevisions());
	});

/**
 * Get sensors procedure
 */
export const getSensorsProcedure = authedProcedure
	.output(sensorsStatusSchema)
	.handler(() => {
		return sensorsStatusSchema.parse(getSensors());
	});

/**
 * Get application (CeraLive) log procedure.
 *
 * The device log defaults to the `ceralive.service` unit journal; an explicit
 * `service` overrides it. getLog ALSO pushes a `log` event the frontend turns
 * into a file download, and we return the contents so the RPC is a real data
 * source rather than the previous empty stub.
 */
export const getLogProcedure = authedProcedure
	.input(logInputSchema)
	.output(logOutputSchema)
	.handler(async ({ input, context }) => {
		const result = await getLog(
			context.ws,
			input?.service ?? "ceralive.service",
		);
		return { log: result?.contents ?? "" };
	});

/**
 * Get system log procedure — the full boot journal (no unit filter).
 */
export const getSyslogProcedure = authedProcedure
	.output(logOutputSchema)
	.handler(async ({ context }) => {
		const result = await getLog(context.ws);
		return { log: result?.contents ?? "" };
	});

// Host-power runner DI seam (mirrors setKioskDeps): the default issues the real
// Bun.spawnSync([command]) so the production path is unchanged; tests inject a
// spy to assert the spawn without powering off the host.
type PowerCommand = "poweroff" | "reboot";
type PowerCommandRunner = (command: PowerCommand) => void;

const defaultPowerCommandRunner: PowerCommandRunner = (command) => {
	Bun.spawnSync([command]);
};

let powerCommandRunner: PowerCommandRunner = defaultPowerCommandRunner;

export function setPowerCommandRunner(runner: PowerCommandRunner): void {
	powerCommandRunner = runner;
}

export function resetPowerCommandRunner(): void {
	powerCommandRunner = defaultPowerCommandRunner;
}

// Gate on isDevelopment() — NOT isRealDevice(), which is false for an
// unrecognised board and would make a real device silently skip poweroff.
export const poweroffProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => {
		if (isDevelopment()) {
			logger.info("dev: skipping spawn", {
				module: "system.power",
				action: "poweroff",
				dev: true,
			});
			simulateDevReboot(); // close authed sockets → frontend reconnect banner
			return { success: true };
		}
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		logger.info("System: poweroff requested");
		powerCommandRunner("poweroff");
		return { success: true };
	});

export const rebootProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(() => {
		if (isDevelopment()) {
			logger.info("dev: skipping spawn", {
				module: "system.power",
				action: "reboot",
				dev: true,
			});
			simulateDevReboot(); // close authed sockets → frontend reconnect banner
			return { success: true };
		}
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		logger.info("System: reboot requested");
		powerCommandRunner("reboot");
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
	.handler(async ({ context }) => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		const success = await startStopSsh(context.ws, "start_ssh");
		return { success };
	});

/**
 * Stop SSH procedure
 */
export const sshStopProcedure = authedProcedure
	.output(successResponseSchema)
	.handler(async ({ context }) => {
		if (getIsStreaming() || isUpdating()) {
			return { success: false };
		}
		const success = await startStopSsh(context.ws, "stop_ssh");
		return { success };
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
	.handler(async ({ context }) => {
		const password = await resetSshPassword(context.ws);
		return password === undefined
			? { success: false }
			: { success: true, password };
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
			...(input.remote_key !== undefined
				? { remote_key: input.remote_key }
				: {}),
			...(input.token !== undefined ? { token: input.token } : {}),
			provider: input.provider,
			...(input.custom_provider !== undefined
				? { custom_provider: input.custom_provider }
				: {}),
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
 * Kiosk toggle-on (T1). Waits for add-on enablement before returning the
 * committed enabled-stopped state.
 */
export const kioskStartProcedure = authedProcedure
	.output(kioskToggleOutputSchema)
	.handler(async () => {
		if (!shouldUseMocks() && !(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		const status = await kioskStart(resolveActiveKioskDeps());
		return {
			success: true,
			applied: { enabled: status.enabled, state: status.state },
		};
	});

/**
 * Kiosk toggle-off (T3). Waits for the unit/add-on teardown before returning
 * the committed disabled state.
 */
export const kioskStopProcedure = authedProcedure
	.output(kioskToggleOutputSchema)
	.handler(async () => {
		if (!shouldUseMocks() && !(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		const status = await kioskStop(resolveActiveKioskDeps());
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
		if (!shouldUseMocks() && !(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		const applied = kioskConfigure(input, resolveActiveKioskDeps());
		return { success: true, applied };
	});

/**
 * Show/hide the on-device on-screen keyboard (wvkbd) via SIGUSR2/SIGUSR1.
 */
export const kioskOskProcedure = authedProcedure
	.input(kioskOskInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input }) => {
		if (!shouldUseMocks() && !(await isRealDevice())) {
			return { success: false, error: KIOSK_UNAVAILABLE_ERROR };
		}
		await kioskOsk(input.visible, resolveActiveKioskDeps());
		return { success: true };
	});

/**
 * Mint a single-use, short-lived token for the backend `/preview` WebSocket
 * proxy. Authed-only: a fresh preview upgrade starts unauthenticated, so
 * `PreviewCanvas` calls this over its already-authenticated RPC socket and dials
 * `/preview?token=<t>` — the stored password/RPC credential never rides the URL.
 */
export const mintPreviewTokenProcedure = authedProcedure
	.output(previewTokenOutputSchema)
	.handler(() => {
		return mintPreviewToken();
	});
