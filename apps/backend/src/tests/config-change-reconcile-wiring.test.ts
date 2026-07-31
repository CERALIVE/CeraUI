/*
 * F11 — the crash-window reconciler is ARMED in production (device-platform-wave4
 * todo 14).
 *
 * Wave 3 todo 12 shipped `reconcileInflightConfigChange` and nothing called it.
 * `apps/backend/AGENTS.md` documented marker-only crash reconciliation as live
 * behaviour while the only importer was its own unit test, so a
 * `config.inflight.json` left by a process that died mid-transaction was never
 * judged: the staged candidate was lost and the marker file leaked forever.
 *
 * These cases drive the REAL writer (`reconcileInflightConfigChange`) and the
 * REAL `config.json` through the production wiring, against a REAL on-disk
 * marker in a temp dir. Two properties are load-bearing and are asserted from
 * both sides:
 *
 *   1. A marker present is reconciled — persist-candidate / retain-previous /
 *      honest defer, decided by the engine's own answer.
 *   2. NO marker means ZERO side effects. Not "writes nothing" — the engine is
 *      never even ASKED, because a bare params-vs-config mismatch is a
 *      legitimate apply-on-next-start the operator chose (the wave3 rule).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig } from "../modules/config.ts";
import {
	buildEngineEncodeSnapshot,
	type InflightReconcileDeps,
	runInflightConfigChangeReconciliation,
	settleInflightConfigChangeReconciliation,
} from "../modules/streaming/config-change-reconcile-wiring.ts";
import type {
	EngineEncodeSnapshot,
	InflightConfigMarker,
	StagingDeps,
} from "../modules/streaming/config-change-staging.ts";

let markerDir: string;
let markerPath: string;

function fileStagingDeps(): StagingDeps {
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
	};
}

function plantMarker(marker: InflightConfigMarker): void {
	fs.writeFileSync(markerPath, JSON.stringify(marker));
}

function markerOnDisk(): boolean {
	return fs.existsSync(markerPath);
}

const MARKER: InflightConfigMarker = {
	attemptId: "wave4-t14",
	startedAt: 1,
	candidate: { resolution: "2160p", framerate: 30 },
	previous: { resolution: "1080p", framerate: 30 },
};

/**
 * Test harness: the production runner with a scripted engine and an instant
 * clock, so the bounded poll is exercised without real time passing.
 */
function harness(
	snapshots: ReadonlyArray<EngineEncodeSnapshot | undefined>,
): Partial<InflightReconcileDeps> & {
	asked: number;
	info: string[];
	warn: string[];
} {
	const box = {
		asked: 0,
		staging: fileStagingDeps(),
		snapshot: (): EngineEncodeSnapshot | undefined => {
			const next = snapshots[Math.min(box.asked, snapshots.length - 1)];
			box.asked += 1;
			return next;
		},
		wait: async (): Promise<void> => {},
		pollIntervalMs: 1,
		deadlineMs: 5,
		info: [] as string[],
		warn: [] as string[],
		logger: {
			info: (m: string) => {
				box.info.push(m);
			},
			warn: (m: string) => {
				box.warn.push(m);
			},
		},
	};
	return box;
}

