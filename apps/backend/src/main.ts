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
import { handleTerminationSignal } from "./helpers/shutdown.ts";
import { isDevelopment } from "./mocks/mock-config.ts";
import {
	initMockService,
	setMockEncoderConfig,
	shouldUseMocks,
} from "./mocks/mock-service.ts";
import { getMockDbusModemViews } from "./mocks/providers/cellular.ts";
import { startMockPreviewServer } from "./mocks/providers/preview.ts";
import {
	buildMockLinkTelemetry,
	getMockActiveEncode,
	getMockAudioDevices,
	getMockEngineCapabilities,
	getMockEngineDevices,
	getMockPreviewEncoderRealized,
} from "./mocks/providers/streaming.ts";
import { runAddonReconciler } from "./modules/addons/reconciler.ts";
import { initBluetooth } from "./modules/bluetooth/bluetooth-runtime.ts";
import { initCellularStack } from "./modules/cellular/cellular-stack.ts";
import { startModemShadowIfEnabled } from "./modules/cellular/shadow.ts";
import { initUdevProvisionalMonitor } from "./modules/cellular/udev-monitor.ts";
import { getConfig, loadConfig } from "./modules/config.ts";
import { initIdentity } from "./modules/identity/index.ts";
import { initRTMPIngestStats } from "./modules/ingest/rtmp.ts";
import { initSRTIngest, stopSRTIngest } from "./modules/ingest/srt.ts";
import { initFccUnlockModule } from "./modules/modems/fcc-unlock.ts";
import { initModemCredentials } from "./modules/modems/modem-credentials.ts";
import { initModemUpdateLoop } from "./modules/modems/modem-update-loop.ts";
import { setMockDbusModemViews } from "./modules/modems/modem-wire-producer.ts";
import { initMutationRecovery } from "./modules/modems/mutation-replay.ts";
import { reconcileEthernetRoles } from "./modules/network/ethernet-role-transition.ts";
import { UPDATE_GW_INT, updateGwWrapper } from "./modules/network/gateways.ts";
import { createMonitorManager } from "./modules/network/monitor/monitor-manager.ts";
import {
	buildGatewayProbe,
	refreshAndBroadcastNetworkIngest,
	refreshNetworkIngestInfo,
} from "./modules/network/network-ingest.ts";
import { reconcileIngestDesiredState } from "./modules/network/network-ingest-control.ts";
import {
	handleNetifMonitorEvent,
	initNetworkInterfaceMonitoring,
	updateNetif,
} from "./modules/network/network-interfaces.ts";
import { initSharingDiag } from "./modules/network/sharing-diag/runtime.ts";
import { initUplinkHealth } from "./modules/network/uplink-health/runtime.ts";
import {
	initUplinkShaper,
	stopUplinkShaper,
	tickUplinkShaper,
} from "./modules/network/uplink-shaper/runtime.ts";
import { initUplinkSteering } from "./modules/network/uplink-steering/runtime.ts";
import { initRemote } from "./modules/remote/remote.ts";
import { wireActiveProfileReporter } from "./modules/remote-control/active-profile-wiring.ts";
import { initControlChannel } from "./modules/remote-control/channel.ts";
import { wireSetProfile } from "./modules/remote-control/set-profile-wiring.ts";
import {
	recordTelemetryTick,
	startTelemetryRecorder,
} from "./modules/remote-control/telemetry-recorder.ts";
import { setup } from "./modules/setup.ts";
import { setMockActiveEncodeProvider } from "./modules/streaming/active-encode-status.ts";
import { startActivePassthroughBridge } from "./modules/streaming/active-passthrough.ts";
import {
	setMockAudioDevicesProvider,
	startAudioDeviceWatcher,
	updateAudioDevices,
} from "./modules/streaming/audio.ts";
import { initAudioMeterBridge } from "./modules/streaming/audio-meter-bridge.ts";
import { checkCamlinkUsb2 } from "./modules/streaming/camlink.ts";
import { checkEngineCompatibilityOnStartup } from "./modules/streaming/cerastream-backend.ts";
import { runInflightConfigChangeReconciliation } from "./modules/streaming/config-change-reconcile-wiring.ts";
import { reconcilePersistedPipeline } from "./modules/streaming/config-migration.ts";
import { startDeviceDiscovery } from "./modules/streaming/devices.ts";
import { initEngineConnection } from "./modules/streaming/engine-reconnect.ts";
import { setGatewayProbe } from "./modules/streaming/gateway-availability.ts";
import { broadcastHealthIfChanged } from "./modules/streaming/health.ts";
import {
	broadcastLinkTelemetryIfChanged,
	setMockLinkTelemetryProvider,
} from "./modules/streaming/link-telemetry.ts";
import { getPipelineList } from "./modules/streaming/pipelines.ts";
import { setMockPreviewEncoderRealizedProvider } from "./modules/streaming/preview-encoder-status.ts";
import { beginRecoveryBarrier } from "./modules/streaming/recovery-barrier.ts";
import { refreshAndBroadcastSources } from "./modules/streaming/sources.ts";
import { runStreamRestoration } from "./modules/streaming/stream-restoration.ts";
import { reconcileStreamSession } from "./modules/streaming/stream-session-orchestrator.ts";
import {
	getStreamingProcesses,
	gracefulShutdown,
} from "./modules/streaming/streamloop/process-runner.ts";
import {
	checkAutoStartStream,
	srtlaSendExec,
} from "./modules/streaming/streamloop.ts";
import { initCpu } from "./modules/system/cpu.ts";
import {
	detectHardwareKindFromDeviceTree,
	isRealDevice,
	warnOnHardwareIdentityDrift,
} from "./modules/system/device-detection.ts";
import { initDeviceStats } from "./modules/system/device-stats.ts";
import { initEncoderLoad } from "./modules/system/encoder-load.ts";
import { initFan } from "./modules/system/fan.ts";
import { getHardwareKind } from "./modules/system/hardware-kind.ts";
import { initRevisions } from "./modules/system/revisions.ts";
import {
	initHardwareMonitoring,
	stopDmesgWatchers,
} from "./modules/system/sensors.ts";
import {
	periodicCheckForSoftwareUpdates,
	recoverSoftwareUpdateIfRunning,
} from "./modules/system/software-updates.ts";
import {
	ensureSshPasswordProvisioned,
	ensureSshPasswordSynced,
	getSshStatus,
} from "./modules/system/ssh.ts";
import { initHotspotCredentials } from "./modules/wifi/hotspot-credentials.ts";
import { applyPersistedCountry } from "./modules/wifi/regdomain.ts";
import { reconcileWifiAdapterModes } from "./modules/wifi/wifi-adapter-mode-transition.ts";
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
	setMockPreviewEncoderRealizedProvider(getMockPreviewEncoderRealized);
	setMockAudioDevicesProvider(getMockAudioDevices);
	setMockDbusModemViews(getMockDbusModemViews);
	logger.info(`🎭 Development mode active with scenario: ${scenario}`);
	logger.info(
		"   Available scenarios: single-modem, multi-modem-wifi, streaming-active, caps-full, engine-starting, engine-unavailable",
	);
	logger.info("   Set MOCK_SCENARIO env var to change scenario");
}

