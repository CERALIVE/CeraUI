import { expect, test } from "bun:test";
import type {
	ChangeConfigParams,
	ChangeConfigResult,
} from "@ceralive/cerastream";
import { CONFIG_CHANGE_REASON_REJECTED } from "@ceraui/rpc/schemas";
import { getConfig } from "../modules/config.ts";
import { getCapabilities } from "../modules/streaming/capabilities.ts";
import { getSourceSelectionTokens } from "../modules/streaming/sources.ts";
import { SECOND_STABLE } from "./helpers/applied-source-selection.ts";
import { captureSelectionFixture } from "./helpers/capture-selection-clears.ts";

const destinations = [
	{
		source: "video2",
		pipeline: "libuvch264",
		input: "video2",
		anchor: SECOND_STABLE,
	},
	{ source: "test", pipeline: "test", input: undefined, anchor: undefined },
	{ source: "rtmp", pipeline: "rtmp", input: undefined, anchor: undefined },
	{ source: "srt", pipeline: "srt", input: undefined, anchor: undefined },
] as const;

for (const target of destinations) {
	const delta: ChangeConfigParams = {
		pipeline: target.pipeline,
		input_id: target.input ?? null,
		input_mode: null,
	};
	for (const phase of ["applied", "reverted"] as const) {
		test(`${phase} camera-to-${target.source} keeps wire clears and saved selection equivalent`, async () => {
			const f = await captureSelectionFixture();
			await f.start();
			f.setAnswer(async () => ({
				attempt_id: "engine-selection",
				phase,
				state: "streaming",
				...(phase === "reverted"
					? { reason: CONFIG_CHANGE_REASON_REJECTED }
					: {}),
			}));
			const before = await f.read();
			const tokens = getSourceSelectionTokens();

			const result = await f.write({ source: target.source, apply_now: true });
			const saved = await f.read();

			expect(f.wire).toEqual([delta]);
			expect(result.configChange?.result).toBe(phase);
			if (phase === "reverted") {
				expect(saved).toEqual(before);
				expect(getSourceSelectionTokens()).toEqual(tokens);
			} else {
				expect(f.selection()).toEqual({
					source: target.source,
					pipeline: target.pipeline,
					input_mode: undefined,
					selected_video_input: target.input,
					source_stable_id: target.anchor,
				});
				expect(saved.source).toBe(target.source);
				expect(saved.pipeline).toBe(target.pipeline);
				expect(saved.input_mode).toBeUndefined();
				expect(saved.selected_video_input).toBe(target.input);
				expect(saved.source_stable_id).toBe(target.anchor);
			}
		});
	}

	test(`busy camera-to-${target.source} leaves the admitted marker and config bytes untouched`, async () => {
		const f = await captureSelectionFixture();
		await f.start();
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
			const result = await f.write({ source: target.source, apply_now: true });

			expect(result.configChange).toEqual({ result: "busy" });
			expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
			expect(await f.bytes()).toBe(bytes);
			expect(await f.marker()).toBe(marker);
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

	test(`an older engine refuses camera-to-${target.source} before any saved field or marker changes`, async () => {
		const f = await captureSelectionFixture();
		await f.start();
		await f.negotiate(["input-mode"]);
		const bytes = await f.bytes();
		const tokens = getSourceSelectionTokens();

		const result = await f.write({
			source: target.source,
			max_br: 9876,
			apply_now: true,
		});

		expect(result).toEqual({
			success: false,
			applied: { relay_protocol: "srtla" },
			configChange: { result: "rejected", reason: "change_config_unsupported" },
		});
		expect(f.wire).toEqual([]);
		expect(await f.bytes()).toBe(bytes);
		expect(await Bun.file(`${f.dir}/config.inflight.json`).exists()).toBe(
			false,
		);
		expect(getSourceSelectionTokens()).toEqual(tokens);
	});
}

test("an unsupported overlapping clear cannot retire another attempt's marker", async () => {
	const f = await captureSelectionFixture();
	await f.start();
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
	await f.negotiate([]);
	try {
		const result = await f.write({ source: "test", apply_now: true });
		expect(result.configChange).toEqual({
			result: "rejected",
			reason: "change_config_unsupported",
		});
		expect(await f.marker()).toBe(marker);
		expect(await f.bytes()).toBe(bytes);
		expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
	} finally {
		answer.resolve({
			attempt_id: "engine-selection",
			phase: "reverted",
			state: "streaming",
		});
		await first;
	}
});

for (const freshness of ["missing", "cached"] as const) {
	test(`a ${freshness} capability answer cannot authorize a clear`, async () => {
		const f = await captureSelectionFixture();
		await f.start();
		if (freshness === "missing") await f.negotiate(undefined);
		else
			await getCapabilities({
				fetchEngineCapabilities: async () => {
					throw new Error("engine unavailable");
				},
				fetchEngineDevices: async () => ({ devices: [] }),
			});
		const bytes = await f.bytes();

		const result = await f.write({ source: "test", apply_now: true });

		expect(result.configChange).toEqual({
			result: "rejected",
			reason: "change_config_unsupported",
		});
		expect(f.wire).toEqual([]);
		expect(await f.bytes()).toBe(bytes);
	});
}

test("an explicit destination mode replaces the prior mode without requiring clear support", async () => {
	const f = await captureSelectionFixture();
	await f.start();
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
	expect((await f.read()).source_stable_id).toBe(SECOND_STABLE);
});

test("an unrelated same-device live save does not pin the automatic mode or send a clear", async () => {
	const f = await captureSelectionFixture();
	getConfig().input_mode = undefined;
	await f.write({ source: "video1" });
	await f.start();
	await f.negotiate([]);

	const result = await f.write({ resolution: "1080p", apply_now: true });

	expect(result.configChange?.result).toBe("applied");
	expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
	expect((await f.read()).input_mode).toBeUndefined();
});

test("a legacy absent mode stays absent during a supported camera switch", async () => {
	const f = await captureSelectionFixture();
	getConfig().input_mode = undefined;
	await f.write({ source: "video1" });
	await f.start();

	await f.write({ source: "video2", apply_now: true });

	expect(f.wire).toEqual([{ input_id: "video2", pipeline: "libuvch264" }]);
	expect((await f.read()).input_mode).toBeUndefined();
});

test("a same-device unrelated change retains its explicit mode without a nullable delta", async () => {
	const f = await captureSelectionFixture();
	await f.start();
	await f.negotiate([]);
	await f.write({ resolution: "1080p", apply_now: true });
	expect(f.wire).toEqual([{ resolution: "1920x1080" }]);
	expect((await f.read()).input_mode).toBe("mjpeg");
});

test("capture through non-capture back to capture never resurrects the old explicit mode", async () => {
	const f = await captureSelectionFixture();
	await f.start();
	await f.write({ source: "test", apply_now: true });
	await f.write({ source: "video2", apply_now: true });

	expect(f.wire).toEqual([
		{ input_id: null, pipeline: "test", input_mode: null },
		{ input_id: "video2", pipeline: "libuvch264" },
	]);
	expect((await f.read()).input_mode).toBeUndefined();
	expect((await f.read()).source_stable_id).toBe(SECOND_STABLE);
});
