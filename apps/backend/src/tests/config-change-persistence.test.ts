/*
 * Staged persistence for an apply-now config change (device-quality-wave3 todo 12).
 *
 * The rule these cases lock: `config.json` describes what the ENGINE IS
 * RUNNING. So an apply-now candidate is held off disk for the whole
 * transaction, and only `applied` writes it. A `reverted` or `rollback_failed`
 * must leave the persisted values byte-identical, because those values are
 * still the ones the engine is running.
 *
 * These drive the REAL procedure for the same reason the device-truth suite
 * does: the guarantee has to hold for a direct RPC call, not just the dialog.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAPTURE_SELECTION_CLEAR_FEATURE,
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	CONFIG_CHANGE_REASON_REJECTED,
	type ConfigChangeResult,
	type LifecycleState,
	type StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../mocks/providers/network-ingest.ts";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import { refreshNetworkIngestInfo } from "../modules/network/network-ingest.ts";
import {
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	type ApplyNowGate,
	createApplyNowGate,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
	getStagedConfigChange,
	type InflightConfigMarker,
	judgeInflightMarker,
	readInflightMarker,
	releaseStagedConfigChange,
	type StagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	getSourcesMessage,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import {
	createStreamSessionOrchestrator,
	type EngineConfigChangeOutcome,
	type StreamConfigChangeDelta,
	type StreamSessionOrchestrator,
} from "../modules/streaming/stream-session-orchestrator.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import { engineDevice, osmo } from "./helpers/dual-mode-camera.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function memoryDeps(seed?: InflightConfigMarker): StagingDeps {
	let contents: string | undefined =
		seed === undefined ? undefined : JSON.stringify(seed);
	return {
		markerPath: "config.inflight.json",
		readMarker: () => contents,
		writeMarker: (_path, next) => {
			contents = next;
		},
		removeMarker: () => {
			contents = undefined;
		},
	};
}

function gate(
	outcome: ConfigChangeResult,
	live = true,
): ApplyNowGate & { deltas: unknown[] } {
	const deltas: unknown[] = [];
	return {
		deltas,
		isStreamLive: () => live,
		dispatch: async (delta) => {
			deltas.push(delta);
			return outcome;
		},
	};
}

const APPLIED: ConfigChangeResult = { result: "applied", attemptId: "a1" };
const REVERTED: ConfigChangeResult = {
	result: "reverted",
	attemptId: "a1",
	reason: "not_negotiated",
};
const ROLLBACK_FAILED: ConfigChangeResult = {
	result: "rollback_failed",
	attemptId: "a1",
	reason: "teardown_timeout",
};

describe("apply-now staged persistence", () => {
	let prior: {
		resolution: ReturnType<typeof getConfig>["resolution"];
		framerate: ReturnType<typeof getConfig>["framerate"];
	};

	beforeEach(() => {
		const config = getConfig();
		prior = { resolution: config.resolution, framerate: config.framerate };
		config.resolution = "1080p";
		config.framerate = 30;
	});

	afterEach(() => {
		const config = getConfig();
		config.resolution = prior.resolution;
		config.framerate = prior.framerate;
		setApplyNowGateForTest(null);
		clearStagedConfigChange(memoryDeps());
	});

	test("applied is the ONLY outcome that writes config.json", async () => {
		// Given a live stream and an apply-now change to 2160p.
		setApplyNowGateForTest(gate(APPLIED));

		// When the transaction applies.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then the candidate is persisted and echoed, and no marker survives.
		expect(result.success).toBe(true);
		expect(result.configChange).toEqual(APPLIED);
		expect(getConfig().resolution).toBe("2160p");
		expect(result.applied?.resolution).toBe("2160p");
		expect(getStagedConfigChange()).toBeUndefined();
	});

	test("reverted leaves the persisted values UNTOUCHED", async () => {
		// Given a live stream at 1080p.
		setApplyNowGateForTest(gate(REVERTED));

		// When the engine refuses the new geometry and restores the old one.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then disk still describes what the engine is running.
		expect(getConfig().resolution).toBe("1080p");
		expect(result.configChange).toEqual(REVERTED);
		expect(getStagedConfigChange()).toBeUndefined();
	});

	test("rollback_failed leaves the persisted values UNTOUCHED", async () => {
		// Given a live stream at 1080p.
		setApplyNowGateForTest(gate(ROLLBACK_FAILED));

		// When even the rollback fails and the engine goes Idle.
		const result = await call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then the operator's last WORKING config is what boots next time.
		expect(getConfig().resolution).toBe("1080p");
		expect(result.success).toBe(false);
		expect(result.configChange).toEqual(ROLLBACK_FAILED);
	});

	test("non-restart fields in the SAME save still persist immediately", async () => {
		// Given an apply-now save that also flips the bitrate overlay.
		setApplyNowGateForTest(gate(REVERTED));
		const priorOverlay = getConfig().bitrate_overlay;

		// When the geometry change reverts.
		await call(
			setConfigProcedure,
			{ resolution: "2160p", bitrate_overlay: true, apply_now: true },
			{ context: makeContext() },
		);

		// Then only the restart-requiring half was held back.
		expect(getConfig().bitrate_overlay).toBe(true);
		expect(getConfig().resolution).toBe("1080p");
		getConfig().bitrate_overlay = priorOverlay;
	});

	test("only the graph-baked fields reach the engine delta", async () => {
		// Given an apply-now save carrying a live-adjustable field too.
		const g = gate(APPLIED);
		setApplyNowGateForTest(g);

		// When it is dispatched.
		await call(
			setConfigProcedure,
			{
				resolution: "2160p",
				framerate: 30,
				bitrate_overlay: false,
				apply_now: true,
			},
			{ context: makeContext() },
		);

		// Then the transaction carries geometry only — never the overlay.
		expect(g.deltas).toEqual([{ resolution: "2160p", framerate: 30 }]);
	});

	test("a dispatch that throws still releases the stage", async () => {
		// Given a gate whose dispatch fails outright.
		setApplyNowGateForTest({
			isStreamLive: () => true,
			dispatch: async () => {
				throw new Error("engine bridge down");
			},
		});

		// When an apply-now change is attempted.
		const attempt = call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);

		// Then the failure surfaces, nothing is persisted, and the stage is free
		// for the next change.
		await expect(attempt).rejects.toThrow();
		expect(getConfig().resolution).toBe("1080p");
		expect(getStagedConfigChange()).toBeUndefined();
	});
});

describe("a config.json write that fails after `applied`", () => {
	let dir: string;
	let priorPath: string;
	let prior: Pick<ReturnType<typeof getConfig>, "resolution" | "framerate">;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "apply-now-write-fail-"));
		priorPath = getConfigFilePath();
		setConfigFilePath(join(dir, "config.json"));
		const config = getConfig();
		prior = { resolution: config.resolution, framerate: config.framerate };
		config.resolution = "1080p";
		config.framerate = 30;
	});

	afterEach(async () => {
		setApplyNowGateForTest(null);
		clearStagedConfigChange();
		Object.assign(getConfig(), prior);
		setConfigFilePath(priorPath);
		await rm(dir, { recursive: true, force: true });
	});

	/** The engine applies 2160p; only the config.json write that follows fails. */
	async function applyWithFailingWrite(): Promise<void> {
		setApplyNowGateForTest({
			isStreamLive: () => true,
			dispatch: async () => {
				setConfigFilePath(join(dir, "missing", "config.json"));
				return APPLIED;
			},
		});
		await expect(
			call(
				setConfigProcedure,
				{ resolution: "2160p", apply_now: true },
				{ context: makeContext() },
			),
		).rejects.toThrow();
		setConfigFilePath(join(dir, "config.json"));
	}

	test("the next change is not busy, and the recovery marker is kept", async () => {
		// Given a change the engine applied but config.json could not record.
		await applyWithFailingWrite();

		// Then its marker stays on disk as recovery evidence.
		expect(readInflightMarker()?.candidate).toEqual({ resolution: "2160p" });

		// And once the disk is writable again, the next change is admitted.
		setApplyNowGateForTest(gate(APPLIED));
		const next = await call(
			setConfigProcedure,
			{ resolution: "720p", apply_now: true },
			{ context: makeContext() },
		);
		expect(next.configChange).toEqual(APPLIED);
		expect(getConfig().resolution).toBe("720p");
	});

	test("reconciliation judges the kept marker and completes the write", async () => {
		// Given a change the engine applied but config.json could not record.
		await applyWithFailingWrite();

		// When the engine-reconnect hook finds the engine live on that candidate.
		const verdict = reconcileInflightConfigChange({
			streaming: true,
			resolution: "2160p",
			framerate: 30,
			pipelinePlaying: true,
			framesEmitted: 500,
		});

		// Then the marker is judged like a crash leftover: the write is completed
		// and the marker retired.
		expect(verdict).toBe("persisted_candidate");
		expect(readInflightMarker()).toBeUndefined();
	});
});

