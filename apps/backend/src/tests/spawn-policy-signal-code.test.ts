import { expect, test } from "bun:test";
import {
	type ManagedProcess,
	spawnWatcher,
	superviseWorker,
} from "../helpers/spawn-policy.ts";

for (const signalCode of [0, 9, 15]) {
	test(`shutdown does not signal a worker with numeric terminal signal ${signalCode}`, async () => {
		const signals: (NodeJS.Signals | number | undefined)[] = [];
		const proc: ManagedProcess = {
			exitCode: null,
			signalCode,
			exited: Promise.resolve(128 + signalCode),
			kill: (signal) => {
				signals.push(signal);
			},
		};
		const handle = superviseWorker(["fixture-worker"], { spawn: () => proc });
		await handle.ready;

		await handle.shutdown();

		expect(signals).toEqual([]);
	});

	test(`abort does not signal a watcher with numeric terminal signal ${signalCode}`, () => {
		const signals: (NodeJS.Signals | number | undefined)[] = [];
		const proc: ManagedProcess = {
			exitCode: null,
			signalCode,
			exited: Promise.resolve(128 + signalCode),
			kill: (signal) => {
				signals.push(signal);
			},
		};
		const handle = spawnWatcher(["fixture-watcher"], { spawn: () => proc });

		handle.abort();

		expect(signals).toEqual([]);
	});
}
