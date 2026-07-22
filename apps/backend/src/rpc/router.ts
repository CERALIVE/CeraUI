/**
 * RPC Router - Main router combining all procedures
 */

import { os } from "@orpc/server";

import {
	configureAddonProcedure,
	getAddonStatusProcedure,
	installAddonProcedure,
	listAddonsProcedure,
	uninstallAddonProcedure,
} from "./procedures/addons.procedure.ts";
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
	setUsbModeProcedure,
	unlockSimProcedure,
	unlockSimPukProcedure,
} from "./procedures/modems.procedure.ts";
import {
	configureNetworkInterfaceProcedure,
	getNetworkInterfacesProcedure,
	setNetworkIngestEnabledProcedure,
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
	getEngineProcedure,
	getMockHardwareProcedure,
	getPipelinesProcedure,
	listDevicesProcedure,
	reloadAudioDelayProcedure,
	setBitrateProcedure,
	setConfigProcedure,
	setMockDeviceAttachedProcedure,
	setMockHardwareProcedure,
	setSourceVisibilityProcedure,
	streamHealthProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
	switchAudioProcedure,
	switchInputProcedure,
} from "./procedures/streaming.procedure.ts";
import {
	checkForUpdatesProcedure,
	getCloudProvidersProcedure,
	getLogProcedure,
	getRevisionsProcedure,
	getSensorsProcedure,
	getSyslogProcedure,
	kioskConfigureProcedure,
	kioskOskProcedure,
	kioskStartProcedure,
	kioskStatusProcedure,
	kioskStopProcedure,
	mintPreviewTokenProcedure,
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
	hotspotInfoProcedure,
	hotspotStartProcedure,
	hotspotStopProcedure,
	wifiConnectNewProcedure,
	wifiConnectProcedure,
	wifiDisconnectProcedure,
	wifiForgetProcedure,
	wifiScanProcedure,
} from "./procedures/wifi.procedure.ts";
import type { RPCContext } from "./types.ts";

// Context-typed builder: every procedure is built with `os.$context<RPCContext>()`,
// so the routers that group them must carry the same initial context. A bare
// `os.router()` (initial context `Record<never, never>`) rejects every RPCContext
// procedure as not assignable to `Lazyable<Procedure<Record<never, never>, …>>`.
const base = os.$context<RPCContext>();

const stableRoutes = {
	auth: base.router({
		login: loginProcedure,
		setPassword: setPasswordProcedure,
		logout: logoutProcedure,
	}),

	streaming: base.router({
		start: streamingStartProcedure,
		stop: streamingStopProcedure,
		setBitrate: setBitrateProcedure,
		getPipelines: getPipelinesProcedure,
		getAudioCodecs: getAudioCodecsProcedure,
		getConfig: getConfigProcedure,
		setConfig: setConfigProcedure,
		setSourceVisibility: setSourceVisibilityProcedure,
		streamHealth: streamHealthProcedure,
		getEngine: getEngineProcedure,
		listDevices: listDevicesProcedure,
		switchInput: switchInputProcedure,
		switchAudio: switchAudioProcedure,
		reloadAudioDelay: reloadAudioDelayProcedure,
		// Dev-only mock hardware switcher
		setMockHardware: setMockHardwareProcedure,
		getMockHardware: getMockHardwareProcedure,
		// Dev-only single-device unplug/replug seam (C7)
		setMockDeviceAttached: setMockDeviceAttachedProcedure,
	}),

	modems: base.router({
		getAll: getAllModemsProcedure,
		configure: configureModemProcedure,
		scan: scanModemProcedure,
		unlockSim: unlockSimProcedure,
		unlockSimPuk: unlockSimPukProcedure,
		setUsbMode: setUsbModeProcedure,
	}),

	wifi: base.router({
		getStatus: getWifiStatusProcedure,
		hotspotInfo: hotspotInfoProcedure,
		connect: wifiConnectProcedure,
		disconnect: wifiDisconnectProcedure,
		connectNew: wifiConnectNewProcedure,
		forget: wifiForgetProcedure,
		scan: wifiScanProcedure,
		hotspotStart: hotspotStartProcedure,
		hotspotStop: hotspotStopProcedure,
		hotspotConfigure: hotspotConfigureProcedure,
	}),

	network: base.router({
		getInterfaces: getNetworkInterfacesProcedure,
		configure: configureNetworkInterfaceProcedure,
		setIngestEnabled: setNetworkIngestEnabledProcedure,
	}),

	system: base.router({
		getRevisions: getRevisionsProcedure,
		getSensors: getSensorsProcedure,
		getLog: getLogProcedure,
		getSyslog: getSyslogProcedure,
		poweroff: poweroffProcedure,
		reboot: rebootProcedure,
		startUpdate: startUpdateProcedure,
		checkForUpdates: checkForUpdatesProcedure,
		sshStart: sshStartProcedure,
		sshStop: sshStopProcedure,
		sshResetPassword: sshResetPasswordProcedure,
		getCloudProviders: getCloudProvidersProcedure,
		setRemoteConfig: setRemoteConfigProcedure,
		setAutostart: setAutostartProcedure,
		kioskStatus: kioskStatusProcedure,
		kioskStart: kioskStartProcedure,
		kioskStop: kioskStopProcedure,
		kioskConfigure: kioskConfigureProcedure,
		kioskOsk: kioskOskProcedure,
		mintPreviewToken: mintPreviewTokenProcedure,
	}),

	status: base.router({
		getStatus: getStatusProcedure,
		getRelays: getRelaysProcedure,
	}),

	relay: base.router({
		validate: relayValidateProcedure,
	}),

	notifications: base.router({
		getPersistent: getPersistentNotificationsProcedure,
		dismiss: dismissNotificationProcedure,
	}),

	pairing: base.router({
		generateClaimCode: generateClaimCodeProcedure,
		completePairing: completePairingProcedure,
	}),

	addons: base.router({
		list: listAddonsProcedure,
		install: installAddonProcedure,
		uninstall: uninstallAddonProcedure,
		configure: configureAddonProcedure,
		getStatus: getAddonStatusProcedure,
	}),
};

// HARD-GATED: the `dev` namespace is registered ONLY outside production, so in a
// production build `dev.*` paths resolve to "Unknown procedure path".
export const appRouter = os
	.$context<RPCContext>()
	.router(
		process.env.NODE_ENV !== "production"
			? { ...stableRoutes, dev: base.router({ emit: devEmitProcedure }) }
			: stableRoutes,
	);

export type AppRouter = typeof appRouter;