describe("apply-now falls back rather than surprising the operator", () => {
	afterEach(() => setApplyNowGateForTest(null));

	test("apply_now while NOT streaming persists normally and dispatches nothing", async () => {
		// Given an idle device.
		const g = gate(APPLIED, false);
		setApplyNowGateForTest(g);
		const config = getConfig();
		const priorResolution = config.resolution;

		// When apply-now is requested anyway (a race with the stream stopping).
		const result = await call(
			setConfigProcedure,
			{ resolution: "720p", apply_now: true },
			{ context: makeContext() },
		);

		// Then it degrades to the ordinary save — no transaction, no surprise.
		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(getConfig().resolution).toBe("720p");
		expect(g.deltas).toEqual([]);
		config.resolution = priorResolution;
	});

	test("the DEFAULT save (no apply_now) is the unchanged apply-on-next-start path", async () => {
		// Given a LIVE stream — the case where a restart would be most disruptive.
		const g = gate(APPLIED, true);
		setApplyNowGateForTest(g);
		const config = getConfig();
		const priorResolution = config.resolution;

		// When an ordinary save arrives with no apply_now directive.
		const result = await call(
			setConfigProcedure,
			{ resolution: "720p" },
			{ context: makeContext() },
		);

		// Then it persists immediately and NEVER restarts the stream.
		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(g.deltas).toEqual([]);
		expect(getConfig().resolution).toBe("720p");
		config.resolution = priorResolution;
	});
});

