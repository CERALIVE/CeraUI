import { expect, test } from "bun:test";
import type { ChangeConfigResult } from "@ceralive/cerastream";
import { CONFIG_CHANGE_REASON_REJECTED } from "@ceraui/rpc/schemas";
import { getCapabilities } from "../modules/streaming/capabilities.ts";
import { getSourceSelectionTokens } from "../modules/streaming/sources.ts";
import { SECOND_STABLE } from "./helpers/applied-source-selection.ts";
import { captureSelectionFixture } from "./helpers/capture-selection-clears.ts";

async function afterNextStartSourceSave() {
	const f = await captureSelectionFixture();
	const startedMode = f.selection().input_mode;
	expect(startedMode).toBe("mjpeg");
	await f.start();

	const saved = await f.write({ source: "video2" });

	expect(saved.success).toBe(true);
	expect(saved.configChange).toBeUndefined();
	expect(f.wire).toEqual([]);
	expect(f.selection()).toEqual({
		source: "video2",
		pipeline: "libuvch264",
		input_mode: undefined,
		selected_video_input: "video2",
		source_stable_id: SECOND_STABLE,
	});
	expect((await f.read()).input_mode).toBeUndefined();
	return { ...f, startedMode };
}

for (const phase of ["applied", "reverted"] as const) {
	test(`${phase} automatic source apply after a next-start save sends the retained mode clear`, async () => {
		const f = await afterNextStartSourceSave();
		let liveMode = f.startedMode;
		f.setAnswer(async () => {
			if (phase === "applied") {
				// Producer merge_delta retains omission, replaces concrete values and
				// clears null; its capture resolver gives an explicit mode precedence.
				const delta = f.wire.at(-1);
				if (delta?.input_mode !== undefined)
					liveMode = delta.input_mode ?? undefined;
			}
			return {
				attempt_id: "engine-selection",
				phase,
				state: "streaming",
				...(phase === "reverted"
					? { reason: CONFIG_CHANGE_REASON_REJECTED }
					: {}),
			};
		});
		const bytes = await f.bytes();
		const tokens = getSourceSelectionTokens();

		const result = await f.write({ source: "video2", apply_now: true });

		expect(liveMode).toBe(phase === "applied" ? undefined : "mjpeg");
		expect(f.wire).toEqual([
			{ input_id: "video2", pipeline: "libuvch264", input_mode: null },
		]);
		expect(result.configChange?.result).toBe(phase);
		expect((await f.read()).input_mode).toBeUndefined();
		expect((await f.read()).source_stable_id).toBe(SECOND_STABLE);
		expect(await Bun.file(`${f.dir}/config.inflight.json`).exists()).toBe(
			false,
		);
		if (phase === "reverted") {
			expect(await f.bytes()).toBe(bytes);
			expect(getSourceSelectionTokens()).toEqual(tokens);
		}
	});
}

for (const evidence of ["older", "missing", "cached"] as const) {
	test(`${evidence} engine evidence refuses an automatic apply after a next-start save without writing`, async () => {
		const f = await afterNextStartSourceSave();
		if (evidence === "older") await f.negotiate(["input-mode"]);
		else if (evidence === "missing") await f.negotiate(undefined);
		else
			await getCapabilities({
				fetchEngineCapabilities: async () => {
					throw new Error("engine unavailable");
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			});
		const bytes = await f.bytes();
		const tokens = getSourceSelectionTokens();

		const result = await f.write({
			source: "video2",
			max_br: 9876,
			apply_now: true,
		});

		expect(result.success).toBe(false);
		expect(result.configChange).toEqual({
			result: "rejected",
			reason: "change_config_unsupported",
		});
		expect(f.wire).toEqual([]);
		expect(await f.bytes()).toBe(bytes);
		expect(getSourceSelectionTokens()).toEqual(tokens);
		expect(await Bun.file(`${f.dir}/config.inflight.json`).exists()).toBe(
			false,
		);
	});
}

test("busy automatic apply after a next-start save preserves the admitted marker and config bytes", async () => {
	const f = await afterNextStartSourceSave();
	const asked = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<ChangeConfigResult>();
	f.setAnswer(() => {
		asked.resolve();
		return answer.promise;
	});
	const first = f.write({ resolution: "1080p", apply_now: true });
	await asked.promise;
	const marker = await f.marker();
	const bytes = await f.bytes();
	const tokens = getSourceSelectionTokens();
	try {
		const result = await f.write({ source: "video2", apply_now: true });

		expect(result.configChange).toEqual({ result: "busy" });
		expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
		expect(await f.marker()).toBe(marker);
		expect(await f.bytes()).toBe(bytes);
		expect(getSourceSelectionTokens()).toEqual(tokens);
	} finally {
		answer.resolve({
			attempt_id: "engine-selection",
			phase: "reverted",
			state: "streaming",
		});
		await first;
	}
});

test("unrelated apply after a next-start source save omits the retained mode clear", async () => {
	const f = await afterNextStartSourceSave();
	await f.negotiate([]);

	const result = await f.write({ resolution: "1080p", apply_now: true });

	expect(result.configChange?.result).toBe("applied");
	expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
	expect((await f.read()).input_mode).toBeUndefined();
});

test("concrete mode after a next-start source save replaces the live mode without clear support", async () => {
	const f = await afterNextStartSourceSave();
	await f.negotiate([]);

	const result = await f.write({
		source: "video2",
		input_mode: "uvc_h264",
		apply_now: true,
	});

	expect(result.configChange?.result).toBe("applied");
	expect(f.wire).toEqual([
		{ input_id: "video2", pipeline: "libuvch264", input_mode: "uvc_h264" },
	]);
	expect((await f.read()).input_mode).toBe("uvc_h264");
});
