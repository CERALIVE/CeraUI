import { expect, test } from "bun:test";
import {
	type ListDevicesResult,
	listDevicesResultSchema,
} from "@ceralive/cerastream";
import { CONFIG_CHANGE_REASON_REJECTED } from "@ceraui/rpc/schemas";
import { getConfig } from "../modules/config.ts";
import {
	configuredSelectionAnchor,
	getSourceSelectionTokens,
	reconcileConfiguredSourceIdentity,
	resolveSourceRouting,
	tryRefreshEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import type { EngineConfigChangeOutcome } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	SECOND_CAMERA,
	SECOND_STABLE,
	sourceSelectionFixture,
} from "./helpers/applied-source-selection.ts";

test("an applied camera selection reroutes to the newly selected physical device", async () => {
	const f = await sourceSelectionFixture();
	await f.start();

	const result = await f.write({ source: "video2", apply_now: true });
	const saved = await f.read();

	expect(result.configChange?.result).toBe("applied");
	expect(saved.source).toBe("video2");
	expect(saved.selected_video_input).toBe("video2");
	// Exercise the actual persisted-selection caller before checking the anchor.
	expect(
		resolveSourceRouting(
			saved.source ?? "",
			f.sources(),
			saved.last_seen_devices,
			configuredSelectionAnchor(saved.source ?? ""),
		),
	).toEqual({
		ok: true,
		pipeline: "libuvch264",
		selected_video_input: "video2",
	});
	expect(saved.source_stable_id).toBe(SECOND_STABLE);
	expect(result.applied?.selected_video_input).toBe("video2");
});

test("an applied non-capture selection clears the saved capture input and anchor", async () => {
	const f = await sourceSelectionFixture();
	await f.start();

	const result = await f.write({ source: "test", apply_now: true });
	const saved = await f.read();

	expect(result.configChange?.result).toBe("applied");
	expect(saved.source).toBe("test");
	expect(saved.selected_video_input).toBeUndefined();
	expect(saved.source_stable_id).toBeUndefined();
	expect(result.applied?.selected_video_input).toBeUndefined();
	expect(f.deltas).toEqual([{ pipeline: "test", input_id: null }]);
	expect(
		resolveSourceRouting(
			"test",
			f.sources(),
			saved.last_seen_devices,
			configuredSelectionAnchor("test"),
		),
	).toEqual({ ok: true, pipeline: "test", selected_video_input: undefined });
});

test("an applied unidentified camera clears the previous identity without clearing its capture input", async () => {
	const f = await sourceSelectionFixture();
	f.devices.splice(1, 1, { ...SECOND_CAMERA, stable_id: undefined });
	await f.start();

	const result = await f.write({ source: "video2", apply_now: true });

	expect(result.configChange?.result).toBe("applied");
	expect((await f.read()).source).toBe("video2");
	expect((await f.read()).selected_video_input).toBe("video2");
	expect((await f.read()).source_stable_id).toBeUndefined();
	expect(f.deltas).toEqual([{ input_id: "video2", pipeline: "libuvch264" }]);
});

for (const source of ["video2", "test"]) {
	test(`a reverted selection of ${source} preserves the original capture metadata and token`, async () => {
		const f = await sourceSelectionFixture();
		await f.start();
		f.setChange(async () => ({
			phase: "reverted",
			reason: CONFIG_CHANGE_REASON_REJECTED,
		}));
		const before = getSourceSelectionTokens();
		const savedBefore = await f.read();

		const result = await f.write({ source, apply_now: true });

		expect(result.configChange?.result).toBe("reverted");
		expect(await f.read()).toEqual(savedBefore);
		expect(getSourceSelectionTokens()).toEqual(before);
	});

	test(`a busy selection of ${source} preserves change A's marker and original selection`, async () => {
		const f = await sourceSelectionFixture();
		await f.start();
		const asked = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<EngineConfigChangeOutcome>();
		f.setChange(() => {
			asked.resolve();
			return answer.promise;
		});
		const first = f.write({ source: "video2", apply_now: true });
		await asked.promise;
		const marker = await f.marker();
		const before = getSourceSelectionTokens();
		const savedBefore = await f.read();
		try {
			const result = await f.write({ source, apply_now: true });

			expect(result.configChange).toEqual({ result: "busy" });
			expect(await f.read()).toEqual(savedBefore);
			expect(await f.marker()).toBe(marker);
			expect(getSourceSelectionTokens()).toEqual(before);
		} finally {
			answer.resolve({
				phase: "reverted",
				reason: CONFIG_CHANGE_REASON_REJECTED,
			});
			await first;
		}
	});
}

test("an applied source write fences a device probe dispatched before the operator's selection", async () => {
	const f = await sourceSelectionFixture();
	await f.start();
	const probe = Promise.withResolvers<ListDevicesResult>();
	const refresh = tryRefreshEngineDeviceCache({
		fetchEngineDevices: () => probe.promise,
	});
	const before = getSourceSelectionTokens().selection;

	await f.write({ source: "video2", apply_now: true });
	probe.resolve(listDevicesResultSchema.parse({ devices: f.devices }));
	await refresh;

	expect(getSourceSelectionTokens()).toEqual({
		selection: before + 1,
		engineView: before,
	});
	expect(reconcileConfiguredSourceIdentity(f.sources())).toBe(false);
	expect(getConfig().source).toBe("video2");
});

for (const apply_now of [false, true]) {
	test(`an idle non-capture save clears capture metadata with apply_now=${apply_now}`, async () => {
		const f = await sourceSelectionFixture();
		const before = getSourceSelectionTokens().selection;

		const result = await f.write({ source: "test", apply_now });

		expect(result.success).toBe(true);
		expect(result.configChange).toBeUndefined();
		expect(await f.read()).toMatchObject({ source: "test", pipeline: "test" });
		expect((await f.read()).selected_video_input).toBeUndefined();
		expect((await f.read()).source_stable_id).toBeUndefined();
		expect(getSourceSelectionTokens().selection).toBe(before + 1);
		expect(f.deltas).toEqual([]);
	});
}
