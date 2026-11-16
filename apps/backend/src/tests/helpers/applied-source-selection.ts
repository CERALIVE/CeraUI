import { onTestFinished } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_SELECTION_CLEAR_FEATURE } from "@ceralive/cerastream";
import type {
	NetworkIngest,
	StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { runtimeConfigSchema } from "../../helpers/config-schemas.ts";
import { initMockService, stopMockService } from "../../mocks/mock-service.ts";
import { getMockEngineCapabilities } from "../../mocks/providers/streaming.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../../modules/config.ts";
import { clearCapabilitiesCache } from "../../modules/streaming/capabilities.ts";
import {
	createApplyNowGate,
	setApplyNowGateForTest,
} from "../../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
} from "../../modules/streaming/config-change-staging.ts";
import {
	initPipelines,
	setMockHardware,
} from "../../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	buildSources,
	resetEngineDeviceCache,
} from "../../modules/streaming/sources.ts";
import {
	createStreamSessionOrchestrator,
	type EngineConfigChangeOutcome,
	type StreamConfigChangeDelta,
	type StreamSessionOrchestratorDeps,
} from "../../modules/streaming/stream-session-orchestrator.ts";
import { createContext } from "../../rpc/context.ts";
import {
	setConfigProcedure,
	setStreamingProcedureDepsForTest,
} from "../../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, SocketData } from "../../rpc/types.ts";
import { OSMO_STABLE, osmo } from "./dual-mode-camera.ts";

export const SECOND_STABLE = "usb:second-camera";
export const SECOND_CAMERA = { ...osmo("video2"), stable_id: SECOND_STABLE };

/** Real RPC, routing, admission, marker and atomic config writer; only device
 * discovery and the engine's eventual transaction answer are supplied. */
export async function sourceSelectionFixture(
	changeRuntimeConfig?: StreamSessionOrchestratorDeps["changeRuntimeConfig"],
) {
	const dir = await mkdtemp(join(tmpdir(), "applied-selection-"));
	const priorPath = getConfigFilePath();
	const priorConfig = { ...getConfig() };
	const priorMarkerPath = defaultStagingDeps.markerPath;
	const priorMockMode = process.env.MOCK_MODE;
	const connected = Promise.withResolvers<AppWebSocket>();
	const server = Bun.serve<SocketData>({
		port: 0,
		hostname: "127.0.0.1",
		fetch: (request, server) => {
			server.upgrade(request, {
				data: { isAuthenticated: true, lastActive: Date.now() },
			});
		},
		websocket: { open: connected.resolve, message: () => undefined },
	});
	const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
	onTestFinished(async () => {
		client.close();
		server.stop(true);
		setApplyNowGateForTest(null);
		setStreamingProcedureDepsForTest(null);
		clearStagedConfigChange();
		Object.defineProperty(defaultStagingDeps, "markerPath", {
			value: priorMarkerPath,
		});
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		stopMockService();
		if (priorMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = priorMockMode;
		for (const key of Object.keys(getConfig()))
			Reflect.deleteProperty(getConfig(), key);
		Object.assign(getConfig(), priorConfig);
		setConfigFilePath(priorPath);
		await rm(dir, { recursive: true, force: true });
	});
	const context = createContext(await connected.promise);
	setConfigFilePath(join(dir, "config.json"));
	// Redirect the production file adapter without replacing any storage method.
	Object.defineProperty(defaultStagingDeps, "markerPath", {
		value: join(dir, "config.inflight.json"),
	});
	process.env.MOCK_MODE = "true";
	initMockService("caps-full");
	setMockHardware("rk3588");
	clearCapabilitiesCache();
	const capabilities = getMockEngineCapabilities();
	capabilities.caps.features = [
		...(capabilities.caps.features ?? []),
		CAPTURE_SELECTION_CLEAR_FEATURE,
	];
	await initPipelines({
		fetchEngineCapabilities: async () => capabilities,
		fetchEngineDevices: async () => ({ devices: [] }),
	});
	resetEngineDeviceCache();
	const devices = [osmo(), SECOND_CAMERA];
	const networkIngest: NetworkIngest = { rtmp: null, srt: null };
	applyObservedEngineDevices(devices);
	const sources = () => {
		const config = getConfig();
		return buildSources({
			sources: capabilities.caps.sources,
			devices,
			networkIngest,
			lastSeenDevices: config.last_seen_devices ?? [],
			...(config.input_mode === undefined
				? {}
				: { inputMode: config.input_mode }),
			selectedSource: config.source,
			selectedSourceStableId: config.source_stable_id,
		});
	};
	setStreamingProcedureDepsForTest({
		getSourcesMessage: () => ({ hardware: "rk3588", sources: sources() }),
	});
	let change = async (): Promise<EngineConfigChangeOutcome> => ({
		phase: "applied",
	});
	const deltas: StreamConfigChangeDelta[] = [];
	let attempt = 0;
	const orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => `source-selection-${++attempt}`,
		setStreamingStatus: () => undefined,
		setLifecycleState: () => undefined,
		stopRuntime: async () => undefined,
		queryRuntime: async () => "idle",
		scheduleTimeout: () => 0,
		cancelTimeout: () => undefined,
		scheduleLaunchDeadline: () => 0,
		cancelLaunchDeadline: () => undefined,
		changeRuntimeConfig: (delta, attemptId) => {
			deltas.push(delta);
			return changeRuntimeConfig?.(delta, attemptId) ?? change();
		},
	});
	setApplyNowGateForTest(createApplyNowGate(orchestrator));
	const write = (input: StreamingSetConfigInput) =>
		call(setConfigProcedure, input, { context });
	Object.assign(getConfig(), {
		source: undefined,
		source_stable_id: undefined,
		selected_video_input: undefined,
		input_mode: undefined,
		pipeline: undefined,
		resolution: undefined,
		framerate: undefined,
		last_seen_devices: undefined,
	});
	await write({ source: "video1" });
	return {
		dir,
		devices,
		capabilities,
		networkIngest,
		deltas,
		orchestrator,
		sources,
		write,
		setChange: (answer: typeof change) => {
			change = answer;
		},
		start: () =>
			orchestrator.start({ origin: "ui", launch: async () => undefined }),
		read: async () =>
			runtimeConfigSchema.parse(
				JSON.parse(await readFile(join(dir, "config.json"), "utf8")),
			),
		marker: () => readFile(defaultStagingDeps.markerPath, "utf8"),
		originalSelection: {
			source: "video1",
			selected_video_input: "video1",
			source_stable_id: OSMO_STABLE,
		},
	};
}