describe("F11 — crash-window reconciliation is wired into production", () => {
	let priorResolution: ReturnType<typeof getConfig>["resolution"];
	let priorFramerate: ReturnType<typeof getConfig>["framerate"];

	beforeEach(() => {
		markerDir = mkdtempSync(join(tmpdir(), "ceraui-inflight-"));
		markerPath = join(markerDir, "config.inflight.json");
		const config = getConfig();
		priorResolution = config.resolution;
		priorFramerate = config.framerate;
		config.resolution = "1080p";
		config.framerate = 30;
	});

	afterEach(() => {
		const config = getConfig();
		config.resolution = priorResolution;
		config.framerate = priorFramerate;
		rmSync(markerDir, { recursive: true, force: true });
	});

	test("NO marker ⇒ no_marker, and the engine is never even asked", async () => {
		// Given a device that simply booted with an apply-on-next-start intent on
		// disk and no in-flight marker at all.
		const h = harness([
			{
				streaming: true,
				resolution: "1080p",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 900,
			},
		]);
		getConfig().resolution = "2160p";

		// When the boot hook runs.
		const verdict = await runInflightConfigChangeReconciliation(h);

		// Then nothing is reconciled AND nothing was even inspected — the operator's
		// stated intent survives every boot, untouched.
		expect(verdict).toBe("no_marker");
		expect(h.asked).toBe(0);
		expect(getConfig().resolution).toBe("2160p");
		expect(markerOnDisk()).toBe(false);
	});

	test("marker + engine live on the CANDIDATE ⇒ the lost write is completed", async () => {
		// Given a crash between the engine's `applied` and the config write.
		plantMarker(MARKER);

		// When the engine is found live on the candidate, frames advancing.
		const verdict = await runInflightConfigChangeReconciliation(
			harness([
				{
					streaming: true,
					resolution: "3840x2160",
					framerate: 30,
					pipelinePlaying: true,
					framesEmitted: 900,
				},
			]),
		);

		// Then disk catches up with what the engine is actually running, and the
		// marker is retired.
		expect(verdict).toBe("persisted_candidate");
		expect(getConfig().resolution).toBe("2160p");
		expect(markerOnDisk()).toBe(false);
	});

	test("marker + engine IDLE ⇒ the old values are retained and the marker retired", async () => {
		// Given the same crash, but the transaction never took and the engine is idle.
		plantMarker(MARKER);

		// When reconciliation runs.
		const h = harness([{ streaming: false }]);
		const verdict = await runInflightConfigChangeReconciliation(h);

		// Then the operator's last WORKING config is what boots next time.
		expect(verdict).toBe("retained_previous");
		expect(getConfig().resolution).toBe("1080p");
		expect(markerOnDisk()).toBe(false);

		// …and it is announced at `warn`, because the production console transport
		// sits at `warn`: measured on a board, an `info` reconciliation left the
		// journal — and therefore the in-app Logs download — completely silent
		// about a config write made on the operator's behalf.
		expect(h.warn).toContain(
			"config-change in-flight marker found — reconciling",
		);
		expect(h.info).toEqual([]);
	});

	test("an engine that is undecided AT FIRST is re-asked, then reconciled", async () => {
		// Given a boot where the engine session has not settled yet (the raw
		// liveness feed has delivered no frame), then settles on the candidate.
		plantMarker(MARKER);

		// When the bounded poll runs.
		const verdict = await runInflightConfigChangeReconciliation(
			harness([
				undefined,
				undefined,
				{
					streaming: true,
					resolution: "3840x2160",
					framerate: 30,
					pipelinePlaying: true,
					framesEmitted: 900,
				},
			]),
		);

		// Then the later, decisive answer is the one that counts.
		expect(verdict).toBe("persisted_candidate");
		expect(getConfig().resolution).toBe("2160p");
	});

	test("an engine that NEVER decides ⇒ deferred, nothing written, marker KEPT", async () => {
		// Given an engine that stays unreachable/transitional for the whole window.
		plantMarker(MARKER);

		// When the bounded poll expires.
		const verdict = await runInflightConfigChangeReconciliation(
			harness([undefined]),
		);

		// Then guessing is refused — and the marker survives for the next reconnect.
		expect(verdict).toBe("deferred");
		expect(getConfig().resolution).toBe("1080p");
		expect(markerOnDisk()).toBe(true);
	});

	test("running it AGAIN after a decisive verdict cannot double-apply", async () => {
		// Given a reconciliation that already persisted the candidate.
		plantMarker(MARKER);
		await runInflightConfigChangeReconciliation(
			harness([
				{
					streaming: true,
					resolution: "3840x2160",
					framerate: 30,
					pipelinePlaying: true,
					framesEmitted: 900,
				},
			]),
		);
		// …and an operator who has since chosen something else.
		getConfig().resolution = "720p";

		// When the engine-reconnect hook fires the SAME wiring again.
		const h = harness([
			{
				streaming: true,
				resolution: "3840x2160",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 900,
			},
		]);
		const verdict = await runInflightConfigChangeReconciliation(h);

		// Then it is a no-op: the marker is gone, so nothing is re-applied.
		expect(verdict).toBe("no_marker");
		expect(h.asked).toBe(0);
		expect(getConfig().resolution).toBe("720p");
	});

	test("overlapping runs (reconnect firing repeatedly) share ONE reconciliation", async () => {
		// Given a marker and two hooks racing (boot + an engine-reconnect heal).
		plantMarker(MARKER);
		const first = harness([
			undefined,
			{
				streaming: true,
				resolution: "3840x2160",
				framerate: 30,
				pipelinePlaying: true,
				framesEmitted: 900,
			},
		]);
		const second = harness([{ streaming: false }]);

		// When both are started before either settles.
		const a = runInflightConfigChangeReconciliation(first);
		const b = runInflightConfigChangeReconciliation(second);
		const [verdictA, verdictB] = await Promise.all([a, b]);

		// Then the second joined the first rather than judging in parallel — one
		// verdict, one write, and the loser's engine was never consulted.
		expect(verdictA).toBe("persisted_candidate");
		expect(verdictB).toBe(verdictA);
		expect(second.asked).toBe(0);
		expect(getConfig().resolution).toBe("2160p");
		await settleInflightConfigChangeReconciliation();
	});
});

