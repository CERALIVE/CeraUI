import { expect, test } from "bun:test";
import {
	SpawnAbortError,
	SpawnTimeoutError,
} from "../helpers/bounded-spawn.ts";
import { abortAptTransferForStream } from "../modules/system/apt-transfer-abort.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { aptEntryHarness } from "./helpers/apt-transport-entry-harness.ts";
import { sample } from "./helpers/apt-transport-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const { t, install } = aptEntryHarness();
const ranked = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];

test("real APT boundary preserves timeout provenance and fails over", async () => {
	// Given the bounded APT runner times out on IPv6 without an apt stderr signature.
	await withDeviceType("real", async () => {
		const { h, pins, run } = await install(ranked);
		await using _h = h;
		let attempts = 0;
		t.download = async () => {
			if (++attempts === 1)
				throw new SpawnTimeoutError(
					"apt-get -d",
					"partial archive",
					"timeout details",
				);
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		// When the real runAptCommand catch handles that timeout.
		await run();
		// Then the next pair is tried and the shared fifteen-minute hold applies.
		expect(attempts).toBe(2);
		expect(pins.pin.unhealthyUntil("eth0", 6)).toBe(901000);
	});
});

test("exhausted bounded timeouts preserve partial APT output", async () => {
	// Given every attempted transfer times out with partial diagnostics.
	await withDeviceType("real", async () => {
		const { h, launches, run } = await install(ranked);
		await using _h = h;
		t.download = async () => {
			throw new SpawnTimeoutError(
				"apt-get -d",
				"Get:1 partial",
				"partial transfer detail",
			);
		};
		// When all healthy pairs are exhausted through runAptCommand.
		await run();
		// Then the existing failure path keeps the diagnostic and never starts dpkg.
		expect(launches).toEqual([]);
		expect(updates.getUpdateState()).toMatchObject({
			kind: "failed",
			reason: "partial transfer detail",
		});
	});
});

test.each([false, true])(
	"does not retry a stream abort even when shaped as a timeout (%s)",
	async (signalAbort) => {
		// Given cancellation shares the bounded runner's timeout superclass.
		await withDeviceType("real", async () => {
			const { h, launches, run } = await install(ranked);
			await using _h = h;
			let attempts = 0;
			t.download = async () => {
				attempts++;
				if (signalAbort) abortAptTransferForStream();
				throw signalAbort
					? new SpawnTimeoutError("apt-get -d")
					: new SpawnAbortError("apt-get -d");
			};
			// When the APT boundary reports the terminated run.
			await run();
			// Then neither another transfer nor commit is admitted.
			expect(attempts).toBe(1);
			expect(launches).toEqual([]);
			expect(updates.getUpdateState().kind).not.toBe("failed");
		});
	},
);

test("never retries local APT lock failure containing timeout-like words", async () => {
	// Given a local apt failure is not a bounded-runner timeout or fetch failure.
	await withDeviceType("real", async () => {
		const { h, pins, run } = await install(ranked);
		await using _h = h;
		let attempts = 0;
		t.download = async () => {
			attempts++;
			return {
				exitCode: 100,
				stdout: "",
				stderr: "E: Could not get lock; timed out",
			};
		};
		// When apt returns the local failure.
		await run();
		// Then the pair is not suppressed and no retry occurs.
		expect(attempts).toBe(1);
		expect(pins.pin.unhealthyUntil("eth0", 6)).toBeUndefined();
	});
});
