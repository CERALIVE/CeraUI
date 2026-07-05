/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import pkg from "../package.json" with { type: "json" };
import {
	APP_NAME,
	buildBootBanner,
	createBootTimer,
	formatReadyLine,
} from "./helpers/boot-banner.ts";
import { cleanupOrphanedTempFiles } from "./helpers/boot-cleanup.ts";
import { guardNonCritical, runCritical } from "./helpers/boot-guard.ts";
import { checkExecPath } from "./helpers/exec.ts";
import killall from "./helpers/killall.ts";
import { logger } from "./helpers/logger.ts";
import { isDevelopment } from "./mocks/mock-config.ts";
import { initMockService, shouldUseMocks } from "./mocks/mock-service.ts";
import { startMockPreviewServer } from "./mocks/providers/preview.ts";
import {
	buildMockLinkTelemetry,
	getMockActiveEncode,
	getMockAudioDevices,
	getMockEngineCapabilities,
	getMockEngineDevices,
} from "./mocks/providers/streaming.ts";
import { runAddonReconciler } from "./modules/addons/reconciler.ts";
import { getConfig, loadConfig } from "./modules/config.ts";
import { initIdentity } from "./modules/identity/index.ts";
import { initRTMPIngestStats } from "./modules/ingest/rtmp.ts";
import { initSRTIngest } from "./modules/ingest/srt.ts";
import { initModemUpdateLoop } from "./modules/modems/modem-update-loop.ts";
import { UPDATE_GW_INT, updateGwWrapper } from "./modules/network/gateways.ts";
import { createMonitorManager } from "./modules/network/monitor/monitor-manager.ts";
import {
	buildGatewayProbe,
	refreshAndBroadcastNetworkIngest,
	refreshNetworkIngestInfo,
} from "./modules/network/network-ingest.ts";
import {
	handleNetifMonitorEvent,
	initNetworkInterfaceMonitoring,
	updateNetif,
} from "./modules/network/network-interfaces.ts";
import { initRemote } from "./modules/remote/remote.ts";
import { initControlChannel } from "./modules/remote-control/channel.ts";
import { wireSetProfile } from "./modules/remote-control/set-profile-wiring.ts";
import {
	recordTelemetryTick,
	startTelemetryRecorder,
} from "./modules/remote-control/telemetry-recorder.ts";
import { setup } from "./modules/setup.ts";
import { setMockActiveEncodeProvider } from "./modules/streaming/active-encode-status.ts";
import {
	setMockAudioDevicesProvider,
	startAudioDeviceWatcher,
	updateAudioDevices,
} from "./modules/streaming/audio.ts";
import { startBcrpt } from "./modules/streaming/bcrpt.ts";
import { checkCamlinkUsb2 } from "./modules/streaming/camlink.ts";
import { checkEngineCompatibilityOnStartup } from "./modules/streaming/cerastream-backend.ts";
import { reconcilePersistedPipeline } from "./modules/streaming/config-migration.ts";
import { startDeviceDiscovery } from "./modules/streaming/devices.ts";
import { setGatewayProbe } from "./modules/streaming/gateway-availability.ts";
import { broadcastHealthIfChanged } from "./modules/streaming/health.ts";
import {
	broadcastLinkTelemetryIfChanged,
	setMockLinkTelemetryProvider,
} from "./modules/streaming/link-telemetry.ts";
import {
	getPipelineList,
	initPipelines,
} from "./modules/streaming/pipelines.ts";
import { refreshAndBroadcastSources } from "./modules/streaming/sources.ts";
import {
	getStreamingProcesses,
	gracefulShutdown,
} from "./modules/streaming/streamloop/process-runner.ts";
import {
	bcrptExec,
	checkAutoStartStream,
	srtlaSendExec,
} from "./modules/streaming/streamloop.ts";
import { initDeviceStats } from "./modules/system/device-stats.ts";
import { initRevisions } from "./modules/system/revisions.ts";
import { initHardwareMonitoring } from "./modules/system/sensors.ts";
import { periodicCheckForSoftwareUpdates } from "./modules/system/software-updates.ts";
import { getSshStatus } from "./modules/system/ssh.ts";
import { wifiStateInit } from "./modules/wifi/wifi-connections.ts";
import { handleWifiMonitorEvent as handleHotspotMonitorEvent } from "./modules/wifi/wifi-hotspot-monitor.ts";
import { onHeartbeatTick, startHeartbeat } from "./rpc/heartbeat.ts";
import { getServer, initServer } from "./rpc/index.ts";

/* Disable localization for any CLI commands we run */
process.env.LANG = "C.UTF-8";
process.env.LANGUAGE = "C";

/* Make sure apt-get doesn't expect any interactive user input */
process.env.DEBIAN_FRONTEND = "noninteractive";

