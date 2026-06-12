import { afterEach, describe, expect, it } from "bun:test";

import {
	AudioProbeTimeoutError,
	asrcProbe,
	clearAsrcProbeReject,
} from "../modules/streaming/audio.ts";
import { AUDIO_PROBE_TIMEOUT_MS } from "../modules/streaming/constants.ts";

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
				return id as any;
			}) as any;

			global.clearTimeout = ((id: number) => {
				const idx = timers.findIndex((t) => t.id === id);
				if (idx >= 0) timers.splice(idx, 1);
			}) as any;

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
				return id as any;
			}) as any;

			global.clearTimeout = ((id: number) => {
				const idx = timers.findIndex((t) => t.id === id);
				if (idx >= 0) timers.splice(idx, 1);
			}) as any;

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
	});
});