checkExecPath(srtlaSendExec);

// CRITICAL boot phase. A failure here is genuinely fatal: the device cannot
// serve correct state without its config, so runCritical() logs loudly and
// re-throws to abort (systemd restarts cleanly) rather than limp along.
await runCritical("config", loadConfig);
logger.info(bootTimer.phase("🔧", "config"));

// initMockService() seeds mockEncoderConfig (which getConfig() overlays over the
// persisted config in mock mode) BEFORE loadConfig() runs, so its hardcoded default
// `pipeline` shadows a config.json that already persisted one — getConfig() would
// then report a stale pipeline on boot, and re-selecting the already-selected source
// is a frontend no-op so it never self-corrects. Re-seed from the loaded config.
if (shouldUseMocks()) {
	const persistedPipeline = getConfig().pipeline;
	if (persistedPipeline !== undefined) {
		setMockEncoderConfig({ pipeline: persistedPipeline });
	}
}

// Raise the modem-mutation admission barrier BEFORE the WS server binds. The
// server is the operator's lifeline and comes up first by design, so an RPC can
// arrive while the journal is still being replayed — and until it has been, the
// device cannot say whether a modem is mid-rollback. Internal boot origins await
// this promise; external arrivals get the typed `recovery_pending` refusal.
beginRecoveryBarrier();

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
await guardNonCritical("hotspot-credentials", initHotspotCredentials);

