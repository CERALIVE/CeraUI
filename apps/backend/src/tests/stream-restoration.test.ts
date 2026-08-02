/*
 * Todo 42 — one-shot stream restoration after engine death.
 *
 * Wave3 measured 0/6 stream-level resumptions after a SIGKILL + systemd restart:
 * `noteConnectionLoss` retired the session and nothing ever tried again. These
 * cases pin the replacement, and the thing they mostly pin is when it must NOT
 * fire.
 *
 * Every named gate gets its own case that flips ONE condition and proves the
 * restoration does not happen — a table where all the rows pass together would
 * not tell us which gate is load-bearing. The discrimination table
 * (adopt / restore / neither) and the stop-cause table get the same treatment,
 * and the one-shot property is asserted by RUNNING the runner twice against a
 * real on-disk marker rather than by reading the code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LifecycleState } from "@ceraui/rpc/schemas";

import {
	type ArmedStreamConfig,
	type ArmedStreamMarker,
	type ArmedStreamMarkerDeps,
	clearArmedStreamMarker,
	decideStreamRestoration,
	notePlannedShutdown,
	noteStreamStopped,
	RESTORATION_BOUND_MS,
	readArmedStreamMarker,
	type StreamStopCause,
	writeArmedStreamMarker,
} from "../modules/streaming/armed-stream-marker.ts";
import {
	armStreamRestoration,
	type RestorationLaunchOutcome,
	type RestorationRunOutcome,
	runStreamRestoration,
	type StreamRestorationDeps,
	settleStreamRestoration,
} from "../modules/streaming/stream-restoration.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import type { EngineRuntimeState } from "../modules/streaming/streaming-backend.ts";

const BOOT_A = "11111111-1111-4111-8111-111111111111";
const BOOT_B = "22222222-2222-4222-8222-222222222222";

const SAMPLE_CONFIG: ArmedStreamConfig = {
	delay: 0,
	pipeline: "hdmi",
	acodec: "opus",
	asrc: "Auto",
	srtla_addr: "ingest.example.tv",
	srtla_port: 5000,
	srt_streamid: "abc",
	srt_latency: 2000,
	max_br: 6000,
	resolution: "1080p",
	framerate: 30,
	source: "/dev/video0",
};

let markerDir: string;
let markerPath: string;
let bootId: string | undefined;

function markerDeps(): ArmedStreamMarkerDeps {
	return {
		markerPath,
		readMarker: (path) => {
			try {
				return fs.readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		writeMarker: (path, contents) => fs.writeFileSync(path, contents),
		removeMarker: (path) => {
			try {
				fs.unlinkSync(path);
			} catch {
				// already gone
			}
		},
		readBootId: () => bootId,
	};
}

function plant(overrides: Partial<ArmedStreamMarker> = {}): ArmedStreamMarker {
	const marker: ArmedStreamMarker = {
		armedAt: 1_000,
		bootId: BOOT_A,
		config: SAMPLE_CONFIG,
		...overrides,
	};
	fs.writeFileSync(markerPath, JSON.stringify(marker));
	return marker;
}

function onDisk(): ArmedStreamMarker | undefined {
	return readArmedStreamMarker(markerDeps());
}

beforeEach(() => {
	markerDir = mkdtempSync(join(tmpdir(), "ceraui-armed-"));
	markerPath = join(markerDir, "stream.armed.json");
	bootId = BOOT_A;
});

afterEach(async () => {
	await settleStreamRestoration();
	rmSync(markerDir, { recursive: true, force: true });
});

const eligible = {
	marker: {
		armedAt: 1_000,
		bootId: BOOT_A,
		config: SAMPLE_CONFIG,
	} satisfies ArmedStreamMarker,
	runtimeState: "idle" as EngineRuntimeState,
	lifecycleState: "idle" as LifecycleState,
	currentBootId: BOOT_A,
	elapsedMs: 0,
};

describe("decideStreamRestoration — every gate blocks on its own", () => {
	test("all gates satisfied — and only then — restores", () => {
		expect(decideStreamRestoration(eligible)).toEqual({ action: "restore" });
	});

	test("a streaming engine is ADOPTED, never restored (the singleton rule)", () => {
		expect(
			decideStreamRestoration({ ...eligible, runtimeState: "streaming" }),
		).toEqual({ action: "adopt" });
	});

	test("adoption does not need a marker — a backend-only restart still adopts", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				marker: undefined,
				runtimeState: "streaming",
			}),
		).toEqual({ action: "adopt" });
	});

	test("adoption OUTRANKS a marker that has already been attempted", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				runtimeState: "streaming",
				marker: {
					...eligible.marker,
					attempt: {
						outcome: "failed",
						at: 5,
						elapsedMs: 5,
						withinBound: true,
					},
				},
			}),
		).toEqual({ action: "adopt" });
	});

	test("no marker blocks", () => {
		expect(decideStreamRestoration({ ...eligible, marker: undefined })).toEqual(
			{ action: "blocked", reason: "no_marker" },
		);
	});

	test("a RECOVERED attempt blocks — one shot means one, in both directions", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				marker: {
					...eligible.marker,
					attempt: {
						outcome: "recovered",
						at: 5,
						elapsedMs: 900,
						withinBound: true,
					},
				},
			}),
		).toEqual({ action: "blocked", reason: "already_attempted" });
	});

	test("a FAILED attempt blocks", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				marker: {
					...eligible.marker,
					attempt: {
						outcome: "failed",
						reason: "start_failed",
						at: 5,
						elapsedMs: 900,
						withinBound: true,
					},
				},
			}),
		).toEqual({ action: "blocked", reason: "already_attempted" });
	});

	test("a planned shutdown blocks", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				marker: {
					...eligible.marker,
					plannedShutdown: { reason: "software_update", at: 5 },
				},
			}),
		).toEqual({ action: "blocked", reason: "planned_shutdown" });
	});

	test("a boot_id mismatch blocks — a reboot NEVER auto-restarts a stream", () => {
		expect(
			decideStreamRestoration({ ...eligible, currentBootId: BOOT_B }),
		).toEqual({ action: "blocked", reason: "boot_id_mismatch" });
	});

	test("an UNREADABLE boot id fails closed, exactly like a mismatch", () => {
		expect(
			decideStreamRestoration({ ...eligible, currentBootId: undefined }),
		).toEqual({ action: "blocked", reason: "boot_id_mismatch" });
	});

	test("an unknown runtime state waits inside the sub-deadline", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				runtimeState: "unknown",
				elapsedMs: 9_999,
				unknownDeadlineMs: 10_000,
			}),
		).toEqual({ action: "wait", reason: "runtime_state_unknown" });
	});

	test("an unknown runtime state at the sub-deadline is TERMINAL", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				runtimeState: "unknown",
				elapsedMs: 10_000,
				unknownDeadlineMs: 10_000,
			}),
		).toEqual({ action: "give_up", reason: "runtime_state_unknown" });
	});

	test("a busy lifecycle waits rather than racing a config-change transaction", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				lifecycleState: "reconfiguring",
				elapsedMs: 500,
			}),
		).toEqual({ action: "wait", reason: "lifecycle_busy" });
	});

	test("a lifecycle that never frees up is terminal too", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				lifecycleState: "reconfiguring",
				elapsedMs: 10_000,
			}),
		).toEqual({ action: "give_up", reason: "lifecycle_busy" });
	});

	test("a decidable refusal is settled BEFORE any polling is spent on it", () => {
		expect(
			decideStreamRestoration({
				...eligible,
				runtimeState: "unknown",
				currentBootId: BOOT_B,
				elapsedMs: 0,
			}),
		).toEqual({ action: "blocked", reason: "boot_id_mismatch" });
	});
});

describe("the marker on disk", () => {
	test("arming records the config snapshot and the current boot", () => {
		expect(
			armStreamRestoration({
				marker: markerDeps(),
				captureConfig: () => SAMPLE_CONFIG,
				now: () => 4_242,
			}),
		).toBe(true);

		const marker = onDisk();
		expect(marker?.bootId).toBe(BOOT_A);
		expect(marker?.armedAt).toBe(4_242);
		expect(marker?.config).toMatchObject(SAMPLE_CONFIG);
		expect(marker?.attempt).toBeUndefined();
	});

	test("no readable boot id arms NOTHING — failing closed costs a restoration, failing open restarts across a power cycle", () => {
		bootId = undefined;
		expect(
			armStreamRestoration({
				marker: markerDeps(),
				captureConfig: () => SAMPLE_CONFIG,
			}),
		).toBe(false);
		expect(fs.existsSync(markerPath)).toBe(false);
	});

	test("an engine session id may be RECORDED but is never a gate", () => {
		armStreamRestoration({
			marker: markerDeps(),
			captureConfig: () => SAMPLE_CONFIG,
			diagnostics: { engineSessionId: "cs-1", origin: "ui" },
		});
		const marker = onDisk();
		expect(marker?.diagnostics?.engineSessionId).toBe("cs-1");

		// The same id from a RESTARTED engine names a different session (the ids
		// are process-local counters), so the decision must be identical with and
		// without it.
		expect(
			decideStreamRestoration({
				...eligible,
				marker: marker as ArmedStreamMarker,
			}),
		).toEqual({ action: "restore" });
	});

	test("an unreadable marker is discarded rather than trusted", () => {
		fs.writeFileSync(markerPath, "{not json");
		expect(onDisk()).toBeUndefined();
		expect(fs.existsSync(markerPath)).toBe(false);
	});

	test("the snapshot carries no credential fields", () => {
		armStreamRestoration({
			marker: markerDeps(),
			captureConfig: () =>
				({
					...SAMPLE_CONFIG,
					password_hash: "$2b$10$nope",
					ssh_pass: "hunter2",
					remote_key: "v4.public.nope",
				}) as unknown as ArmedStreamConfig,
		});
		const raw = fs.readFileSync(markerPath, "utf8");
		expect(raw).not.toContain("hunter2");
		expect(raw).not.toContain("password_hash");
		expect(raw).not.toContain("remote_key");
	});
});

describe("the stop-cause table", () => {
	const causes: Array<[StreamStopCause, "cleared" | "preserved"]> = [
		["operator", "cleared"],
		["engine_loss", "preserved"],
		["reconfigure", "preserved"],
	];

	for (const [cause, expected] of causes) {
		test(`cause=${cause} leaves the marker ${expected}`, () => {
			plant();
			noteStreamStopped(cause, markerDeps());
			expect(onDisk() === undefined ? "cleared" : "preserved").toBe(expected);
		});
	}

	test("an operator stop with no marker is a clean no-op", () => {
		expect(() => noteStreamStopped("operator", markerDeps())).not.toThrow();
		expect(fs.existsSync(markerPath)).toBe(false);
	});
});

describe("planned-shutdown suppression", () => {
	test("it is stamped onto an armed marker", () => {
		plant();
		expect(
			notePlannedShutdown("software_update", {
				marker: markerDeps(),
				now: () => 77,
			}),
		).toBe(true);
		expect(onDisk()?.plannedShutdown).toEqual({
			reason: "software_update",
			at: 77,
		});
	});

	test("with nothing armed there is nothing to suppress — and no orphan flag left behind", () => {
		expect(notePlannedShutdown("reboot", { marker: markerDeps() })).toBe(false);
		expect(fs.existsSync(markerPath)).toBe(false);
	});

	test("it never overwrites the first suppression reason", () => {
		plant();
		notePlannedShutdown("software_update", {
			marker: markerDeps(),
			now: () => 1,
		});
		notePlannedShutdown("reboot", { marker: markerDeps(), now: () => 2 });
		expect(onDisk()?.plannedShutdown?.reason).toBe("software_update");
	});

	test("the next armed stream starts from a clean marker", () => {
		plant({ plannedShutdown: { reason: "software_update", at: 1 } });
		armStreamRestoration({
			marker: markerDeps(),
			captureConfig: () => SAMPLE_CONFIG,
		});
		expect(onDisk()?.plannedShutdown).toBeUndefined();
	});
});

type RunHarness = {
	readonly deps: Partial<StreamRestorationDeps>;
	readonly launches: ArmedStreamConfig[];
	readonly published: RestorationRunOutcome[];
	readonly waits: number[];
};

function harness(options: {
	runtimeStates?: EngineRuntimeState[];
	lifecycleStates?: LifecycleState[];
	launchOutcome?: RestorationLaunchOutcome;
	stepMs?: number;
}): RunHarness {
	const launches: ArmedStreamConfig[] = [];
	const published: RestorationRunOutcome[] = [];
	const waits: number[] = [];
	const runtimeStates = [...(options.runtimeStates ?? ["idle"])];
	const lifecycleStates = [...(options.lifecycleStates ?? ["idle"])];
	const step = options.stepMs ?? 1_000;
	let clock = 0;

	return {
		launches,
		published,
		waits,
		deps: {
			marker: markerDeps(),
			runtimeState: async () =>
				(runtimeStates.length > 1
					? runtimeStates.shift()
					: runtimeStates[0]) as EngineRuntimeState,
			lifecycleState: () =>
				(lifecycleStates.length > 1
					? lifecycleStates.shift()
					: lifecycleStates[0]) as LifecycleState,
			launch: async (config) => {
				launches.push(config);
				return options.launchOutcome ?? { ok: true };
			},
			publish: (outcome) => published.push(outcome),
			wait: async (ms) => {
				waits.push(ms);
				clock += step;
			},
			now: () => clock,
			logger: { info: () => {}, warn: () => {} },
			pollIntervalMs: 1_000,
			unknownDeadlineMs: 10_000,
		},
	};
}

describe("the runner — adopt vs restore vs neither", () => {
	test("an idle engine with an armed marker restores EXACTLY once", async () => {
		plant();
		const h = harness({});
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome.result).toBe("recovered");
		expect(h.launches).toHaveLength(1);
		expect(h.launches[0]).toMatchObject(SAMPLE_CONFIG);
		expect(h.published).toEqual([{ result: "recovered", elapsedMs: 0 }]);
		expect(onDisk()?.attempt?.outcome).toBe("recovered");
	});

	test("a SECOND run can never retry — the terminal state is the one-shot", async () => {
		plant();
		const first = harness({});
		await runStreamRestoration(first.deps);
		const second = harness({});
		const outcome = await runStreamRestoration(second.deps);

		expect(outcome).toEqual({ result: "blocked", reason: "already_attempted" });
		expect(second.launches).toHaveLength(0);
	});

	test("a FAILED attempt is just as terminal as a successful one", async () => {
		plant();
		const first = harness({
			launchOutcome: { ok: false, reason: "start_failed" },
		});
		const failed = await runStreamRestoration(first.deps);
		expect(failed).toEqual({
			result: "failed",
			reason: "start_failed",
			elapsedMs: 0,
		});
		expect(onDisk()?.attempt).toMatchObject({
			outcome: "failed",
			reason: "start_failed",
		});

		const second = harness({});
		await runStreamRestoration(second.deps);
		expect(second.launches).toHaveLength(0);
	});

	test("a SUCCESSFUL restoration re-arms for the NEXT engine death (board-found)", async () => {
		// The restored session is a NEW commitment, and the orchestrator's outcome
		// gate arms a fresh marker for it. Retiring that fresh marker would leave a
		// live stream with no attempt left, so the SECOND crash of a long broadcast
		// would be unrecoverable. Measured on a board before this was fixed:
		// SIGKILL #1 restored in 11.5 s, #2 and #3 did nothing at all.
		plant();
		const h = harness({});
		const rearm = { ...h.deps };
		rearm.launch = async (config) => {
			h.launches.push(config);
			// What the real launch does: a committed start arms a fresh marker.
			armStreamRestoration({
				marker: markerDeps(),
				captureConfig: () => SAMPLE_CONFIG,
				now: () => 99_999,
			});
			return { ok: true };
		};

		expect((await runStreamRestoration(rearm)).result).toBe("recovered");

		const after = onDisk();
		expect(after?.armedAt).toBe(99_999);
		expect(after?.attempt).toBeUndefined();

		// …and the next engine death gets its own single attempt.
		const next = harness({});
		expect((await runStreamRestoration(next.deps)).result).toBe("recovered");
		expect(next.launches).toHaveLength(1);
	});

	test("a still-streaming engine is adopted and the marker is left ALONE", async () => {
		plant();
		const h = harness({ runtimeStates: ["streaming"] });
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome).toEqual({ result: "adopted" });
		expect(h.launches).toHaveLength(0);
		// No attempt is burned: the session never ended, so nothing was recovered
		// and nothing failed.
		expect(onDisk()?.attempt).toBeUndefined();
	});

	test("unknown that RESOLVES to idle inside the window restores", async () => {
		plant();
		const h = harness({
			runtimeStates: ["unknown", "unknown", "idle"],
		});
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome.result).toBe("recovered");
		expect(h.waits).toEqual([1_000, 1_000]);
		expect(h.launches).toHaveLength(1);
	});

	test("unknown that RESOLVES to streaming inside the window adopts", async () => {
		plant();
		const h = harness({ runtimeStates: ["unknown", "streaming"] });
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome).toEqual({ result: "adopted" });
		expect(h.launches).toHaveLength(0);
		expect(onDisk()?.attempt).toBeUndefined();
	});

	test("unknown for the WHOLE window is terminal, and does not re-arm later", async () => {
		plant();
		const h = harness({ runtimeStates: ["unknown"] });
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome).toMatchObject({
			result: "failed",
			reason: "runtime_state_unknown",
		});
		expect(h.launches).toHaveLength(0);
		expect(onDisk()?.attempt).toMatchObject({
			outcome: "failed",
			reason: "runtime_state_unknown",
		});

		const later = harness({});
		expect(await runStreamRestoration(later.deps)).toEqual({
			result: "blocked",
			reason: "already_attempted",
		});
		expect(later.launches).toHaveLength(0);
	});

	test("a restoration WAITS for an in-flight config change instead of racing it", async () => {
		plant();
		const h = harness({
			lifecycleStates: ["reconfiguring", "reconfiguring", "idle"],
		});
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome.result).toBe("recovered");
		expect(h.waits).toHaveLength(2);
		expect(h.launches).toHaveLength(1);
	});

	test("a boot_id mismatch launches nothing and retires the dead marker", async () => {
		plant({ bootId: BOOT_B });
		const h = harness({});
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome).toEqual({ result: "blocked", reason: "boot_id_mismatch" });
		expect(h.launches).toHaveLength(0);
		expect(fs.existsSync(markerPath)).toBe(false);
	});

	test("a planned shutdown launches nothing and burns no attempt", async () => {
		plant({ plannedShutdown: { reason: "software_update", at: 5 } });
		const h = harness({});
		const outcome = await runStreamRestoration(h.deps);

		expect(outcome).toEqual({ result: "blocked", reason: "planned_shutdown" });
		expect(h.launches).toHaveLength(0);
		expect(onDisk()?.attempt).toBeUndefined();
	});

	test("an operator stop before the engine dies means there is nothing to restore", async () => {
		plant();
		noteStreamStopped("operator", markerDeps());
		const h = harness({});

		expect(await runStreamRestoration(h.deps)).toEqual({
			result: "blocked",
			reason: "no_marker",
		});
		expect(h.launches).toHaveLength(0);
	});

	test("overlapping triggers JOIN one run rather than launching twice", async () => {
		plant();
		const h = harness({});
		const [a, b] = await Promise.all([
			runStreamRestoration(h.deps),
			runStreamRestoration(h.deps),
		]);

		expect(a).toEqual(b);
		expect(h.launches).toHaveLength(1);
	});

	test("the elapsed time is recorded against the declared bound, both ways", async () => {
		plant();
		const slow = harness({
			runtimeStates: ["unknown", "idle"],
			stepMs: 45_000,
		});
		await runStreamRestoration(slow.deps);

		const attempt = onDisk()?.attempt;
		expect(attempt?.elapsedMs).toBe(45_000);
		expect(attempt?.withinBound).toBe(false);
		expect(RESTORATION_BOUND_MS).toBe(30_000);
	});
});

describe("coexistence with the apply-now config-change marker (todo 14)", () => {
	test("neither marker reads or writes the other", async () => {
		const inflightPath = join(markerDir, "config.inflight.json");
		const inflight = JSON.stringify({
			attemptId: "att_x",
			startedAt: 1,
			candidate: { resolution: "1080p" },
			previous: { resolution: "720p" },
		});
		fs.writeFileSync(inflightPath, inflight);
		plant();

		const h = harness({});
		await runStreamRestoration(h.deps);

		expect(fs.readFileSync(inflightPath, "utf8")).toBe(inflight);
		expect(onDisk()?.attempt?.outcome).toBe("recovered");
	});

	test("an engine that died mid-transaction leaves BOTH, and both survive to be judged", () => {
		const inflightPath = join(markerDir, "config.inflight.json");
		fs.writeFileSync(inflightPath, "{}");
		plant();
		noteStreamStopped("engine_loss", markerDeps());

		expect(fs.existsSync(inflightPath)).toBe(true);
		expect(onDisk()).toBeDefined();
	});
});

describe("the orchestrator commit + stop seams", () => {
	function build(overrides: Record<string, unknown> = {}) {
		const armed: number[] = [];
		const stops: StreamStopCause[] = [];
		let streaming = false;
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "att_test",
			setStreamingStatus: (value) => {
				streaming = value;
			},
			getStreamingStatus: () => streaming,
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			onStreamArmed: () => armed.push(1),
			onStreamStopped: (cause) => stops.push(cause),
			...overrides,
		});
		return { orchestrator, armed, stops };
	}

	test("the marker is armed at the outcome gate, once per committed start", async () => {
		const h = build();
		await h.orchestrator.start({ origin: "ui", launch: async () => {} });
		expect(h.armed).toHaveLength(1);
	});

	test("a FAILED start arms nothing", async () => {
		const h = build();
		const result = await h.orchestrator.start({
			origin: "ui",
			launch: async () => {
				throw new Error("nope");
			},
		});
		expect(result.result).toBe("failed");
		expect(h.armed).toHaveLength(0);
	});

	test("ADOPTING an already-running session is not a new commitment", async () => {
		const h = build({ queryRuntime: async () => "streaming" });
		await h.orchestrator.reconcile();
		expect(h.orchestrator.snapshot().state).toBe("streaming");
		expect(h.armed).toHaveLength(0);
	});

	test("a restoration origin is admitted through the same mutex", async () => {
		const h = build();
		const result = await h.orchestrator.start({
			origin: "restoration",
			launch: async () => {},
		});
		expect(result.result).toBe("started");

		const second = await h.orchestrator.start({
			origin: "restoration",
			launch: async () => {},
		});
		expect(second.result).toBe("busy");
	});

	test("every stop reports its cause, including one parked behind a transaction", async () => {
		const h = build({
			changeRuntimeConfig: () => new Promise(() => {}),
			reconfigureDeadlineMs: 20,
			stopDeadlineMs: 10,
		});
		await h.orchestrator.start({ origin: "ui", launch: async () => {} });
		void h.orchestrator.changeConfig({ resolution: "720p" });
		const parked = h.orchestrator.stop("operator");

		expect(h.stops).toEqual(["operator"]);
		await parked;
		// The release replays the SAME cause; a parked operator stop must never
		// come back as something else.
		expect(new Set(h.stops)).toEqual(new Set(["operator"]));
	});

	test("a bookkeeping failure never turns a live stream into a failed start", async () => {
		const h = build({
			onStreamArmed: () => {
				throw new Error("disk full");
			},
		});
		const result = await h.orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});
		expect(result.result).toBe("started");
	});
});

describe("todo 22's retention slot is untouched by a restoration", () => {
	test("a restoration start still routes through the SAME idempotent commit hook", async () => {
		// The slot's own no-move guarantee is proven where it lives
		// (`lost-device-retention.test.ts` → "a restoration re-commit of the SAME
		// configuration NEVER moves the slot"). What matters here is that
		// restoration was not given a private commit path that could bypass it.
		const commits: string[] = [];
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: () => "att_test",
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			onStreamCommitted: () => commits.push("committed"),
		});
		await orchestrator.start({ origin: "restoration", launch: async () => {} });
		expect(commits).toEqual(["committed"]);
	});
});

describe("clearArmedStreamMarker", () => {
	test("clearing an absent marker is the desired end state, not an error", () => {
		expect(() => clearArmedStreamMarker(markerDeps())).not.toThrow();
	});

	test("a rewrite replaces the previous marker wholesale", () => {
		plant({
			attempt: { outcome: "failed", at: 1, elapsedMs: 1, withinBound: true },
		});
		writeArmedStreamMarker(
			{ armedAt: 9, bootId: BOOT_A, config: SAMPLE_CONFIG },
			markerDeps(),
		);
		expect(onDisk()?.attempt).toBeUndefined();
	});
});
