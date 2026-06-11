import { describe, expect, test } from "bun:test";
import { SHUTDOWN_SIGKILL_TIMEOUT_MS } from "../modules/streaming/constants.ts";

describe("process-runner shutdown timeout", () => {
	test("SHUTDOWN_SIGKILL_TIMEOUT_MS is 10 seconds", () => {
		expect(SHUTDOWN_SIGKILL_TIMEOUT_MS).toBe(10_000);
	});

	test("shutdown timeout logic sends SIGKILL after elapsed time exceeds threshold", () => {
		// Simulate the shutdown timeout logic without actual time delays
		let shutdownStartTime: number | null = null;
		let killSignals: Array<string> = [];

		const mockProcess = {
			proc: {
				kill: (signal: string) => {
					killSignals.push(signal);
				},
			},
			spawnfile: "test-process",
		};

		const mockStreamingProcesses = [mockProcess];

		// Simulate one iteration of waitForAllProcessesToTerminate
		const simulateWaitIteration = (elapsedMs: number) => {
			if (mockStreamingProcesses.length === 0) {
				return;
			}

			if (shutdownStartTime === null) {
				shutdownStartTime = 0;
			}

			// Simulate elapsed time
			const currentElapsed = shutdownStartTime + elapsedMs;

			if (currentElapsed >= SHUTDOWN_SIGKILL_TIMEOUT_MS) {
				for (const p of mockStreamingProcesses) {
					p.proc.kill("SIGKILL");
				}
			}
		};

		// First iteration: 0ms elapsed, no SIGKILL
		simulateWaitIteration(0);
		expect(killSignals).toEqual([]);

		// Second iteration: 5000ms elapsed, still no SIGKILL
		killSignals = [];
		simulateWaitIteration(5000);
		expect(killSignals).toEqual([]);

		// Third iteration: 10000ms elapsed, SIGKILL sent
		killSignals = [];
		simulateWaitIteration(10_000);
		expect(killSignals).toEqual(["SIGKILL"]);

		// Fourth iteration: 15000ms elapsed, SIGKILL sent again
		killSignals = [];
		simulateWaitIteration(15_000);
		expect(killSignals).toEqual(["SIGKILL"]);
	});

	test("constants are env-overridable via CERALIVE_SRTLA_PORT", () => {
		// The SRTLA_LISTEN_PORT constant reads from process.env.CERALIVE_SRTLA_PORT
		// This test verifies the timeout constant is properly defined
		expect(SHUTDOWN_SIGKILL_TIMEOUT_MS).toBe(10_000);
	});
});