// Apply the persisted regulatory country BEFORE the WiFi device scan, so the
// first hotspot channel derivation already reflects the operator's domain
// rather than the world default the kernel boots with.
await guardNonCritical("wifi-regdomain", async () => {
	if (!(await isRealDevice())) return;
	await applyPersistedCountry(getConfig().country);
});

await guardNonCritical("identity", async () => {
	await initIdentity();
});
// Second, independent outbound control channel (spec §9): dials the pinned
// device-gateway hub once identity is resolved + paired. Distinct from the BCRPT
// relay socket — its own endpoint, token audience, and lifecycle. Cloud-only, so
// a failure costs remote control but never the local operator UI.
await guardNonCritical("control-channel", initControlChannel);
// Bind the device.setProfile handler to the real config/caps/streaming session
// (the platform pushes the resolved SRT receive profile over the control channel).
wireSetProfile();
// Bind the active-profile reporter to the persisted config + broadcast path, so
// the device reports its EFFECTIVE SRT profile up the control channel (cloud
// Todo 15) — the source the platform's drift detection compares against.
wireActiveProfileReporter();
// Built from the engine's get-capabilities IPC — the engine may be starting or
// unreachable, so this is the likeliest awaited init to throw/hang. On failure
// the pipeline registry stays empty (stream-start gated) but the UI is reachable.
// initEngineConnection runs the first attempt then, if the engine is not yet
// reachable, arms a bounded backoff→periodic recheck that re-broadcasts
// capabilities/pipelines/sources once cerastream comes up — so a systemd-ordering
// race or slow engine start self-heals without an operator restart.
await guardNonCritical("pipelines", () =>
	initEngineConnection(
		shouldUseMocks()
			? {
					capabilities: {
						fetchEngineCapabilities: async () => getMockEngineCapabilities(),
						fetchEngineDevices: async () => getMockEngineDevices(),
					},
					sources: { fetchEngineDevices: async () => getMockEngineDevices() },
				}
			: {},
	),
);
if (!shouldUseMocks()) {
	await guardNonCritical("stream-session-reconcile", async () => {
		await reconcileStreamSession();
	});
	// The first point at which the persisted config and the engine's own session
	// are both known — so it is where a `config.inflight.json` left by a process
	// that died mid transaction can finally be judged. Fire-and-forget: with a
	// marker it polls a bounded window for the decisive engine answer (the raw
	// active_encode bridge started further down supplies the frame evidence a
	// second or two from now), and that must not delay the rest of boot.
	void runInflightConfigChangeReconciliation();
	// The backend-restart half of restoration. `reconcileStreamSession()` above
	// has already adopted an engine session that outlived this process, so the
	// run sees `streaming` and correctly declines — a backend-only restart can
	// never produce a second session.
	void runStreamRestoration();
}