describe("crash-window reconciliation through the real writer", () => {
	test("NO marker ⇒ an apply-on-next-start mismatch survives a restart untouched", () => {
		// Given config.json holding the operator's 2160p "apply on next start"
		// intent while the engine is still live on the old 1080p — and NO marker.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "2160p";

		// When the backend restarts and reconciliation runs.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "1920x1080",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			memoryDeps(),
		);

		// Then nothing is reconciled — the operator's intent is preserved.
		expect(verdict).toBe("no_marker");
		expect(getConfig().resolution).toBe("2160p");
		config.resolution = priorResolution;
	});

	test("marker present + engine on the CANDIDATE ⇒ the candidate is persisted", () => {
		// Given a crash between `applied` and the config write.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When the engine is found live on the candidate with frames advancing.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "2160p",
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			deps,
		);

		// Then the write that the crash lost is completed.
		expect(verdict).toBe("persisted_candidate");
		expect(getConfig().resolution).toBe("2160p");
		config.resolution = priorResolution;
	});

	test("marker present + engine on the PREVIOUS params ⇒ old values retained", () => {
		// Given the same crash but the change never took.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When the engine is found live on the pre-change geometry.
		const verdict = reconcileInflightConfigChange(
			{
				streaming: true,
				resolution: "1080p",
				pipelinePlaying: true,
				framesEmitted: 500,
			},
			deps,
		);

		// Then disk is left alone and the marker is retired.
		expect(verdict).toBe("retained_previous");
		expect(getConfig().resolution).toBe("1080p");
		config.resolution = priorResolution;
	});

	test("marker present + engine undecided ⇒ nothing written, marker KEPT", () => {
		// Given an engine that cannot be reached at reconciliation time.
		const config = getConfig();
		const priorResolution = config.resolution;
		config.resolution = "1080p";
		const deps = memoryDeps({
			attemptId: "a1",
			startedAt: 1,
			candidate: { resolution: "2160p" },
			previous: { resolution: "1080p" },
		});

		// When reconciliation runs with no engine snapshot.
		const verdict = reconcileInflightConfigChange(undefined, deps);

		// Then it defers — and the marker is still there for the next reconnect.
		expect(verdict).toBe("deferred");
		expect(getConfig().resolution).toBe("1080p");
		expect(deps.readMarker(deps.markerPath)).toBeDefined();
		config.resolution = priorResolution;
	});
});

const OVERLAP_CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [],
	audio_backends: { supported: ["alsa", "pipewire"], active: "pipewire" },
};

/** An engine answer that never arrives, holding a lifecycle state open. */
const HELD = new Promise<never>(() => {});

type Session = {
	orchestrator: StreamSessionOrchestrator;
	/** The engine's answers, swappable per case. */
	engine: {
		change: () => Promise<EngineConfigChangeOutcome>;
		stop: () => Promise<void>;
		query: () => Promise<EngineRuntimeState>;
	};
	/** Every change the engine was asked to apply. */
	deltas: StreamConfigChangeDelta[];
	reached: (state: LifecycleState) => Promise<void>;
};

/** An idle session behind the production apply-now gate and the real orchestrator. */
function session(): Session {
	let attempts = 0;
	const waiting = new Map<LifecycleState, () => void>();
	const s: Session = {
		orchestrator: undefined as unknown as StreamSessionOrchestrator,
		engine: {
			change: async () => ({ phase: "applied" }),
			stop: async () => {},
			query: async () => "idle",
		},
		deltas: [],
		reached: (state) =>
			s.orchestrator.snapshot().state === state
				? Promise.resolve()
				: new Promise((resolve) => {
						waiting.set(state, resolve);
					}),
	};
	s.orchestrator = createStreamSessionOrchestrator({
		createAttemptId: () => `engine-${++attempts}`,
		setStreamingStatus: () => {},
		setLifecycleState: (state) => waiting.get(state)?.(),
		stopRuntime: () => s.engine.stop(),
		queryRuntime: () => s.engine.query(),
		scheduleTimeout: () => 0,
		cancelTimeout: () => {},
		scheduleLaunchDeadline: () => 0,
		cancelLaunchDeadline: () => {},
		changeRuntimeConfig: (delta) => {
			s.deltas.push(delta);
			return s.engine.change();
		},
	});
	setApplyNowGateForTest(createApplyNowGate(s.orchestrator));
	return s;
}

const stream = (s: Session) =>
	s.orchestrator.start({ origin: "ui", launch: async () => {} });

/**
 * Puts a session in each lifecycle state through its real methods. Keyed by the
 * full state type, so a new state cannot compile without a way to reach it.
 * `reconfiguring` is reached by admitting `competing`, which then never settles.
 */
const ENTER: Record<
	LifecycleState,
	(s: Session, competing: StreamingSetConfigInput) => Promise<unknown>
> = {
	idle: async () => {},
	starting: (s) => {
		void s.orchestrator.start({ origin: "ui", launch: () => HELD });
		return s.reached("starting");
	},
	streaming: stream,
	reconfiguring: async (s, competing) => {
		await stream(s);
		s.engine.change = () => HELD;
		void call(setConfigProcedure, competing, { context: makeContext() });
		await s.reached("reconfiguring");
	},
	stopping: async (s) => {
		await stream(s);
		s.engine.stop = () => HELD;
		void s.orchestrator.stop("engine_loss");
		await s.reached("stopping");
	},
	stop_failed: async (s) => {
		await stream(s);
		s.engine.stop = async () => {
			throw new Error("stop-ack-unavailable");
		};
		await s.orchestrator.stop("engine_loss");
	},
	reconciling: async (s) => {
		await stream(s);
		s.engine.query = () => HELD;
		void s.orchestrator.reconcile();
		await s.reached("reconciling");
	},
};

