import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmedStreamMarkerDeps } from "../modules/streaming/armed-stream-marker.ts";
import {
	bindStreamLiveness,
	streamLiveness,
} from "../modules/streaming/stream-liveness.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import { flushEvidence } from "./helpers/stream-engine-evidence.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let marker = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness>;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2-idle-"));
	marker = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = marker;
});
afterEach(async () => {
	await h?.dispose();
	bindStreamLiveness(() => "unknown");
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});
function boot() {
	h = idleProductionHarness(directory);
	bindStreamLiveness(h.session.streamLiveness);
	return h;
}
async function silentProbe() {
	const probe = h.session.reconcile();
	await h.expireProbe();
	return await probe;
}

test("S1 fresh silent boot admits Start and leaf grants update idle", async () => {
	boot();
	expect(await silentProbe()).toBe("idle");
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
	expect(h.calls().filter((call) => call === "stop")).toHaveLength(0);
});

test("S2 acknowledged Stop then silent reconcile retains idle and admits Start", async () => {
	boot();
	await h.start();
	expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
	expect(await silentProbe()).toBe("idle");
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
});

test("S3 engine loss Stop then production restoration relaunches a silent engine", async () => {
	boot();
	await h.start();
	h.engine.setEngine("idle");
	expect(await h.session.stop("engine_loss")).toEqual({ result: "stopped" });
	const armed = join(directory, "armed.json");
	const bootId = "11111111-1111-4111-8111-111111111111";
	writeFileSync(
		armed,
		JSON.stringify({ armedAt: 1, bootId, config: { pipeline: "hdmi" } }),
	);
	const markerDeps: ArmedStreamMarkerDeps = {
		markerPath: armed,
		readBootId: () => bootId,
		readMarker: (path) => readFileSync(path, "utf8"),
		writeMarker: (path, text) => writeFileSync(path, text),
		removeMarker: (path) => rmSync(path, { force: true }),
	};
	let now = 0;
	const restoring = runStreamRestoration({
		marker: markerDeps,
		awaitRecovery: async () => undefined,
		runtimeState: async () =>
			(await silentProbe()) === "idle" ? "idle" : "unknown",
		lifecycleState: () => h.session.snapshot().state,
		launch: async () =>
			(await h.start()).result === "started"
				? { ok: true }
				: { ok: false, reason: "start_failed" },
		publish: () => undefined,
		now: () => now,
		wait: async () => {
			now += 100;
		},
		unknownDeadlineMs: 100,
	});
	expect(await restoring).toMatchObject({ result: "recovered" });
	expect(h.view().launches).toBe(2);
});

test("S4 operator Stop during held Start leaves idle without a blind second Stop", async () => {
	boot();
	const connect = Promise.withResolvers<void>();
	h.engine.holdConnect(connect.promise);
	const start = h.start();
	await h.engine.connected;
	expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
	connect.resolve();
	await h.expireProbe();
	expect(await start).toMatchObject({ result: "cancelled" });
	expect(h.engine.clients[0]?.calls).not.toContain("start");
	expect(h.calls().filter((call) => call === "stop")).toHaveLength(1);
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
});

test("S5 protected silence refuses Start and leaf update grant until production Stop acknowledges", async () => {
	writeFileSync(marker, "");
	boot();
	const start = h.start();
	await h.expireProbe();
	expect(await start).toMatchObject({ result: "busy" });
	expect(streamLiveness()).toBe("unknown");
	expect(h.calls()).not.toContain("stop");
	const stop = h.session.stop("operator");
	await h.expireProbe();
	expect(await stop).toEqual({ result: "stopped" });
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
	expect(await h.start()).toMatchObject({ result: "started" });
});

test("S4 dispatched cancellation carries operator cause into affirmative final Stop", async () => {
	boot();
	const startReply = Promise.withResolvers<void>();
	h.engine.holdStart(startReply.promise);
	const start = h.start();
	await h.engine.started;
	expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
	startReply.resolve();
	await h.expireProbe();
	expect(await start).toMatchObject({ result: "cancelled" });
	expect(streamLiveness()).toBe("idle");
	expect(h.calls().filter((call) => call === "stop")).toHaveLength(2);
	expect(existsSync(marker)).toBe(false);
});

for (const evidence of ["stop", "status"] as const) {
	test(`S6 failed clearance stays unknown and next ${evidence} retries`, async () => {
		boot();
		await h.start();
		rmSync(marker);
		mkdirSync(marker);
		writeFileSync(join(marker, "obstruction"), "x");
		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
		expect(existsSync(marker)).toBe(true);
		expect(streamLiveness()).toBe("unknown");
		expect(await h.start()).toMatchObject({ result: "busy" });
		rmSync(marker, { recursive: true });
		writeFileSync(marker, "");
		if (evidence === "stop") {
			const stop = h.session.stop("operator");
			await h.expireProbe();
			await stop;
		} else {
			h.session.noteEngineStatus({
				type: "status",
				seq: 2,
				state: "idle",
				streaming: false,
			});
		}
		expect(existsSync(marker)).toBe(false);
		expect(streamLiveness()).toBe("idle");
	});
}

