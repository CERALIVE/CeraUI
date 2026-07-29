import { beforeEach, describe, expect, test } from "bun:test";

import {
	clearStagedConfigChange,
	type EngineEncodeSnapshot,
	getStagedConfigChange,
	type InflightConfigMarker,
	judgeInflightMarker,
	readInflightMarker,
	type StagingDeps,
	stageConfigChange,
} from "../modules/streaming/config-change-staging.ts";

function memoryDeps(): StagingDeps & { file: () => string | undefined } {
	let contents: string | undefined;
	return {
		markerPath: "config.inflight.json",
		readMarker: () => contents,
		writeMarker: (_path, next) => {
			contents = next;
		},
		removeMarker: () => {
			contents = undefined;
		},
		file: () => contents,
	};
}

function marker(
	overrides: Partial<InflightConfigMarker> = {},
): InflightConfigMarker {
	return {
		attemptId: "attempt-1",
		startedAt: 1_700_000_000_000,
		candidate: { resolution: "3840x2160", framerate: 30 },
		previous: { resolution: "1920x1080", framerate: 30 },
		...overrides,
	};
}

const liveOn = (
	resolution: string,
	extra: Partial<EngineEncodeSnapshot> = {},
): EngineEncodeSnapshot => ({
	streaming: true,
	resolution,
	framerate: 30,
	pipelinePlaying: true,
	framesEmitted: 120,
	...extra,
});

describe("staging holds the candidate off disk", () => {
	let deps: ReturnType<typeof memoryDeps>;
	beforeEach(() => {
		deps = memoryDeps();
		clearStagedConfigChange(deps);
	});

	test("stage records the candidate in memory AND writes the marker", () => {
		// When an apply-now change is staged.
		stageConfigChange(marker(), deps);

		// Then both halves exist — memory drives this transaction, the marker
		// survives a crash.
		expect(getStagedConfigChange()?.attemptId).toBe("attempt-1");
		expect(readInflightMarker(deps)?.candidate.resolution).toBe("3840x2160");
	});

	test("clearing removes both halves", () => {
		// Given a staged change.
		stageConfigChange(marker(), deps);

		// When it is cleared.
		clearStagedConfigChange(deps);

		// Then nothing remains to reconcile on the next boot.
		expect(getStagedConfigChange()).toBeUndefined();
		expect(readInflightMarker(deps)).toBeUndefined();
		expect(deps.file()).toBeUndefined();
	});

	test("an unreadable marker is discarded rather than trusted", () => {
		// Given a corrupt marker on disk.
		deps.writeMarker(deps.markerPath, "{not json");

		// When it is read.
		const read = readInflightMarker(deps);

		// Then it is dropped, not parsed into a half-formed reconciliation.
		expect(read).toBeUndefined();
		expect(deps.file()).toBeUndefined();
	});
});

describe("crash-window reconciliation is MARKER-ONLY", () => {
	test("no marker ⇒ no verdict at all, whatever the engine reports", () => {
		// Given an apply-on-next-start mismatch and NO marker: the engine runs
		// 1080p while config.json already holds the operator's 2160p intent.
		const deps = memoryDeps();

		// When reconciliation reads the marker.
		const read = readInflightMarker(deps);

		// Then there is nothing to judge — the operator's intent survives untouched.
		expect(read).toBeUndefined();
	});

	test("marker present + engine on the CANDIDATE + gate satisfied ⇒ persist", () => {
		// Given the engine is live on the candidate geometry with frames advancing.
		const verdict = judgeInflightMarker(marker(), liveOn("3840x2160"));

		// Then the change did land before the crash and is persisted.
		expect(verdict).toEqual({ action: "persist_candidate" });
	});

	test("marker present + engine on the PREVIOUS params ⇒ retain the old values", () => {
		// Given the engine is live on the pre-change geometry.
		const verdict = judgeInflightMarker(marker(), liveOn("1920x1080"));

		// Then the change did not survive and disk is left as it was.
		expect(verdict).toEqual({ action: "retain_previous" });
	});

	test("marker present + engine IDLE ⇒ retain the old values", () => {
		// Given the engine is not streaming at all.
		const verdict = judgeInflightMarker(marker(), { streaming: false });

		// Then nothing proves the candidate ran, so the old values stand.
		expect(verdict).toEqual({ action: "retain_previous" });
	});

	test("gate NOT satisfied (no frames) ⇒ write nothing, keep the marker", () => {
		// Given the engine is PLAYING on the candidate but has emitted no frames —
		// the exact case `applied` is defined to exclude.
		const verdict = judgeInflightMarker(
			marker(),
			liveOn("3840x2160", { framesEmitted: 0 }),
		);

		// Then the verdict defers rather than claiming success.
		expect(verdict).toEqual({ action: "wait" });
	});

	test("pipeline not playing ⇒ write nothing, keep the marker", () => {
		const verdict = judgeInflightMarker(
			marker(),
			liveOn("3840x2160", { pipelinePlaying: false }),
		);
		expect(verdict).toEqual({ action: "wait" });
	});

	test("an unreachable engine ⇒ write nothing, keep the marker", () => {
		// Given no engine answer at all.
		const verdict = judgeInflightMarker(marker(), undefined);

		// Then reconciliation is deferred to the next reconnect.
		expect(verdict).toEqual({ action: "wait" });
	});

	test("engine on params matching NEITHER side ⇒ write nothing", () => {
		// Given a third geometry (an operator restart with different settings).
		const verdict = judgeInflightMarker(marker(), liveOn("1280x720"));

		// Then neither branch is provable, so nothing is written.
		expect(verdict).toEqual({ action: "wait" });
	});

	test("a source-only change is judged on the active input, not geometry", () => {
		// Given a change that only swaps the capture device.
		const sourceMarker = marker({
			candidate: { selected_video_input: "/dev/video2" },
			previous: { selected_video_input: "/dev/video0" },
		});

		// Then the engine's active input decides both directions.
		expect(
			judgeInflightMarker(
				sourceMarker,
				liveOn("1920x1080", { activeInput: "/dev/video2" }),
			),
		).toEqual({ action: "persist_candidate" });
		expect(
			judgeInflightMarker(
				sourceMarker,
				liveOn("1920x1080", { activeInput: "/dev/video0" }),
			),
		).toEqual({ action: "retain_previous" });
	});
});
