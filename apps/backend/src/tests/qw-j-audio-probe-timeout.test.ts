import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
	AudioProbeTimeoutError,
	asrcProbe,
	clearAsrcProbeReject,
	isAsrcProbeRejectResolved,
} from "../modules/streaming/audio.ts";
import { AUDIO_PROBE_TIMEOUT_MS } from "../modules/streaming/constants.ts";
import * as notifications from "../modules/ui/notifications.ts";

describe("QW-J: Audio Device Probe Timeout", () => {
	afterEach(() => {
		clearAsrcProbeReject();
	});

	describe("AudioProbeTimeoutError", () => {
		it("should have correct error name and device property", () => {
			const err = new AudioProbeTimeoutError("missing-device");

			expect(err.name).toBe("AudioProbeTimeoutError");
			expect(err.device).toBe("missing-device");
			expect(err.message).toContain("missing-device");
			expect(err.message).toContain(String(AUDIO_PROBE_TIMEOUT_MS));
			expect(err instanceof Error).toBe(true);
		});

		it("should include timeout duration in error message", () => {
			const err = new AudioProbeTimeoutError("test-device");
			expect(err.message).toContain(`${AUDIO_PROBE_TIMEOUT_MS}ms`);
		});
	});

	describe("asrcProbe timeout behavior", () => {
		it("should timeout after AUDIO_PROBE_TIMEOUT_MS when device never appears", async () => {
			// Use fake timers to avoid actual 15s wait
			const originalSetTimeout = global.setTimeout;
			const originalClearTimeout = global.clearTimeout;
			let _currentTime = 0;
			const timers: Array<{ id: number; delay: number; callback: () => void }> =
				[];
			let nextId = 1;

			global.setTimeout = ((callback: () => void, delay?: number) => {
				const id = nextId++;
				timers.push({ id, delay: delay ?? 0, callback });
				return id as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout;

			global.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
				const idx = timers.findIndex((t) => t.id === (id as unknown as number));
				if (idx >= 0) timers.splice(idx, 1);
			}) as typeof clearTimeout;

			const nonExistentDevice = "nonexistent-audio-device-xyz";
			const probePromise = asrcProbe(nonExistentDevice);

			// Advance time past the timeout
			_currentTime = AUDIO_PROBE_TIMEOUT_MS + 100;
			const timeoutTimer = timers.find(
				(t) => t.delay === AUDIO_PROBE_TIMEOUT_MS,
			);
			if (timeoutTimer) {
				timeoutTimer.callback();
			}

			try {
				await probePromise;
				expect.unreachable("Should have thrown AudioProbeTimeoutError");
			} catch (err) {
				expect(err instanceof AudioProbeTimeoutError).toBe(true);
				if (err instanceof AudioProbeTimeoutError) {
					expect(err.device).toBe(nonExistentDevice);
				}
			} finally {
				global.setTimeout = originalSetTimeout;
				global.clearTimeout = originalClearTimeout;
			}
		});

		it("should resolve immediately if device already exists", async () => {
			// Use a device that should exist in the audioDevices map
			const result = await asrcProbe("No audio");
			expect(result).toBe("No audio");
		});

		it("should reject with structured error naming the missing device", async () => {
			// Use fake timers
			const originalSetTimeout = global.setTimeout;
			const originalClearTimeout = global.clearTimeout;
			const timers: Array<{ id: number; delay: number; callback: () => void }> =
				[];
			let nextId = 1;

			global.setTimeout = ((callback: () => void, delay?: number) => {
				const id = nextId++;
				timers.push({ id, delay: delay ?? 0, callback });
				return id as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout;

			global.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
				const idx = timers.findIndex((t) => t.id === (id as unknown as number));
				if (idx >= 0) timers.splice(idx, 1);
			}) as typeof clearTimeout;

			const missingDevice = "missing-device-qw-j-test";
			const probePromise = asrcProbe(missingDevice);

			// Trigger the timeout
			const timeoutTimer = timers.find(
				(t) => t.delay === AUDIO_PROBE_TIMEOUT_MS,
			);
			if (timeoutTimer) {
				timeoutTimer.callback();
			}

			try {
				await probePromise;
				expect.unreachable("Should have thrown");
			} catch (err) {
				expect(err instanceof AudioProbeTimeoutError).toBe(true);
				if (err instanceof AudioProbeTimeoutError) {
					expect(err.device).toBe(missingDevice);
					expect(err.message).toContain(missingDevice);
				}
			} finally {
				global.setTimeout = originalSetTimeout;
				global.clearTimeout = originalClearTimeout;
			}
		});

		it("should leave the next probe alone once it was cancelled, and name the probed device", async () => {
			const originalSetTimeout = global.setTimeout;
			const originalClearTimeout = global.clearTimeout;
			const timers = new Map<number, () => void>();
			let nextId = 1;
			global.setTimeout = ((callback: () => void) => {
				timers.set(nextId, callback);
				return nextId++ as unknown as ReturnType<typeof setTimeout>;
			}) as typeof setTimeout;
			global.clearTimeout = ((id: number) => {
				timers.delete(id);
			}) as unknown as typeof clearTimeout;
			const broadcast = spyOn(
				notifications,
				"notificationBroadcast",
			).mockImplementation((() => {}) as never);

			try {
				const refusal = (probe: Promise<string>) =>
					probe.then(
						() => "resolved",
						(error: Error) => error.message,
					);
				const cancelled = refusal(asrcProbe("first-microphone"));
				const ofCancelled = [...timers.keys()];
				const next = refusal(asrcProbe("second-microphone"));
				expect(await cancelled).toContain("first-microphone");
				const named = broadcast.mock.calls.map(([, , message]) => message);
				expect(named[0]).toContain("'first-microphone'");
				expect(named.at(-1)).toContain("'second-microphone'");

				for (const id of ofCancelled) timers.get(id)?.();
				await Promise.resolve();
				expect(isAsrcProbeRejectResolved()).toBe(true);
				expect(broadcast.mock.calls.length).toBe(named.length);

				clearAsrcProbeReject();
				expect(await next).toContain("second-microphone");
				expect(isAsrcProbeRejectResolved()).toBe(false);
				expect(timers.size).toBe(0);
			} finally {
				broadcast.mockRestore();
				global.setTimeout = originalSetTimeout;
				global.clearTimeout = originalClearTimeout;
			}
		});
	});
});