test("S7 adopted backend session continues receiving later idle status", async () => {
	writeFileSync(marker, "");
	boot();
	h.engine.setEngine("streaming");
	const probe = h.session.reconcile();
	await flushEvidence();
	h.engine.status(0, true);
	await probe;
	expect(streamLiveness()).toBe("streaming");
	h.engine.status(0, false);
	expect(streamLiveness()).toBe("idle");
	expect(existsSync(marker)).toBe(false);
});

for (const probe of ["silent", "connect-failed"] as const) {
	test(`S8 ${probe} non-adopting probe preserves launched subscription`, async () => {
		boot();
		await h.start();
		if (probe === "connect-failed") h.engine.failNextConnect();
		const observing = h.engine.backend.reconcileRuntimeState();
		if (probe === "silent") await h.expireProbe();
		expect(await observing).toBe("unknown");
		h.engine.status(0, false);
		expect(streamLiveness()).toBe("idle");
		expect(existsSync(marker)).toBe(false);
	});
}

test("N4 current streaming status retries failed sentinel write", async () => {
	boot();
	process.env.CERALIVE_STREAMING_MARKER = join(directory, "late", "streaming");
	await h.start();
	expect(streamLiveness()).toBe("unknown");
	mkdirSync(join(directory, "late"));
	h.engine.status(0, true);
	expect(streamLiveness()).toBe("streaming");
	expect(existsSync(process.env.CERALIVE_STREAMING_MARKER)).toBe(true);
});

const evidenceMatrix = [
	{ baseline: "fresh", event: "silence", expected: "idle", present: false },
	{ baseline: "stopped", event: "silence", expected: "idle", present: false },
	{
		baseline: "protected",
		event: "silence",
		expected: "unknown",
		present: true,
	},
	{
		baseline: "protected",
		event: "operator-stop",
		expected: "idle",
		present: false,
	},
	{
		baseline: "launched",
		event: "unused-probe-idle",
		expected: "idle",
		present: false,
	},
	{
		baseline: "blocked-clear",
		event: "operator-stop",
		expected: "unknown",
		present: true,
	},
	{
		baseline: "blocked-clear",
		event: "repair-status",
		expected: "idle",
		present: false,
	},
	{
		baseline: "failed-write",
		event: "repair-status",
		expected: "streaming",
		present: true,
	},
	{
		baseline: "fresh",
		event: "operator-cancel",
		expected: "idle",
		present: false,
	},
	{
		baseline: "fresh",
		event: "late-sentinel",
		expected: "idle",
		present: false,
	},
	{
		baseline: "fresh",
		event: "contradictory-status",
		expected: "unknown",
		present: true,
	},
] as const;

for (const row of evidenceMatrix)
	test(`S9 independent evidence matrix ${row.baseline} x ${row.event}`, async () => {
		// Given literal contract outcomes, not expectations calculated by ownership guards.
		if (row.baseline === "protected") writeFileSync(marker, "");
		boot();
		if (row.baseline === "failed-write") {
			marker = join(directory, "late", "streaming");
			process.env.CERALIVE_STREAMING_MARKER = marker;
		}
		if (!["fresh", "protected"].includes(row.baseline)) await h.start();
		if (row.baseline === "stopped") await h.session.stop("operator");
		if (row.baseline === "blocked-clear") {
			rmSync(marker);
			mkdirSync(marker);
			writeFileSync(join(marker, "x"), "x");
			await h.session.stop("operator");
		}
		// When current wire evidence or its absence crosses the production path.
		switch (row.event) {
			case "silence":
				await silentProbe();
				break;
			case "operator-stop": {
				const stop = h.session.stop("operator");
				await h.expireProbe();
				await stop;
				break;
			}
			case "unused-probe-idle": {
				const probe = h.engine.backend.reconcileRuntimeState();
				await h.expireProbe();
				await probe;
				h.engine.status(0, false);
				break;
			}
			case "operator-cancel": {
				const connect = Promise.withResolvers<void>();
				h.engine.holdConnect(connect.promise);
				const start = h.start();
				await h.engine.connected;
				await h.session.stop("operator");
				connect.resolve();
				await h.expireProbe();
				await start;
				expect(h.calls().filter((call) => call === "stop")).toHaveLength(1);
				break;
			}
			case "late-sentinel": {
				writeFileSync(marker, "");
				expect(streamLiveness()).toBe("unknown");
				expect(await h.start()).toMatchObject({ result: "busy" });
				const stop = h.session.stop("operator");
				await h.expireProbe();
				await stop;
				expect(h.calls().filter((call) => call === "stop")).toHaveLength(1);
				break;
			}
			case "contradictory-status": {
				const probe = h.session.reconcile();
				await flushEvidence();
				h.engine.clients[0]?.emit({
					type: "status",
					seq: 1,
					state: "streaming",
					streaming: false,
				});
				await h.expireProbe();
				await probe;
				break;
			}
			case "repair-status":
				if (row.baseline === "failed-write") {
					mkdirSync(join(directory, "late"));
					h.engine.status(0, true);
				} else {
					rmSync(marker, { recursive: true });
					writeFileSync(marker, "");
					h.session.noteEngineStatus({
						type: "status",
						seq: 2,
						state: "idle",
						streaming: false,
					});
				}
				break;
		}
		// Then every cell has independently specified liveness and physical evidence.
		if (row.expected === "unknown")
			expect(h.session.snapshot().state).toBe("reconciling");
		expect(streamLiveness()).toBe(row.expected);
		expect(existsSync(marker)).toBe(row.present);
	});
