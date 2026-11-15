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

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import type { ConfigChangeResult } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	resetBluetoothAudioForTest,
	setBluetoothAudioDepsForTest,
} from "../modules/streaming/bluetooth-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	type ApplyNowGate,
	setApplyNowGateForTest,
} from "../modules/streaming/config-change-bridge.ts";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
	getStagedConfigChange,
	type InflightConfigMarker,
	readInflightMarker,
	type StagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import {
	createStreamSessionOrchestrator,
	type EngineConfigChangeOutcome,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

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

	test("the change admitted first keeps its stage; the other is busy and retires nothing", async () => {
		// Given a live session behind the real orchestrator admission, whose engine
		// holds a change open until the test answers it.
		let attempts = 0;
		let answerEngine: (outcome: EngineConfigChangeOutcome) => void = () => {};
		let engineCalled: () => void = () => {};
		const engineAsked = new Promise<void>((resolve) => {
			engineCalled = resolve;
		});
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => `engine-${++attempts}`,
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			scheduleTimeout: () => 0,
			cancelTimeout: () => {},
			scheduleLaunchDeadline: () => 0,
			cancelLaunchDeadline: () => {},
			changeRuntimeConfig: () => {
				engineCalled();
				return new Promise((resolve) => {
					answerEngine = resolve;
				});
			},
		});
		await orchestrator.start({ origin: "ui", launch: async () => {} });
		setApplyNowGateForTest({
			isStreamLive: () => orchestrator.snapshot().state === "streaming",
			dispatch: (delta) => orchestrator.changeConfig(delta),
		});
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
		await engineAsked;
		releaseBluetooth();
		const firstResult = await first;

		// Then A is busy, and B still owns the held candidate and the crash marker.
		expect(firstResult.configChange).toEqual({ result: "busy" });
		expect(getStagedConfigChange()?.candidate.resolution).toBe("720p");
		expect(readInflightMarker()?.attemptId).toBe(
			getStagedConfigChange()?.attemptId,
		);

		// And B's applied change is the one persisted, with nothing left staged.
		answerEngine({ phase: "applied" });
		const secondResult = await second;
		expect(secondResult.configChange?.result).toBe("applied");
		expect(getConfig().resolution).toBe("720p");
		expect(getConfig().audio_backend).toBe("alsa");
		expect(getStagedConfigChange()).toBeUndefined();
		expect(readInflightMarker()).toBeUndefined();
	});
});