// Resolve the runtime hardware kind (engine → device-tree → setup.hw → generic)
// and seed the cache BEFORE the sensor/audio/pipeline consumers read it, so
// getHardwareKindCached() surfaces the live-detected board rather than the static
// setup.hw. A boot with cerastream not-yet-up resolves the device-tree/setup.hw
// tier; the engine-reconnect heal re-resolves once cerastream comes up.
await guardNonCritical("hardware-kind", async () => {
	await getHardwareKind();
});

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
// Always-on audio-level bridge: one long-lived subscription to the engine's
// `audio-level` topic, re-broadcast over the main authed WS so the LiveView meter
// moves while idle with no preview open (device-quality-wave2 Todo 22). Skipped
// under mocks (no real engine socket); fire-and-forget, never blocks boot.
if (!shouldUseMocks()) {
	await guardNonCritical("audio-meter", async () => {
		initAudioMeterBridge();
	});
}
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
initCpu();
await guardNonCritical("encoder-load", initEncoderLoad);
await guardNonCritical("fan", initFan);
await guardNonCritical("rtmp-ingest", initRTMPIngestStats);
await guardNonCritical("srt-ingest", initSRTIngest);
// Raw passthrough event bridge: the typed cerastream binding strips
// active_encode.passthrough, so a persistent raw subscription reads it for the
// live "Passthrough active" surfacing. Fail-soft (bounded-backoff self-heal).
await guardNonCritical("passthrough-bridge", async () => {
	startActivePassthroughBridge();
});
// Provision an initial SSH password on a device that has never had one BEFORE
// the sync/probe below run — SSH is enabled-by-default at the OS level but a
// password was only ever minted on an explicit operator action, leaving a fresh
// device's account unreachable. Runs unconditionally so a password is ready the
// instant SSH is enabled. Fail-soft; a clean no-op once one is persisted.
await guardNonCritical("ssh-password-provision", ensureSshPasswordProvisioned);
// Reconcile the OS-level SSH password against the /data-persisted one BEFORE the
// status probe below reads /etc/shadow: /etc/shadow is rootfs-local and does NOT
// survive an A/B OTA slot swap, so a fresh slot silently locks the operator out
// until this re-applies the persisted password (mirrors ceralive-ssh-firstboot.sh's
// host-key restore). Fail-soft: a sync failure must never brick boot.
await guardNonCritical("ssh-password-sync", ensureSshPasswordSynced);
void getSshStatus();

await guardNonCritical("hardware-identity-drift", async () => {
	await warnOnHardwareIdentityDrift({
		detectKind: () => detectHardwareKindFromDeviceTree(),
		configuredHw: () => setup.hw,
		isRealDevice: () => isRealDevice(),
		warn: (message) => logger.warn(message),
	});
});
logger.info(bootTimer.phase("🖥️", "hardware"));

void updateGwWrapper();
setInterval(updateGwWrapper, UPDATE_GW_INT);

// Self-gating: it no-ops when updates are disabled for this device or when the
// host is a dev/mock box (a dev machine must never be handed to apt).
await guardNonCritical("software-update-recovery", async () => {
	await recoverSoftwareUpdateIfRunning();
});
periodicCheckForSoftwareUpdates();

initNetworkInterfaceMonitoring();
initUplinkHealth();
await guardNonCritical("uplink-steering", initUplinkSteering);
await guardNonCritical("uplink-shaper", initUplinkShaper);
await guardNonCritical("sharing-diag", initSharingDiag);

// Event-driven netif: monitor stream drives up/down; onResync re-polls on restart
const networkMonitor = createMonitorManager(() => updateNetif());
networkMonitor.on("monitor-event", handleNetifMonitorEvent);
networkMonitor.start();

// Event-driven wifi: same monitor drives connection up/down + diff broadcast
wifiStateInit(networkMonitor);

// Hotspot NM-confirmation: flips station↔hotspot once NM reports the switch
networkMonitor.on("monitor-event", handleHotspotMonitorEvent);

// Re-apply the operator's persisted per-adapter WiFi mode. Deliberately NOT
// awaited: the adapter registry is filled by the netif poll seconds after this
// point, so the reconciler does its own bounded wait — awaiting it here would
// put a radio on the boot critical path for no gain. It is idempotent and never
// throws, so a device with no stated preference pays one map lookup.
void guardNonCritical("wifi-adapter-modes", reconcileWifiAdapterModes);

// Re-apply the operator's persisted shared-LAN Ethernet roles. Deliberately NOT
// awaited, for the reason above: it rewrites NetworkManager profiles, and a
// wired port must not sit on the boot critical path. It is idempotent and never
// throws, so a device with no stated role pays one map lookup.
void guardNonCritical("ethernet-roles", reconcileEthernetRoles);

