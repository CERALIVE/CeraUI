import { expect, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import { abortAptTransferForStream } from "../modules/system/apt-transfer-abort.ts";
import { setAptTransportDepsForTest } from "../modules/system/apt-transport.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as liveness from "../modules/system/stream-liveness-source.ts";
import { stopPackageInstallUnitForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { FETCH_FAILURE, sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const { t, install } = aptEntryHarness();
const ranked = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];

test("owns cancellation before the asynchronous update check continuation", async () => {
	// Given an admitted install waiting for its check callback.
	await withDeviceType("real", async () => {
		const { h, run } = await install(ranked);
		await using _h = h;
		// When a stream is admitted and ends before that continuation resumes.
		abortAptTransferForStream();
		await run();
		// Then the original admission cannot start a later archive download.
		expect(t.commands.filter(({ argv }) => argv[1] === "-d")).toEqual([]);
	});
});

test.each([false, true])(
	"latches stream admission during preflight even when idle returns (%s)",
	async (live) => {
		// Given stream admission occurs before the fetch controller registers.
		await withDeviceType("real", async () => {
			const { h, run } = await install(ranked);
			await using _h = h;
			spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
				exitCode: 0,
				stdout: "",
				stderr: "",
			});
			h.beforeClean = async () => {
				await stopPackageInstallUnitForStream();
				if (live)
					spyOn(liveness, "isStreamConfirmedIdle").mockReturnValue(false);
			};
			// When install resumes after disk preflight.
			await run();
			// Then no archive fetch starts, including after a transient stream.
			expect(t.commands.filter(({ argv }) => argv[1] === "-d")).toEqual([]);
		});
	},
);

test("latches cancellation while transport selection is pending", async () => {
	// Given the selector observes a stream admission before returning.
	await withDeviceType("real", async () => {
		const { h, pins, run } = await install(ranked);
		await using _h = h;
		setAptTransportDepsForTest({
			pin: pins.pin,
			ownership: pins.ownership,
			select: async () => {
				abortAptTransferForStream();
				return rankTransports(ranked);
			},
		});
		// When that selection resumes into the install continuation.
		await run();
		// Then the earlier admission remains cancelled without an active child.
		expect(t.commands.filter(({ argv }) => argv[1] === "-d")).toEqual([]);
	});
});

test("rechecks stream authority synchronously before a transfer retry", async () => {
	// Given the first transfer fails after stream liveness changed without the abort effect.
	await withDeviceType("real", async () => {
		const { h, run } = await install(ranked);
		await using _h = h;
		let attempts = 0;
		t.download = async () => {
			attempts++;
			spyOn(liveness, "isStreamConfirmedIdle").mockReturnValue(false);
			return FETCH_FAILURE;
		};
		// When failover considers another family.
		await run();
		// Then no second archive fetch starts under the stale earlier idle observation.
		expect(attempts).toBe(1);
	});
});
