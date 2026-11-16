import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_CHANGE_REASON_REJECTED } from "@ceraui/rpc/schemas";
import { getConfig, setConfigFilePath } from "../modules/config.ts";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import {
	readInflightMarker,
	releaseStagedConfigChange,
} from "../modules/streaming/config-change-staging.ts";
import { getSourceSelectionTokens } from "../modules/streaming/sources.ts";
import type { EngineConfigChangeOutcome } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	SECOND_CAMERA,
	SECOND_STABLE,
	sourceSelectionFixture,
} from "./helpers/applied-source-selection.ts";

test("recovery commits the selected camera identity from the staged operator snapshot", async () => {
	const f = await sourceSelectionFixture();
	// Identity recovery requires no changed mode that the snapshot cannot measure.
	await f.write({ input_mode: "uvc_h264" });
	await f.start();
	const asked = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<EngineConfigChangeOutcome>();
	f.setChange(() => {
		asked.resolve();
		return answer.promise;
	});
	const request = f.write({
		source: "video2",
		input_mode: "uvc_h264",
		apply_now: true,
	});
	await asked.promise;
	const before = getSourceSelectionTokens().selection;
	releaseStagedConfigChange();
	// A later discovery now assigns the same node to an unrelated camera.
	f.devices.splice(1, 1, { ...SECOND_CAMERA, stable_id: "usb:unrelated" });
	try {
		const verdict = reconcileInflightConfigChange({
			streaming: true,
			activeInput: "video2",
			pipelinePlaying: true,
			framesEmitted: 50,
		});

		expect(verdict).toBe("persisted_candidate");
		expect((await f.read()).source_stable_id).toBe(SECOND_STABLE);
		expect(getSourceSelectionTokens().selection).toBe(before + 1);
		expect(readInflightMarker()).toBeUndefined();
	} finally {
		answer.resolve({
			phase: "reverted",
			reason: CONFIG_CHANGE_REASON_REJECTED,
		});
		await request;
	}
});

for (const activeInput of [undefined, "video1"]) {
	test(`recovery keeps a non-capture clear undecided with live input ${activeInput ?? "unknown"}`, async () => {
		const f = await sourceSelectionFixture();
		await f.start();
		const asked = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<EngineConfigChangeOutcome>();
		f.setChange(() => {
			asked.resolve();
			return answer.promise;
		});
		const request = f.write({ source: "test", apply_now: true });
		await asked.promise;
		const marker = await f.marker();
		const saved = await f.read();
		const before = getSourceSelectionTokens();
		releaseStagedConfigChange();
		try {
			const verdict = reconcileInflightConfigChange({
				streaming: true,
				...(activeInput === undefined ? {} : { activeInput }),
				pipelinePlaying: true,
				framesEmitted: 50,
			});

			expect(verdict).toBe("deferred");
			expect(await f.read()).toEqual(saved);
			expect(await f.marker()).toBe(marker);
			expect(getSourceSelectionTokens()).toEqual(before);
		} finally {
			answer.resolve({
				phase: "reverted",
				reason: CONFIG_CHANGE_REASON_REJECTED,
			});
			await request;
		}
	});
}

test("recovery on the previous capture input retains its metadata", async () => {
	const f = await sourceSelectionFixture();
	await f.write({ input_mode: "uvc_h264" });
	await f.start();
	const asked = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<EngineConfigChangeOutcome>();
	f.setChange(() => {
		asked.resolve();
		return answer.promise;
	});
	const request = f.write({
		source: "video2",
		input_mode: "uvc_h264",
		apply_now: true,
	});
	await asked.promise;
	const saved = await f.read();
	const before = getSourceSelectionTokens();
	releaseStagedConfigChange();
	try {
		const verdict = reconcileInflightConfigChange({
			streaming: true,
			activeInput: "video1",
			pipelinePlaying: true,
			framesEmitted: 50,
		});

		expect(verdict).toBe("retained_previous");
		expect(await f.read()).toEqual(saved);
		expect(getSourceSelectionTokens()).toEqual(before);
		expect(readInflightMarker()).toBeUndefined();
	} finally {
		answer.resolve({
			phase: "reverted",
			reason: CONFIG_CHANGE_REASON_REJECTED,
		});
		await request;
	}
});

test("legacy omitted selection metadata remains unknown during recovery", async () => {
	const f = await sourceSelectionFixture();
	const before = getSourceSelectionTokens();
	await writeFile(
		join(f.dir, "config.inflight.json"),
		JSON.stringify({
			attemptId: "legacy",
			startedAt: 1,
			candidate: { resolution: "720p" },
			previous: { resolution: "1080p", selected_video_input: "video1" },
		}),
	);

	expect(
		reconcileInflightConfigChange({
			streaming: true,
			resolution: "720p",
			activeInput: "video1",
			pipelinePlaying: true,
			framesEmitted: 50,
		}),
	).toBe("persisted_candidate");

	expect(await f.read()).toMatchObject(f.originalSelection);
	expect(getSourceSelectionTokens()).toEqual(before);
});

test("an applied source whose file write fails retains complete recovery metadata", async () => {
	const f = await sourceSelectionFixture();
	await f.write({ input_mode: "uvc_h264" });
	await f.start();
	f.setChange(async () => {
		setConfigFilePath(join(f.dir, "missing", "config.json"));
		return { phase: "applied" };
	});

	await expect(
		f.write({
			source: "video2",
			input_mode: "uvc_h264",
			apply_now: true,
		}),
	).rejects.toThrow();
	setConfigFilePath(join(f.dir, "config.json"));
	const before = getSourceSelectionTokens().selection;
	expect(readInflightMarker()).toBeDefined();
	expect(getConfig().source_stable_id).toBe(SECOND_STABLE);

	expect(
		reconcileInflightConfigChange({
			streaming: true,
			activeInput: "video2",
			pipelinePlaying: true,
			framesEmitted: 50,
		}),
	).toBe("persisted_candidate");
	expect(await f.read()).toMatchObject({
		source: "video2",
		selected_video_input: "video2",
		source_stable_id: SECOND_STABLE,
	});
	expect(getSourceSelectionTokens().selection).toBe(before + 1);
	expect(readInflightMarker()).toBeUndefined();
});
