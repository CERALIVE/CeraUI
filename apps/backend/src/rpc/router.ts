/**
 * RPC Router - Main router combining all procedures
 */

import { os } from "@orpc/server";

import {
	loginProcedure,
	logoutProcedure,
	setPasswordProcedure,
} from "./procedures/auth.procedure.ts";
import {
	configureModemProcedure,
	getAllModemsProcedure,
	scanModemProcedure,
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
	getRelaysProcedure,
	getStatusProcedure,
} from "./procedures/status.procedure.ts";
import {
	getAudioCodecsProcedure,
	getConfigProcedure,
	getPipelinesProcedure,
	setBitrateProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "./procedures/streaming.procedure.ts";
import {
	getLogProcedure,
	getRevisionsProcedure,
	getSensorsProcedure,
	getSyslogProcedure,
	poweroffProcedure,
	rebootProcedure,
	setAutostartProcedure,
	setRemoteKeyProcedure,
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

/**
 * Application router implementing the contract
 */
export const appRouter = os.$context<RPCContext>().router({
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
	}),

	modems: os.router({
		getAll: getAllModemsProcedure,
		configure: configureModemProcedure,
		scan: scanModemProcedure,
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
		setRemoteKey: setRemoteKeyProcedure,
		setAutostart: setAutostartProcedure,
	}),

	status: os.router({
		getStatus: getStatusProcedure,
		getRelays: getRelaysProcedure,
	}),

	notifications: os.router({
		getPersistent: getPersistentNotificationsProcedure,
		dismiss: dismissNotificationProcedure,
	}),
});

export type AppRouter = typeof appRouter;
