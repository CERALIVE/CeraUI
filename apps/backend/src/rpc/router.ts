/**
 * RPC Router - Main router combining all procedures
 */

import { os } from "@orpc/server";

import {
	loginProcedure,
	logoutProcedure,
	setPasswordProcedure,
} from "./procedures/auth.procedure.ts";
import { devEmitProcedure } from "./procedures/dev.procedure.ts";
import {
	configureModemProcedure,
	getAllModemsProcedure,
	scanModemProcedure,
	unlockSimProcedure,
} from "./procedures/modems.procedure.ts";
import {
	configureNetworkInterfaceProcedure,
	getNetworkInterfacesProcedure,
} from "./procedures/network.procedure.ts";
import {
	dismissNotificationProcedure,
	getPersistentNotificationsProcedure,
} from "./procedures/notifications.procedure.ts";
import {
	completePairingProcedure,
	generateClaimCodeProcedure,
} from "./procedures/pairing.procedure.ts";
import { relayValidateProcedure } from "./procedures/relay.procedure.ts";
import {
	getRelaysProcedure,
	getStatusProcedure,
} from "./procedures/status.procedure.ts";
import {
	getAudioCodecsProcedure,
	getConfigProcedure,
	getMockHardwareProcedure,
	getPipelinesProcedure,
	setBitrateProcedure,
	setConfigProcedure,
	setMockHardwareProcedure,
	streamHealthProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "./procedures/streaming.procedure.ts";
import {
	getCloudProvidersProcedure,
	getLogProcedure,
	getRevisionsProcedure,
	getSensorsProcedure,
	getSyslogProcedure,
	poweroffProcedure,
	rebootProcedure,
	setAutostartProcedure,
	setRemoteConfigProcedure,
	sshResetPasswordProcedure,
	sshStartProcedure,
	sshStopProcedure,
	startUpdateProcedure,
} from "./procedures/system.procedure.ts";
import {
	getWifiStatusProcedure,
	hotspotConfigureProcedure,
	hotspotStartProcedure,
	hotspotStopProcedure,
	wifiConnectNewProcedure,
	wifiConnectProcedure,
	wifiDisconnectProcedure,
	wifiForgetProcedure,
	wifiScanProcedure,
} from "./procedures/wifi.procedure.ts";
import type { RPCContext } from "./types.ts";

const stableRoutes = {
	auth: os.router({
		login: loginProcedure,
		setPassword: setPasswordProcedure,
		logout: logoutProcedure,
	}),

	streaming: os.router({
		start: streamingStartProcedure,
		stop: streamingStopProcedure,
		setBitrate: setBitrateProcedure,
		getPipelines: getPipelinesProcedure,
		getAudioCodecs: getAudioCodecsProcedure,
		getConfig: getConfigProcedure,
		setConfig: setConfigProcedure,
		streamHealth: streamHealthProcedure,
		// Dev-only mock hardware switcher
		setMockHardware: setMockHardwareProcedure,
		getMockHardware: getMockHardwareProcedure,
	}),

	modems: os.router({
		getAll: getAllModemsProcedure,
		configure: configureModemProcedure,
		scan: scanModemProcedure,
		unlockSim: unlockSimProcedure,
	}),

	wifi: os.router({
		getStatus: getWifiStatusProcedure,
		connect: wifiConnectProcedure,
		disconnect: wifiDisconnectProcedure,
		connectNew: wifiConnectNewProcedure,
		forget: wifiForgetProcedure,
		scan: wifiScanProcedure,
		hotspotStart: hotspotStartProcedure,
		hotspotStop: hotspotStopProcedure,
		hotspotConfigure: hotspotConfigureProcedure,
	}),

	network: os.router({
		getInterfaces: getNetworkInterfacesProcedure,
		configure: configureNetworkInterfaceProcedure,
	}),

	system: os.router({
		getRevisions: getRevisionsProcedure,
		getSensors: getSensorsProcedure,
		getLog: getLogProcedure,
		getSyslog: getSyslogProcedure,
		poweroff: poweroffProcedure,
		reboot: rebootProcedure,
		startUpdate: startUpdateProcedure,
		sshStart: sshStartProcedure,
		sshStop: sshStopProcedure,
		sshResetPassword: sshResetPasswordProcedure,
		getCloudProviders: getCloudProvidersProcedure,
		setRemoteConfig: setRemoteConfigProcedure,
		setAutostart: setAutostartProcedure,
	}),

	status: os.router({
		getStatus: getStatusProcedure,
		getRelays: getRelaysProcedure,
	}),

	relay: os.router({
		validate: relayValidateProcedure,
	}),

	notifications: os.router({
		getPersistent: getPersistentNotificationsProcedure,
		dismiss: dismissNotificationProcedure,
	}),

	pairing: os.router({
		generateClaimCode: generateClaimCodeProcedure,
		completePairing: completePairingProcedure,
	}),
};

// HARD-GATED: the `dev` namespace is registered ONLY outside production, so in a
// production build `dev.*` paths resolve to "Unknown procedure path".
export const appRouter = os
	.$context<RPCContext>()
	.router(
		process.env.NODE_ENV !== "production"
			? { ...stableRoutes, dev: os.router({ emit: devEmitProcedure }) }
			: stableRoutes,
	);

export type AppRouter = typeof appRouter;