describe("two overlapping apply-now saves", () => {
	let dir: string;
	let priorPath: string;
	let prior: Pick<
		ReturnType<typeof getConfig>,
		"resolution" | "framerate" | "audio_backend"
	>;
	let marker: string | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "apply-now-overlap-"));
		priorPath = getConfigFilePath();
		setConfigFilePath(join(dir, "config.json"));
		const config = getConfig();
		prior = {
			resolution: config.resolution,
			framerate: config.framerate,
			audio_backend: config.audio_backend,
		};
		config.resolution = "1080p";
		config.framerate = 30;
		marker = undefined;
		spyOn(defaultStagingDeps, "readMarker").mockImplementation(() => marker);
		spyOn(defaultStagingDeps, "writeMarker").mockImplementation(
			(_path, contents) => {
				marker = contents;
			},
		);
		spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {
			marker = undefined;
		});
		clearCapabilitiesCache();
		await initPipelines({
			fetchEngineCapabilities: async () => ({
				caps: OVERLAP_CAPS,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
	});

	afterEach(async () => {
		setApplyNowGateForTest(null);
		clearStagedConfigChange();
		spyOn(defaultStagingDeps, "readMarker").mockRestore();
		spyOn(defaultStagingDeps, "writeMarker").mockRestore();
		spyOn(defaultStagingDeps, "removeMarker").mockRestore();
		resetBluetoothAudioForTest();
		clearCapabilitiesCache();
		Object.assign(getConfig(), prior);
		setConfigFilePath(priorPath);
		await rm(dir, { recursive: true, force: true });
	});

	/** A streaming session whose engine holds a change open until `answer`. */
	async function liveSession(): Promise<{
		asked: Promise<void>;
		answer: (outcome: EngineConfigChangeOutcome) => void;
	}> {
		const s = session();
		await stream(s);
		let engineCalled: () => void = () => {};
		const engine = {
			asked: new Promise<void>((resolve) => {
				engineCalled = resolve;
			}),
			answer: (_outcome: EngineConfigChangeOutcome): void => {},
		};
		s.engine.change = () => {
			engineCalled();
			return new Promise((resolve) => {
				engine.answer = resolve;
			});
		};
		return engine;
	}

	test("the change admitted first keeps its stage; the other is busy and retires nothing", async () => {
		// Given a live session whose engine holds a change open.
		const engine = await liveSession();
		// And the Bluetooth refresh an audio-backend save awaits held open, which
		// parks that save after it chose apply-now and before admission.
		let releaseBluetooth: () => void = () => {};
		let bluetoothCalled: () => void = () => {};
		const bluetoothAsked = new Promise<void>((resolve) => {
			bluetoothCalled = resolve;
		});
		setBluetoothAudioDepsForTest({
			readEnumeratedPcms: async () => [],
			readRegistryDevices: () => [],
			engineSupportsPcmSpec: () => true,
			engineSupportsPipewireCapture: () => false,
			readEngineAudioDevices: () => [],
			readAudioProvider: () => {
				bluetoothCalled();
				return new Promise((resolve) => {
					releaseBluetooth = () => resolve("bluealsa");
				});
			},
			readAudioBackend: () => undefined,
		});

		// When save A (backend + 2160p) parks on that refresh, save B (720p) reaches
		// admission, and only then does A continue.
		const first = call(
			setConfigProcedure,
			{ resolution: "2160p", audio_backend: "alsa", apply_now: true },
			{ context: makeContext() },
		);
		await bluetoothAsked;
		const second = call(
			setConfigProcedure,
			{ resolution: "720p", apply_now: true },
			{ context: makeContext() },
		);
		await engine.asked;
		releaseBluetooth();
		const firstResult = await first;

		// Then A is busy, and B still owns the held candidate and the crash marker.
		expect(firstResult.configChange).toEqual({ result: "busy" });
		expect(getStagedConfigChange()?.candidate.resolution).toBe("720p");
		expect(readInflightMarker()?.attemptId).toBe(
			getStagedConfigChange()?.attemptId,
		);

		// And B's applied change is the one persisted, with nothing left staged.
		engine.answer({ phase: "applied" });
		const secondResult = await second;
		expect(secondResult.configChange?.result).toBe("applied");
		expect(getConfig().resolution).toBe("720p");
		expect(getConfig().audio_backend).toBe("alsa");
		expect(getStagedConfigChange()).toBeUndefined();
		expect(readInflightMarker()).toBeUndefined();
	});

	test("a save arriving while another change is applying is busy and persists no restart field", async () => {
		// Given change A admitted and still applying.
		const engine = await liveSession();
		const first = call(
			setConfigProcedure,
			{ resolution: "2160p", apply_now: true },
			{ context: makeContext() },
		);
		await engine.asked;

		// When save B arrives while A is applying.
		const second = await call(
			setConfigProcedure,
			{ resolution: "720p", apply_now: true },
			{ context: makeContext() },
		);

		// Then B is busy, its resolution is not saved, and A keeps its stage.
		expect(second.configChange).toEqual({ result: "busy" });
		expect(getConfig().resolution).toBe("1080p");
		expect(getStagedConfigChange()?.candidate).toEqual({ resolution: "2160p" });

		// And once A reverts, the device is left on the values it runs.
		engine.answer({ phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED });
		expect((await first).configChange?.result).toBe("reverted");
		expect(getConfig().resolution).toBe("1080p");
		expect(readInflightMarker()).toBeUndefined();
	});

	/**
	 * What a 720p apply-now save gets in each lifecycle state. Keyed by the full
	 * state type, so a new state cannot compile without a row here.
	 */
	const BY_STATE: Record<
		LifecycleState,
		{
			answer: "applied" | "busy" | undefined;
			saved: "720p" | "1080p";
			dispatched: 0 | 1;
		}
	> = {
		idle: { answer: undefined, saved: "720p", dispatched: 0 },
		starting: { answer: "busy", saved: "1080p", dispatched: 0 },
		streaming: { answer: "applied", saved: "720p", dispatched: 1 },
		reconfiguring: { answer: "busy", saved: "1080p", dispatched: 0 },
		stopping: { answer: "busy", saved: "1080p", dispatched: 0 },
		stop_failed: { answer: "busy", saved: "1080p", dispatched: 0 },
		reconciling: { answer: "busy", saved: "1080p", dispatched: 0 },
	};

	for (const [state, row] of Object.entries(BY_STATE) as [
		LifecycleState,
		(typeof BY_STATE)[LifecycleState],
	][]) {
		test(`an apply-now save while ${state}: ${row.answer ?? "saved for the next start"}`, async () => {
			// Given a session held in this lifecycle state.
			const s = session();
			await ENTER[state](s, { resolution: "2160p", apply_now: true });
			expect(s.orchestrator.snapshot().state).toBe(state);
			const before = s.deltas.length;

			// When an apply-now save arrives.
			const result = await call(
				setConfigProcedure,
				{ resolution: "720p", apply_now: true },
				{ context: makeContext() },
			);

			// Then only settled idle saves it for the next start, only streaming
			// applies it, and every other state refuses it with nothing saved.
			expect(result.configChange?.result).toBe(row.answer);
			expect(getConfig().resolution).toBe(row.saved);
			expect(s.deltas.length - before).toBe(row.dispatched);
			expect(getStagedConfigChange()?.candidate.resolution).not.toBe("720p");
		});
	}
});