describe("both production seams actually call it", () => {
	// F11 was not a logic bug — the logic was correct and simply unreachable. So
	// the regression lock has to be on the CALL SITES, which no behavioural test
	// of the reconciler itself can cover.
	const readSource = (relative: string): string =>
		fs.readFileSync(join(import.meta.dir, "..", relative), "utf8");

	test("the boot path arms it once the config and engine session are consistent", () => {
		const source = readSource("main.ts");
		const armed = source.indexOf(
			"void runInflightConfigChangeReconciliation()",
		);
		expect(armed).toBeGreaterThan(-1);
		// It must sit AFTER the engine session is reconciled — before that, the
		// lifecycle is `reconciling` and every judgement would defer.
		expect(source.indexOf("await reconcileStreamSession()")).toBeLessThan(
			armed,
		);
	});

	test("the engine-reconnect heal re-arms it", () => {
		const source = readSource("modules/streaming/engine-reconnect.ts");
		expect(
			source.includes("void runInflightConfigChangeReconciliation()"),
		).toBe(true);
	});
});

describe("the production engine snapshot speaks CONFIG space, not engine space", () => {
	test("a live session is normalized out of pixels and fractional rates", () => {
		// Given the engine reporting its own vocabulary.
		const snapshot = buildEngineEncodeSnapshot({
			lifecycle: () => "streaming",
			activeEncode: () => ({
				codec: "h265",
				resolution: "1920x1080",
				framerate: 29.97,
				active_input: "/dev/video0",
			}),
			liveness: () => ({ pipelinePlaying: true, framesEmitted: 120 }),
		});

		// Then the judge is handed values it can compare with `config.json`.
		expect(snapshot).toEqual({
			streaming: true,
			resolution: "1080p",
			framerate: 29.97,
			codec: "h265",
			activeInput: "/dev/video0",
			pipelinePlaying: true,
			framesEmitted: 120,
		});
	});

	test("an IDLE lifecycle is decisive; every other non-streaming state is not", () => {
		const idle = buildEngineEncodeSnapshot({
			lifecycle: () => "idle",
			activeEncode: () => null,
			liveness: () => undefined,
		});
		expect(idle).toEqual({ streaming: false });

		// `reconciling` means the engine has NOT answered — asserting "not
		// streaming" there would retain the old values off a non-answer.
		for (const state of ["reconciling", "starting", "stopping"] as const) {
			expect(
				buildEngineEncodeSnapshot({
					lifecycle: () => state,
					activeEncode: () => null,
					liveness: () => undefined,
				}),
			).toBeUndefined();
		}
	});

	test("a streaming engine with no reported encode is UNDECIDED, never idle", () => {
		expect(
			buildEngineEncodeSnapshot({
				lifecycle: () => "streaming",
				activeEncode: () => null,
				liveness: () => undefined,
			}),
		).toBeUndefined();
	});
});