// Port is unknown until the server binds — omitted here, reported on the ready line.
const bootTimer = createBootTimer();
logger.info(
	buildBootBanner({
		name: APP_NAME,
		version: pkg.version,
		env: process.env.NODE_ENV ?? "production",
		scenario: isDevelopment()
			? process.env.MOCK_SCENARIO || "multi-modem-wifi"
			: null,
		port: null,
	}),
);

/* Initialize mock service in development mode */
if (isDevelopment()) {
	const scenario = process.env.MOCK_SCENARIO || "multi-modem-wifi";
	initMockService(scenario);
	setMockLinkTelemetryProvider(buildMockLinkTelemetry);
	setMockActiveEncodeProvider(getMockActiveEncode);
	setMockAudioDevicesProvider(getMockAudioDevices);
	logger.info(`🎭 Development mode active with scenario: ${scenario}`);
	logger.info(
		"   Available scenarios: single-modem, multi-modem-wifi, streaming-active, caps-full, engine-starting, engine-unavailable",
	);
	logger.info("   Set MOCK_SCENARIO env var to change scenario");
}

checkExecPath(srtlaSendExec);
checkExecPath(bcrptExec);

// CRITICAL boot phase. A failure here is genuinely fatal: the device cannot
// serve correct state without its config, so runCritical() logs loudly and
// re-throws to abort (systemd restarts cleanly) rather than limp along.
await runCritical("config", loadConfig);
logger.info(bootTimer.phase("🔧", "config"));

// Clean up orphaned atomic-write temp files from a prior crash (fail-soft).
// This must run after config load so we know the config dir exists.
cleanupOrphanedTempFiles(process.cwd());

void initRemote();

// CRITICAL: bind the WS control server FIRST — before any non-critical init that
// could fail OR hang. It is the operator's only lifeline to the device, so it
// must come up even when identity, the cloud channel, or the engine never do
// (S6 — a top-level-await failure here previously bricked boot in the field).
await runCritical("ws-control-server", initServer);
const boundPort = Number(getServer()?.url.port) || null;
logger.info(bootTimer.phase("🚀", "server"));

// --- NON-CRITICAL boot phase. Each init is wrapped in guardNonCritical(): a
//     failure is logged, flags the device readiness-reduced (surfaced on
//     /api/health via the boot-readiness rollup), and is swallowed so boot never
//     crashes and the WS server (bound above) stays reachable. ---

// Resolve device_id + paired state before anything that gates the control
// channel (spec §9: it MUST NOT dial until identity is resolved).
await guardNonCritical("identity", initIdentity);
// Second, independent outbound control channel (spec §9): dials the pinned
// device-gateway hub once identity is resolved + paired. Distinct from the BCRPT
// relay socket — its own endpoint, token audience, and lifecycle. Cloud-only, so
// a failure costs remote control but never the local operator UI.
await guardNonCritical("control-channel", initControlChannel);
// Bind the device.setProfile handler to the real config/caps/streaming session
// (the platform pushes the resolved SRT receive profile over the control channel).
wireSetProfile();
// Built from the engine's get-capabilities IPC — the engine may be starting or
// unreachable, so this is the likeliest awaited init to throw/hang. On failure
// the pipeline registry stays empty (stream-start gated) but the UI is reachable.
await guardNonCritical("pipelines", () =>
	initPipelines(
		shouldUseMocks()
			? {
					fetchEngineCapabilities: async () => getMockEngineCapabilities(),
					fetchEngineDevices: async () => getMockEngineDevices(),
				}
			: {},
	),
);

// Migrate persisted config vs the offered set: a `pipeline` the current hardware
// no longer offers is marked unavailable (blocks stream-start) and warned about —
// never silently reset.
reconcilePersistedPipeline(
	getConfig().pipeline,
	Object.keys(getPipelineList()),
);

// Seed the engine-device cache so a later engine outage never empties the
// source list; rides the same broadcast bus as `pipelines`, no new endpoint.
await guardNonCritical("sources", () =>
	refreshAndBroadcastSources(
		shouldUseMocks()
			? { fetchEngineDevices: async () => getMockEngineDevices() }
			: undefined,
	),
);
logger.info(bootTimer.phase("🔌", "pipelines"));

// DEV-ONLY preview WebSocket server: `startMockPreviewServer` gates on
// `shouldUseMocks()`, so it is a hard no-op (no port bind, no listener) in
// production — safe to wire unconditionally.
await guardNonCritical("mock-preview", () => {
	startMockPreviewServer();
});

void initRevisions();
initHardwareMonitoring();
initDeviceStats();
await guardNonCritical("rtmp-ingest", initRTMPIngestStats);
initSRTIngest();
void getSshStatus();
logger.info(bootTimer.phase("🖥️", "hardware"));

void updateGwWrapper();
setInterval(updateGwWrapper, UPDATE_GW_INT);