// Both USB pipelines are offered, so the Osmo's MJPEG mode is routable at all.
const CAMERA_CAPS: GetCapabilitiesResult = {
	features: [CAPTURE_SELECTION_CLEAR_FEATURE],
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: ["hdmi", "libuvch264", "usb_mjpeg", "test", "rtmp"].map((id) => ({
		id,
		supports_audio: true,
		supports_resolution_override: id !== "rtmp",
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	})),
};

describe("a capture-mode switch in each lifecycle state", () => {
	const savedMockMode = process.env.MOCK_MODE;
	let dir: string;
	let priorPath: string;
	let prior: Pick<
		ReturnType<typeof getConfig>,
		| "source"
		| "source_stable_id"
		| "input_mode"
		| "pipeline"
		| "selected_video_input"
		| "last_seen_devices"
		| "resolution"
		| "framerate"
	>;
	let marker: string | undefined;

	/** The mode and pipeline as config.json on disk holds them. */
	const onDisk = async () => {
		const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
		return { input_mode: saved.input_mode, pipeline: saved.pipeline };
	};

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
	});

	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		clearCapabilitiesCache();
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "apply-now-mode-"));
		priorPath = getConfigFilePath();
		setConfigFilePath(join(dir, "config.json"));
		const config = getConfig();
		prior = {
			source: config.source,
			source_stable_id: config.source_stable_id,
			input_mode: config.input_mode,
			pipeline: config.pipeline,
			selected_video_input: config.selected_video_input,
			last_seen_devices: config.last_seen_devices,
			resolution: config.resolution,
			framerate: config.framerate,
		};
		marker = undefined;
		spyOn(defaultStagingDeps, "readMarker").mockImplementation(() => marker);
		spyOn(defaultStagingDeps, "writeMarker").mockImplementation(
			(_path, contents) => {
				marker = contents;
			},
		);
		spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {
			marker = undefined;
		});
		clearCapabilitiesCache();
		await initPipelines({
			fetchEngineCapabilities: async () => ({
				caps: CAMERA_CAPS,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		resetEngineDeviceCache();
		applyObservedEngineDevices([osmo()]);
		Object.assign(config, {
			source: undefined,
			source_stable_id: undefined,
			input_mode: undefined,
			pipeline: undefined,
			selected_video_input: undefined,
			last_seen_devices: undefined,
			resolution: "1080p",
			framerate: 30,
		});
		// The dual-format camera is saved in H.264 while idle.
		session();
		const seeded = await call(
			setConfigProcedure,
			{ source: "video1", input_mode: "uvc_h264" },
			{ context: makeContext() },
		);
		expect(seeded.success).toBe(true);
		expect(await onDisk()).toEqual(H264);
	});

	afterEach(async () => {
		setApplyNowGateForTest(null);
		clearStagedConfigChange();
		spyOn(defaultStagingDeps, "readMarker").mockRestore();
		spyOn(defaultStagingDeps, "writeMarker").mockRestore();
		spyOn(defaultStagingDeps, "removeMarker").mockRestore();
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		Object.assign(getConfig(), prior);
		setConfigFilePath(priorPath);
		await rm(dir, { recursive: true, force: true });
	});

	const H264 = { input_mode: "uvc_h264", pipeline: "libuvch264" } as const;
	const MJPEG = { input_mode: "mjpeg", pipeline: "usb_mjpeg" } as const;

	/** What an apply-now switch to MJPEG gets in each lifecycle state. */
	const MODE_BY_STATE: Record<
		LifecycleState,
		{
			answer: "applied" | "busy" | undefined;
			saved: typeof H264 | typeof MJPEG;
			engineAsked: StreamConfigChangeDelta[];
		}
	> = {
		idle: { answer: undefined, saved: MJPEG, engineAsked: [] },
		starting: { answer: "busy", saved: H264, engineAsked: [] },
		streaming: {
			answer: "applied",
			saved: MJPEG,
			engineAsked: [{ input_mode: "mjpeg" }],
		},
		reconfiguring: { answer: "busy", saved: H264, engineAsked: [] },
		stopping: { answer: "busy", saved: H264, engineAsked: [] },
		stop_failed: { answer: "busy", saved: H264, engineAsked: [] },
		reconciling: { answer: "busy", saved: H264, engineAsked: [] },
	};

	for (const [state, row] of Object.entries(MODE_BY_STATE) as [
		LifecycleState,
		(typeof MODE_BY_STATE)[LifecycleState],
	][]) {
		test(`a switch to MJPEG while ${state}: ${row.answer ?? "saved for the next start"}`, async () => {
			// Given the camera saved in H.264 and a session held in this state.
			const s = session();
			await ENTER[state](s, { resolution: "720p", apply_now: true });
			expect(s.orchestrator.snapshot().state).toBe(state);
			const before = s.deltas.length;

			// When an apply-now switch to MJPEG arrives.
			const result = await call(
				setConfigProcedure,
				{ input_mode: "mjpeg", apply_now: true },
				{ context: makeContext() },
			);

			// Then the mode and the pipeline it routes to move together, and only
			// where the save is not refused: config.json never holds half of it.
			expect(result.configChange?.result).toBe(row.answer);
			expect(await onDisk()).toEqual(row.saved);
			expect(s.deltas.slice(before)).toEqual(row.engineAsked);
		});
	}

	test("a live switch to MJPEG the engine reverts leaves H.264 saved", async () => {
		// Given a streaming session whose engine refuses the new mode.
		const s = session();
		await stream(s);
		s.engine.change = async () => ({
			phase: "reverted",
			reason: CONFIG_CHANGE_REASON_REJECTED,
		});

		// When an apply-now switch to MJPEG is made.
		const result = await call(
			setConfigProcedure,
			{ input_mode: "mjpeg", apply_now: true },
			{ context: makeContext() },
		);

		// Then nothing of the refused mode is saved.
		expect(result.configChange?.result).toBe("reverted");
		expect(await onDisk()).toEqual(H264);
	});
});