// MUST precede initModemUpdateLoop: the loop's first discovery + `modems`
// broadcast fire immediately, and every modem RPC gates on the readiness
// snapshot this commits — so a loop that wins the race publishes a snapshot
// from the default backend rather than the configured one, and refuses every
// modem procedure with CELLULAR_STACK_INITIALIZING until the stack lands. A
// dbus failure falls back to mmcli INSIDE the stack, so reaching this guard
// means the whole cellular subsystem is down and the device keeps its UI.
await guardNonCritical("cellular-stack", initCellularStack);
// The router-WebUI credential store. Ahead of the loop for the same reason the
// stack is: the first `modems` payload carries every row's lock state, and a
// store that has not loaded yet reports a device with a stored login as having
// none. It never throws — a missing or damaged file starts an empty store.
await guardNonCritical("modem-credentials", () => initModemCredentials());
// Opt-in mutation-free D-Bus-vs-mmcli comparison (the mmcli-retirement evidence
// collector). Also ahead of the loop so its first heartbeat window covers the
// same modem roster the loop is about to publish. An unconfigured device
// returns before the D-Bus client is imported at all.
await guardNonCritical("cellular-shadow", startModemShadowIfEnabled);
// The optimistic-row attach source (todo 18), deliberately armed BEFORE the
// loop: an attach observed during the rest of boot is then already in the cache
// when the loop's first discovery builds the first `modems` payload a client
// sees. Nothing is lost by starting early — the cache holds the row until
// something broadcasts, and the loop's own subscription takes over from there.
await guardNonCritical("udev-provisional", initUdevProvisionalMonitor);

// Event-driven modems share the SAME monitor (one nmcli monitor for all)
void initModemUpdateLoop({ monitor: networkMonitor });

// Replay the durable modem-mutation journal and LOWER the admission barrier.
// It runs after the modem roster has been started because a rollback that needs
// the certified reverse transition has to find the device; the presence and
// state-comparison paths read the USB bus directly and need no roster at all.
// `initMutationRecovery` never throws and lowers the barrier on every exit — a
// barrier nobody will lower is worse than a device that reports its blocks.
// Every capability module that JOURNALS registers its rollback handler BEFORE
// replay runs. A journaled entry whose kind has no handler replays into
// `unavailable`, which leaves the device blocked for a mutation that could in
// fact have been undone.
initFccUnlockModule();

await guardNonCritical("modem-mutation-recovery", async () => {
	await initMutationRecovery();
});
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
onHeartbeatTick(() => {
	void tickUplinkShaper();
});

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

// Network-ingest desired-state reconcile (T6): fire-and-forget, never gates boot.
// Reconciles the baked-in rtmp/srt gateway units to the operator's persisted
// enable/disable choice; no-ops on a dev/emulated host and swallows all failures.
void reconcileIngestDesiredState();

// Bluetooth: reconcile the units to the operator's persisted preference, observe
// BlueZ, register the pairing agent and run the one bounded boot reconnect.
// Fire-and-forget behind guardNonCritical for the same reason the two above are:
// it enables systemd units and dials the system bus, so awaiting it would put a
// radio on the boot critical path. A dev host, a board with no controller and a
// masked bluetoothd all resolve to a typed `bt_unavailable` inside the stack.
void guardNonCritical("bluetooth", initBluetooth);

process.on("SIGTERM", () =>
	handleTerminationSignal("SIGTERM", {
		gracefulShutdown,
		stopSrtIngest: stopSRTIngest,
		stopDmesgWatchers,
		stopUplinkShaper,
		exit: process.exit,
	}),
);
process.on("SIGINT", () =>
	handleTerminationSignal("SIGINT", {
		gracefulShutdown,
		stopSrtIngest: stopSRTIngest,
		stopDmesgWatchers,
		stopUplinkShaper,
		exit: process.exit,
	}),
);

logger.info(bootTimer.phase("▶️", "autostart & reconciler"));

logger.info(formatReadyLine(bootTimer.elapsedMs(), boundPort));
