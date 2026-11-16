import { expect, test } from "bun:test";
import { CAPTURE_SELECTION_CLEAR_FEATURE } from "@ceralive/cerastream";
import {
	getCapabilities,
	getLastCapabilities,
} from "../modules/streaming/capabilities.ts";
import { supportsCaptureSelectionClear } from "../modules/streaming/config-change-bridge.ts";
import { getSourceSelectionTokens } from "../modules/streaming/sources.ts";
import { captureEngineLifecycle } from "./helpers/capture-engine-lifecycle.ts";

async function readCurrentCapabilities(
	f: Awaited<ReturnType<typeof captureEngineLifecycle>>,
): Promise<void> {
	const client = f.currentClient();
	if (client === undefined) throw new Error("missing current session client");
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: await client.getCapabilities(),
			schemaVersion: client.hello.schema_version,
		}),
		fetchEngineDevices: () => client.listDevices(),
	});
}

for (const features of [undefined, [], ["input-mode"]]) {
	test(`a replacement engine advertising ${JSON.stringify(features)} cannot borrow the prior engine's clear support`, async () => {
		const f = await captureEngineLifecycle();
		expect((await f.start()).result).toBe("started");
		await f.replace(features);
		expect((await f.start()).result).toBe("started");
		const bytes = await f.bytes();
		const tokens = getSourceSelectionTokens();

		const result = await f.write({
			source: "video2",
			max_br: 9876,
			apply_now: true,
		});

		expect(result.configChange).toEqual({
			result: "rejected",
			reason: "change_config_unsupported",
		});
		expect(await f.bytes()).toBe(bytes);
		expect(await Bun.file(`${f.dir}/config.inflight.json`).exists()).toBe(
			false,
		);
		expect(f.current().wire).toEqual([]);
		expect(f.current().capabilityReads).toBe(1);
		expect(getSourceSelectionTokens()).toEqual(tokens);
	});
}

test("proven session connection loss invalidates clear authorization before replacement START", async () => {
	const f = await captureEngineLifecycle();
	await f.start();
	await readCurrentCapabilities(f);
	expect(supportsCaptureSelectionClear()).toBe(true);

	await f.replace([]);

	expect(getLastCapabilities()?.engineUnavailable).toBe(true);
	expect(supportsCaptureSelectionClear()).toBe(false);
});

test("a capable replacement is authorized after its own capabilities are read", async () => {
	const f = await captureEngineLifecycle([]);
	await f.start();
	await f.replace([CAPTURE_SELECTION_CLEAR_FEATURE]);
	expect((await f.start()).result).toBe("started");

	const result = await f.write({ source: "video2", apply_now: true });

	expect(result.configChange?.result).toBe("applied");
	expect(f.current().capabilityReads).toBe(1);
	expect(f.current().wire).toEqual([
		{ input_id: "video2", pipeline: "libuvch264", input_mode: null },
	]);
	expect((await f.read()).input_mode).toBeUndefined();
	expect((await f.read()).source_stable_id).toBe("usb:second-camera");
});

test("an older replacement refuses a clear without retiring its running geometry attempt", async () => {
	const f = await captureEngineLifecycle();
	await f.start();
	await f.replace([]);
	await f.start();
	const held = f.holdNextChange();
	const first = f.write({ resolution: "1080p", apply_now: true });
	await held.asked.promise;
	const marker = await f.marker();
	const bytes = await f.bytes();
	const tokens = getSourceSelectionTokens();
	try {
		const result = await f.write({ source: "test", apply_now: true });

		expect(result.configChange).toEqual({
			result: "rejected",
			reason: "change_config_unsupported",
		});
		expect(await f.bytes()).toBe(bytes);
		expect(await f.marker()).toBe(marker);
		expect(getSourceSelectionTokens()).toEqual(tokens);
		expect(f.current().wire).toEqual([{ resolution: "1920x1080" }]);
	} finally {
		held.answer.resolve();
		await first;
	}
});

for (const staleReadFails of [false, true]) {
	test(`a superseded ${staleReadFails ? "failed" : "successful"} capability read cannot replace current engine evidence`, async () => {
		const f = await captureEngineLifecycle();
		await f.start();
		const probe = await f.dial();
		const observed = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const staleRead = getCapabilities({
			fetchEngineCapabilities: async () => {
				if (staleReadFails) {
					observed.resolve();
					await resume.promise;
				}
				return {
					caps: await probe.getCapabilities(),
					schemaVersion: probe.hello.schema_version,
				};
			},
			fetchEngineDevices: async () => {
				const devices = await probe.listDevices();
				observed.resolve();
				await resume.promise;
				return devices;
			},
		});
		await observed.promise;
		try {
			await f.replace(staleReadFails ? [CAPTURE_SELECTION_CLEAR_FEATURE] : []);
			await f.start();
			await readCurrentCapabilities(f);
			resume.resolve();
			await staleRead;
			expect(getLastCapabilities()?.engineUnavailable).toBe(false);
			expect(getLastCapabilities()?.features).toEqual(
				staleReadFails ? [CAPTURE_SELECTION_CLEAR_FEATURE] : [],
			);
			const bytes = await f.bytes();

			const result = await f.write({ source: "video2", apply_now: true });

			expect(result.configChange?.result).toBe(
				staleReadFails ? "applied" : "rejected",
			);
			expect(f.current().wire).toEqual(
				staleReadFails
					? [{ input_id: "video2", pipeline: "libuvch264", input_mode: null }]
					: [],
			);
			if (!staleReadFails) expect(await f.bytes()).toBe(bytes);
		} finally {
			resume.resolve();
			await staleRead;
		}
	});
}
