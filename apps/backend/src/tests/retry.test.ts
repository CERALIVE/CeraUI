import { describe, expect, it } from "bun:test";
import { pollWithBackoff, retryWithBackoff } from "../helpers/retry.ts";

describe("retryWithBackoff", () => {
	it("should call fn exactly 3 times when it fails twice then succeeds", async () => {
		let callCount = 0;

		const result = await retryWithBackoff(
			async () => {
				callCount++;
				if (callCount < 3) {
					throw new Error("Temporary failure");
				}
				return "success";
			},
			{
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 100,
			},
		);

		expect(callCount).toBe(3);
		expect(result).toBe("success");
	});

	it("should call fn exactly once when shouldRetry returns false", async () => {
		let callCount = 0;
		let shouldRetryCallCount = 0;

		try {
			await retryWithBackoff(
				async () => {
					callCount++;
					throw new Error("Permanent failure");
				},
				{
					maxAttempts: 3,
					baseDelayMs: 10,
					maxDelayMs: 100,
					shouldRetry: (err: unknown) => {
						shouldRetryCallCount++;
						return false;
					},
				},
			);
		} catch (err) {
			// Expected to throw
		}

		expect(callCount).toBe(1);
		expect(shouldRetryCallCount).toBe(1);
	});

	it("should throw the last error after maxAttempts exhausted", async () => {
		let callCount = 0;
		let thrownError: Error | null = null;

		try {
			await retryWithBackoff(
				async () => {
					callCount++;
					throw new Error(`Attempt ${callCount} failed`);
				},
				{
					maxAttempts: 3,
					baseDelayMs: 10,
					maxDelayMs: 100,
				},
			);
		} catch (err) {
			thrownError = err as Error;
		}

		expect(callCount).toBe(3);
		expect(thrownError).not.toBeNull();
		expect(thrownError?.message).toBe("Attempt 3 failed");
	});

	it("should respect exponential backoff delays", async () => {
		let callCount = 0;
		const capturedDelays: number[] = [];

		const originalSetTimeout = global.setTimeout;

		global.setTimeout = ((callback: TimerHandler, delay?: number) => {
			if (typeof delay === "number") {
				capturedDelays.push(delay);
			}
			// Execute immediately for testing
			if (typeof callback === "function") {
				callback();
			}
			return 0 as any;
		}) as any;

		try {
			await retryWithBackoff(
				async () => {
					callCount++;
					if (callCount < 3) {
						throw new Error("Retry");
					}
					return "success";
				},
				{
					maxAttempts: 3,
					baseDelayMs: 100,
					maxDelayMs: 1000,
				},
			);
		} finally {
			global.setTimeout = originalSetTimeout;
		}

		// First retry: 100 * 2^0 = 100
		// Second retry: 100 * 2^1 = 200
		expect(capturedDelays).toEqual([100, 200]);
	});

	it("should cap delay at maxDelayMs", async () => {
		let callCount = 0;
		const capturedDelays: number[] = [];

		const originalSetTimeout = global.setTimeout;

		global.setTimeout = ((callback: TimerHandler, delay?: number) => {
			if (typeof delay === "number") {
				capturedDelays.push(delay);
			}
			if (typeof callback === "function") {
				callback();
			}
			return 0 as any;
		}) as any;

		try {
			await retryWithBackoff(
				async () => {
					callCount++;
					if (callCount < 4) {
						throw new Error("Retry");
					}
					return "success";
				},
				{
					maxAttempts: 4,
					baseDelayMs: 100,
					maxDelayMs: 250,
				},
			);
		} finally {
			global.setTimeout = originalSetTimeout;
		}

		// First: 100 * 2^0 = 100
		// Second: 100 * 2^1 = 200
		// Third: 100 * 2^2 = 400, capped at 250
		expect(capturedDelays).toEqual([100, 200, 250]);
	});

	it("should return the successful result on first attempt", async () => {
		let callCount = 0;

		const result = await retryWithBackoff(
			async () => {
				callCount++;
				return "immediate success";
			},
			{
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 100,
			},
		);

		expect(result).toBe("immediate success");
		expect(callCount).toBe(1);
	});

	it("should default shouldRetry to always return true", async () => {
		let callCount = 0;

		const result = await retryWithBackoff(
			async () => {
				callCount++;
				if (callCount < 2) {
					throw new Error("Retry me");
				}
				return "success";
			},
			{
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 100,
				// No shouldRetry provided
			},
		);

		expect(callCount).toBe(2);
		expect(result).toBe("success");
	});
});

describe("pollWithBackoff", () => {
	it("retries a nullish result and returns the first non-nullish value", async () => {
		let callCount = 0;

		const result = await pollWithBackoff(
			async () => {
				callCount++;
				return callCount < 3 ? undefined : "ready";
			},
			{ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
		);

		expect(callCount).toBe(3);
		expect(result).toBe("ready");
	});

	it("returns undefined and calls onExhausted with the empty-result error", async () => {
		let callCount = 0;
		let exhaustedErr: unknown;

		const result = await pollWithBackoff(
			async () => {
				callCount++;
				return undefined;
			},
			{
				maxAttempts: 3,
				baseDelayMs: 1,
				maxDelayMs: 10,
				emptyResultError: () => new Error("no result"),
				onExhausted: (err) => {
					exhaustedErr = err;
				},
			},
		);

		expect(callCount).toBe(3);
		expect(result).toBeUndefined();
		expect((exhaustedErr as Error).message).toBe("no result");
	});

	it("stops immediately when shouldRetry returns false", async () => {
		let callCount = 0;

		const result = await pollWithBackoff(
			async () => {
				callCount++;
				return undefined;
			},
			{
				maxAttempts: 5,
				baseDelayMs: 1,
				maxDelayMs: 10,
				shouldRetry: () => false,
			},
		);

		expect(callCount).toBe(1);
		expect(result).toBeUndefined();
	});

	it("treats null the same as undefined", async () => {
		let callCount = 0;

		const result = await pollWithBackoff(
			async () => {
				callCount++;
				return callCount < 2 ? null : 42;
			},
			{ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
		);

		expect(callCount).toBe(2);
		expect(result).toBe(42);
	});
});