/**
 * A source switch to an ingest pipeline derives stale geometry cleanup for the
 * DESTINATION. That clear describes a source the engine has not accepted yet,
 * so it must ride the staged transaction: before this, a busy or reverted
 * switch deleted the running source's saved resolution before admission
 * refused it. The applied/idle cases stay alongside as controls, so the fix
 * cannot drift into an unconditional deferral of ordinary residue cleanup.
 * Selection/anchor metadata on an APPLIED write remains row 59's contract.
 */
describe("a source switch owns its derived override residue", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedSourceSchema = runtimeConfigSchema.pick({
		source: true,
		source_stable_id: true,
		pipeline: true,
		selected_video_input: true,
		input_mode: true,
		resolution: true,
		framerate: true,
	});
	// Row 57 owns the source-derived restart fields and the residue clears. The
	// selection/anchor that an APPLIED source write must also commit is row 59's
	// contract, so these cases read it only where a refusal has to preserve it.
	const savedOwnedSchema = runtimeConfigSchema.pick({
		source: true,
		pipeline: true,
		input_mode: true,
		resolution: true,
		framerate: true,
	});
	let dir: string;
	let priorPath: string;
	let priorMarkerPath: string;
	let prior: ReturnType<typeof getConfig>;

	const onDisk = async () =>
		savedSourceSchema.parse(
			JSON.parse(await readFile(join(dir, "config.json"), "utf8")),
		);
	const onDiskOwned = async () =>
		savedOwnedSchema.parse(
			JSON.parse(await readFile(join(dir, "config.json"), "utf8")),
		);

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("caps-full");
		setMockHardware("rk3588");
	});

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "source-residue-"));
		priorPath = getConfigFilePath();
		priorMarkerPath = defaultStagingDeps.markerPath;
		setConfigFilePath(join(dir, "config.json"));
		// Redirect the production marker writer, without replacing its IO.
		Object.defineProperty(defaultStagingDeps, "markerPath", {
			value: join(dir, "config.inflight.json"),
			configurable: true,
			enumerable: true,
			writable: true,
		});
		prior = { ...getConfig() };
		setMockHardware("rk3588");
		clearCapabilitiesCache();
		await initPipelines({
			fetchEngineCapabilities: async () => ({
				caps: CAMERA_CAPS,
				schemaVersion: SCHEMA_VERSION,
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
		resetEngineDeviceCache();
		applyObservedEngineDevices([osmo()]);
		// Source availability comes from the network-ingest snapshot, not the
		// start gate's own mock flag.
		setMockNetworkIngestActive("rtmp", true);
		await refreshNetworkIngestInfo();
		Object.assign(getConfig(), {
			source: undefined,
			source_stable_id: undefined,
			input_mode: undefined,
			pipeline: undefined,
			selected_video_input: undefined,
			last_seen_devices: undefined,
			resolution: "720p",
			framerate: 30,
		});
	});

	afterEach(async () => {
		setApplyNowGateForTest(null);
		clearStagedConfigChange();
		Object.defineProperty(defaultStagingDeps, "markerPath", {
			value: priorMarkerPath,
			configurable: true,
			enumerable: true,
			writable: true,
		});
		Object.assign(getConfig(), prior);
		setConfigFilePath(priorPath);
		resetEngineDeviceCache();
		clearCapabilitiesCache();
		await rm(dir, { recursive: true, force: true });
	});

	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
	});

	// Actual RK3588 RTMP descriptor: resolution=false, framerate=true.
	const INGEST = { source: "rtmp", pipeline: "rtmp", framerate: 30 } as const;
	const PICKS: readonly StreamingSetConfigInput[] = [
		{ source: "hdmi" },
		{ source: "video1" },
		{ source: "video1", input_mode: "uvc_h264" },
	];

	async function seed(pick: StreamingSetConfigInput) {
		session();
		const result = await call(setConfigProcedure, pick, {
			context: makeContext(),
		});
		expect(result.success).toBe(true);
		expect(
			getSourcesMessage().sources.find((source) => source.id === "rtmp")
				?.available,
		).toBe(true);
		return onDisk();
	}

	for (const pick of PICKS) {
		for (const state of Object.keys(ENTER) as LifecycleState[]) {
			test(`${pick.source}/${pick.input_mode ?? "auto"} to ingest while ${state} keeps source-derived fields coupled`, async () => {
				const previous = await seed(pick);
				const s = session();
				await ENTER[state](s, { resolution: "1080p", apply_now: true });
				expect(s.orchestrator.snapshot().state).toBe(state);
				const held = readInflightMarker();
				const before = s.deltas.length;

				const result = await call(
					setConfigProcedure,
					{ source: "rtmp", apply_now: true, bitrate_overlay: true },
					{ context: makeContext() },
				);

				const moves = state === "idle" || state === "streaming";
				expect(result.configChange?.result).toBe(
					state === "idle" ? undefined : moves ? "applied" : "busy",
				);
				if (moves) {
					// The source, its pipeline, the mode and the overrides the new
					// ingest cannot honor all move with the transaction.
					expect(await onDiskOwned()).toEqual(INGEST);
				} else {
					// A refusal keeps EVERY source-derived field, including the stale
					// geometry whose clear belongs to the rejected destination.
					expect(await onDisk()).toEqual(previous);
				}
				// Unrelated immediate fields still save.
				expect(getConfig().bitrate_overlay).toBe(true);
				expect(s.deltas.slice(before)).toEqual(
					state === "streaming"
						? [
								{
									pipeline: "rtmp",
									input_id: null,
									input_mode: null,
								},
							]
						: [],
				);
				// Refusal may not replace or retire A's genuine on-disk marker.
				expect(readInflightMarker()).toEqual(held);
				expect(getStagedConfigChange()?.attemptId).toBe(held?.attemptId);
			});
		}

		test(`${pick.source}/${pick.input_mode ?? "auto"} reverted ingest switch preserves saved geometry and routing`, async () => {
			const previous = await seed(pick);
			const s = session();
			await stream(s);
			s.engine.change = async () => ({
				phase: "reverted",
				reason: CONFIG_CHANGE_REASON_REJECTED,
			});

			const result = await call(
				setConfigProcedure,
				{ source: "rtmp", apply_now: true },
				{ context: makeContext() },
			);

			expect(result.configChange?.result).toBe("reverted");
			expect(await onDisk()).toEqual(previous);
			expect(readInflightMarker()).toBeUndefined();
			expect(s.deltas).toEqual([
				{
					pipeline: "rtmp",
					input_id: null,
					input_mode: null,
				},
			]);
		});
	}

	test("an applied ingest switch holds all clears off disk until the engine answers", async () => {
		const previous = await seed({
			source: "video1",
			input_mode: "uvc_h264",
		});
		const s = session();
		await stream(s);
		let during:
			| {
					disk: Awaited<ReturnType<typeof onDisk>>;
					candidate: InflightConfigMarker["candidate"] | undefined;
			  }
			| undefined;
		s.engine.change = async () => {
			during = {
				disk: await onDisk(),
				candidate: readInflightMarker()?.candidate,
			};
			return { phase: "applied" };
		};

		const result = await call(
			setConfigProcedure,
			{ source: "rtmp", apply_now: true },
			{ context: makeContext() },
		);

		// The clear travels in the candidate: disk still holds the running source
		// until the engine has actually applied the switch.
		expect(during?.disk).toEqual(previous);
		expect(during?.candidate).toEqual({
			source: "rtmp",
			pipeline: "rtmp",
			input_mode: null,
			resolution: null,
			selected_video_input: null,
			source_stable_id: null,
		});
		expect(result.configChange?.result).toBe("applied");
		expect(await onDiskOwned()).toEqual(INGEST);
		expect(s.deltas).toEqual([
			{
				pipeline: "rtmp",
				input_id: null,
				input_mode: null,
			},
		]);
	});

	test("a next-start source save still clears obsolete capture fields while streaming", async () => {
		await seed({ source: "video1", input_mode: "uvc_h264" });
		const s = session();
		await stream(s);

		const result = await call(
			setConfigProcedure,
			{ source: "rtmp" },
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(await onDisk()).toEqual(INGEST);
		expect(s.deltas).toEqual([]);
	});

	test("a source-clear marker cannot infer applied from publisher geometry", async () => {
		const previous = await seed({ source: "video1" });
		const s = session();
		await stream(s);
		let during:
			| {
					disk: Awaited<ReturnType<typeof onDisk>>;
					verdict: ReturnType<typeof reconcileInflightConfigChange>;
			  }
			| undefined;
		s.engine.change = async () => {
			// Model only the leftover marker, not a process crash or engine restart.
			releaseStagedConfigChange();
			during = {
				disk: await onDisk(),
				verdict: reconcileInflightConfigChange({
					streaming: true,
					resolution: "1920x1080",
					framerate: 60,
					pipelinePlaying: true,
					framesEmitted: 120,
				}),
			};
			return { phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED };
		};

		const result = await call(
			setConfigProcedure,
			{ source: "rtmp", apply_now: true },
			{ context: makeContext() },
		);

		// A cleared override is a storage instruction, not a value the publisher's
		// geometry can confirm: the marker must stay undecided, and disk untouched.
		expect(during?.verdict).toBe("deferred");
		expect(during?.disk).toEqual(previous);
		expect(readInflightMarker()?.candidate.resolution).toBeNull();
		expect(result.configChange?.result).toBe("reverted");
	});

	test("a geometry clear on equal publisher geometry stays undecided and keeps the marker", async () => {
		// An ingest publisher can report EXACTLY the geometry the old source was
		// running. Neither match can then prove which source the engine accepted.
		const previous = await seed({ source: "hdmi" });
		const s = session();
		await stream(s);
		let during:
			| {
					judged: ReturnType<typeof judgeInflightMarker>["action"];
					verdict: ReturnType<typeof reconcileInflightConfigChange>;
					bytesBefore: string;
					bytesAfter: string;
					markerAfter: InflightConfigMarker | undefined;
					stoppedVerdict: ReturnType<typeof reconcileInflightConfigChange>;
					stoppedMarker: InflightConfigMarker | undefined;
			  }
			| undefined;
		s.engine.change = async () => {
			const marker = readInflightMarker();
			if (marker === undefined) throw new Error("expected a staged marker");
			expect(marker.candidate.resolution).toBeNull();
			const bytesBefore = await readFile(join(dir, "config.json"), "utf8");
			// Model only the leftover marker, not a process crash or engine restart.
			releaseStagedConfigChange();
			// The publisher's own output: same geometry the previous source ran, and
			// the coarse HDMI previous state carries no active-input expectation.
			const snapshot = {
				streaming: true,
				resolution: "1280x720",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 120,
			};
			during = {
				judged: judgeInflightMarker(marker, snapshot).action,
				verdict: reconcileInflightConfigChange(snapshot),
				bytesBefore,
				bytesAfter: await readFile(join(dir, "config.json"), "utf8"),
				markerAfter: readInflightMarker(),
				stoppedVerdict: reconcileInflightConfigChange({ streaming: false }),
				stoppedMarker: readInflightMarker(),
			};
			return { phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED };
		};

		const result = await call(
			setConfigProcedure,
			{ source: "rtmp", apply_now: true },
			{ context: makeContext() },
		);

		// Undecided while the engine runs; the evidence is retained byte-for-byte.
		// One assertion so a failure reports the whole recovery outcome.
		expect({
			judged: during?.judged,
			verdict: during?.verdict,
			markerPresent: during?.markerAfter !== undefined,
			bytesUnchanged: during?.bytesAfter === during?.bytesBefore,
			stoppedVerdict: during?.stoppedVerdict,
			stoppedMarkerRemoved: during?.stoppedMarker === undefined,
		}).toEqual({
			judged: "wait",
			verdict: "deferred",
			markerPresent: true,
			bytesUnchanged: true,
			// A STOPPED engine is still authoritative: the existing retain contract.
			stoppedVerdict: "retained_previous",
			stoppedMarkerRemoved: true,
		});
		expect(during?.bytesBefore).toBe(
			await readFile(join(dir, "config.json"), "utf8"),
		);
		expect(await onDisk()).toEqual(previous);
		expect(result.configChange?.result).toBe("reverted");
	});

	for (const outcome of ["applied", "reverted", "busy"] as const) {
		test(`Generic camlink's real no-override descriptor clears both axes only when ${outcome}`, async () => {
			setMockHardware("generic");
			clearCapabilitiesCache();
			await initPipelines({
				fetchEngineCapabilities: async () => ({
					caps: {
						features: [CAPTURE_SELECTION_CLEAR_FEATURE],
						platform: {
							supports_h265: false,
							hardware_accelerated: false,
							max_resolution: "1080p",
						},
						encoder: {
							codecs: ["h264"],
							bitrate_range: { min: 500, max: 50000, unit: "kbps" },
						},
						sources: [
							{
								id: "camlink",
								supports_audio: true,
								supports_resolution_override: false,
								supports_framerate_override: false,
								default_resolution: "1080p",
								default_framerate: 30,
							},
							...CAMERA_CAPS.sources.filter((source) => source.id === "test"),
						],
					} satisfies GetCapabilitiesResult,
					schemaVersion: SCHEMA_VERSION,
				}),
				fetchEngineDevices: async () => ({ devices: [] }),
			});
			applyObservedEngineDevices([
				engineDevice("cam1", "camlink", [], "Cam Link 4K", "usb:camlink"),
			]);
			session();
			await call(
				setConfigProcedure,
				{ source: "test" },
				{ context: makeContext() },
			);
			const previous = await onDisk();
			const s = session();
			await ENTER[outcome === "busy" ? "starting" : "streaming"](s, {});
			s.engine.change = async () =>
				outcome === "reverted"
					? { phase: "reverted", reason: CONFIG_CHANGE_REASON_REJECTED }
					: { phase: "applied" };

			const result = await call(
				setConfigProcedure,
				{ source: "cam1", apply_now: true },
				{ context: makeContext() },
			);

			expect(result.configChange?.result).toBe(outcome);
			expect(await onDisk()).toEqual(
				outcome === "applied"
					? {
							source: "cam1",
							pipeline: "camlink",
							selected_video_input: "cam1",
							source_stable_id: "usb:camlink",
						}
					: previous,
			);
			expect(s.deltas).toEqual(
				outcome === "busy"
					? []
					: [{ input_id: "cam1", pipeline: "camlink", input_mode: null }],
			);
		});
	}
});