if (setup.apt_update_enabled) {
	periodicCheckForSoftwareUpdates();
}

initNetworkInterfaceMonitoring();

// Event-driven netif: monitor stream drives up/down; onResync re-polls on restart
const networkMonitor = createMonitorManager(() => updateNetif());
networkMonitor.on("monitor-event", handleNetifMonitorEvent);
networkMonitor.start();

// Event-driven wifi: same monitor drives connection up/down + diff broadcast
wifiStateInit(networkMonitor);

// Hotspot NM-confirmation: flips station↔hotspot once NM reports the switch
networkMonitor.on("monitor-event", handleHotspotMonitorEvent);

// Event-driven modems share the SAME monitor (one nmcli monitor for all)
void initModemUpdateLoop({ monitor: networkMonitor });
logger.info(bootTimer.phase("🌐", "network"));

// check for Cam Links on USB2 at startup
void checkCamlinkUsb2();

void updateAudioDevices();
// Live device list: inotify on the sound dir (+ debounce), polling fallback only
// while streaming. The SIGUSR2 udev hook below stays as a belt-and-suspenders path.
startAudioDeviceWatcher(() => getStreamingProcesses().length > 0);
// Hotplug input discovery (Task 34): v4l2 + unified audio scan, broadcasts the
// `devices` payload that feeds the cerastream picker + live switch-input RPC.
startDeviceDiscovery();
void startBcrpt();
logger.info(bootTimer.phase("🎵", "audio & devices"));

// Don't autostart when restarting CeraLive after a software update or after a crash

/*
  We use an UDEV rule to send a SIGUSR2 when:
   * an Elgato USB device is plugged in or out
   * a USB audio card is plugged in or out
*/
process.on("SIGUSR2", function udevDeviceUpdate() {
	logger.error("SIGUSR2");
	void checkCamlinkUsb2();
	void updateAudioDevices();
});

// make sure we didn't inherit orphan processes (cerastream is systemd-owned and
// never spawned by CeraUI, so only srtla_send needs the orphan sweep)
void killall(["srtla_send"]);

// Server→client heartbeat: periodic app-level ping for half-open detection
startHeartbeat();

// Stream health rollup: broadcast on the same 5s tick, only on state change
onHeartbeatTick(broadcastHealthIfChanged);

// srtla link telemetry: fold into the status flow on the same tick, on-change
onHeartbeatTick(broadcastLinkTelemetryIfChanged);

// Network-ingest gateway status (Todo 16): probe the rtmp/srt ingest gateways on
// the heartbeat cadence and fold the result into the `status` flow on change. The
// cached snapshot also backs the streaming.start GatewayProbe (Todo 17 seam) — a
// synchronous read updated asynchronously here, so the gate never blocks on a
// systemctl spawn. Seed the cache once, then keep it fresh on each tick.
void refreshNetworkIngestInfo();
setGatewayProbe(buildGatewayProbe());
onHeartbeatTick(() => {
	void refreshAndBroadcastNetworkIngest();
});

// Telemetry recorder (spec §8.1): batch per-link samples and emit `telemetry`
// status frames to the hub for durable persistence. Non-blocking — each tick is
// synchronous and exception-safe, so it never stalls the heartbeat/live loop.
startTelemetryRecorder();
onHeartbeatTick(recordTelemetryTick);

void checkAutoStartStream();

// Engine protocol-compatibility probe (T-skew): fire-and-forget. A protocol-major
// mismatch (e.g. a newer engine .deb against older baked-in bindings) raises a
// persistent notification rather than failing silently at first stream. Never
// gates boot — failures are handled inside the call.
void checkEngineCompatibilityOnStartup();

// Post-boot add-on reconciler (T29): fire-and-forget. Add-ons NEVER gate boot or
// the OS-update healthcheck/rollback, so this is a non-blocking background task
// whose failures are swallowed inside runAddonReconciler(). The
// ceralive-addon-reconciler.service oneshot re-triggers a pass via SIGUSR1; the
// run self-serialises, so the boot fire and the signal can both fire harmlessly.
void runAddonReconciler();
process.on("SIGUSR1", function reconcileAddons() {
	void runAddonReconciler();
});

// Graceful shutdown: drain streaming subprocesses (SIGTERM → SIGKILL after the
// grace window) before exit so no orphaned srtla_send survives. Guarded so a
// second signal mid-drain is ignored.
let shuttingDown = false;
function handleTerminationSignal(signal: NodeJS.Signals): void {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info(`received ${signal}; shutting down streaming processes`);
	void gracefulShutdown().then(() => {
		process.exit(0);
	});
}
process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

logger.info(bootTimer.phase("▶️", "autostart & reconciler"));

logger.info(formatReadyLine(bootTimer.elapsedMs(), boundPort));
