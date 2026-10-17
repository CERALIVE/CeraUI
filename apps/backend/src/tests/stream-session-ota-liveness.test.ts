import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearOtaStreamingMarker,
	setOtaStreamingMarker,
} from "../modules/streaming/ota-streaming-marker.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";

test("parked reconfiguration Stop retains the OTA marker until the engine stop settles", async () => {
	// Given a live stream with a pending engine configuration transaction.
	const change = Promise.withResolvers<{ readonly phase: "applied" }>();
	const engineStop = Promise.withResolvers<void>();
	let marked = false;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "parked-stop",
		setStreamingStatus: () => {},
		stopRuntime: () => engineStop.promise,
		queryRuntime: async () => "idle",
		changeRuntimeConfig: () => change.promise,
		markStreamingForOta: () => {
			marked = true;
		},
		unmarkStreamingForOta: () => {
			marked = false;
		},
	});
	await session.start({ origin: "ui", launch: async () => {} });
	const changing = session.changeConfig({ resolution: "1280x720" });
	// When Stop parks behind the configuration transaction.
	const stopping = session.stop("operator");
	try {
		expect(marked).toBe(true);
		change.resolve({ phase: "applied" });
		await changing;
		expect(marked).toBe(true);
		engineStop.resolve();
		await stopping;
		// Then only the acknowledged stop clears the sentinel.
		expect(marked).toBe(false);
	} finally {
		change.resolve({ phase: "applied" });
		engineStop.resolve();
		await Promise.all([changing, stopping]);
	}
});

test("unknown reconciliation and rejected Stop preserve physical OTA liveness", async () => {
	// Given a surviving marked stream whose engine becomes unobservable.
	let runtime: "streaming" | "unknown" = "streaming";
	let marked = false;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "unknown-stop",
		setStreamingStatus: () => {},
		stopRuntime: async () => {
			throw new Error("engine_stop_unknown");
		},
		queryRuntime: async () => runtime,
		markStreamingForOta: () => {
			marked = true;
		},
		unmarkStreamingForOta: () => {
			marked = false;
		},
	});
	await session.reconcile();
	runtime = "unknown";
	await session.reconcile();
	// When Stop cannot establish engine idle during reconciliation.
	const result = await session.stop("operator");
	// Then uncertain media stays guarded rather than becoming a false idle.
	expect(result).toEqual({
		result: "stop_failed",
		reason: "engine_stop_unknown",
	});
	expect(marked).toBe(true);
	expect(session.snapshot().state).toBe("reconciling");
});

test("OTA marker survives held and rejected stop until acknowledged idle", async () => {
	// Given a successful stream and the real existence-only OTA sentinel.
	const directory = await mkdtemp(join(tmpdir(), "ota-stop-"));
	const previous = process.env.CERALIVE_STREAMING_MARKER;
	const marker = join(directory, "streaming");
	process.env.CERALIVE_STREAMING_MARKER = marker;
	const stop = Promise.withResolvers<void>();
	let rejectStop = true;
	let live = false;
	let disarmed = false;
	const session = createStreamSessionOrchestrator({
		createAttemptId: () => "ota-stop",
		setStreamingStatus: (value) => {
			live = value;
		},
		stopRuntime: () => (rejectStop ? stop.promise : Promise.resolve()),
		queryRuntime: async () => "idle",
		onStreamStopped: () => {
			disarmed = true;
		},
		markStreamingForOta: setOtaStreamingMarker,
		unmarkStreamingForOta: clearOtaStreamingMarker,
	});
	try {
		await session.start({ origin: "ui", launch: async () => {} });
		// When stop is submitted but media acknowledgement is held, then rejected.
		const stopping = session.stop("operator");
		expect(disarmed).toBe(true);
		expect(existsSync(marker)).toBe(true);
		stop.reject(new Error("engine_stop_rejected"));
		expect(await stopping).toEqual({
			result: "stop_failed",
			reason: "engine_stop_rejected",
		});
		expect(live).toBe(true);
		expect(existsSync(marker)).toBe(true);
		// Then only a subsequent confirmed stop removes physical-liveness protection.
		rejectStop = false;
		expect(await session.stop("operator")).toEqual({ result: "stopped" });
		expect(existsSync(marker)).toBe(false);
	} finally {
		stop.resolve();
		if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
		else process.env.CERALIVE_STREAMING_MARKER = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test.each(["idle", "streaming"] as const)(
	"reconciliation synchronizes the OTA sentinel with confirmed %s",
	async (runtime) => {
		// Given a backend reconnect and the real marker in the opposite state.
		const directory = await mkdtemp(join(tmpdir(), "ota-reconcile-"));
		const previous = process.env.CERALIVE_STREAMING_MARKER;
		const marker = join(directory, "streaming");
		process.env.CERALIVE_STREAMING_MARKER = marker;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "ota-reconcile",
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => runtime,
			markStreamingForOta: setOtaStreamingMarker,
			unmarkStreamingForOta: clearOtaStreamingMarker,
		});
		try {
			if (runtime === "idle") setOtaStreamingMarker();
			// When the engine's authoritative runtime is adopted.
			expect(await session.reconcile()).toBe(runtime);
			// Then a surviving session is guarded and a confirmed idle one is not.
			expect(existsSync(marker)).toBe(runtime === "streaming");
		} finally {
			if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
			else process.env.CERALIVE_STREAMING_MARKER = previous;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
