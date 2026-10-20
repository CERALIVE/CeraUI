import { expect, test } from "bun:test";
import {
	compete,
	lockFixture,
	recoverWith,
} from "./helpers/package-recovery-lock-fixture.ts";

for (const boundary of ["persisted", "evidence"] as const) {
	for (const fireTimer of [true, false])
		test(`collection expiry during ${boundary} read (timer ${fireTimer}) refuses late recovery`, async () => {
			// Given real locks and a controlled read that outlives the collection budget.
			const f = await lockFixture();
			const entered = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<void>();
			const returned = Promise.withResolvers<void>();
			let now = 0;
			let expire: (() => void) | undefined;
			let evidenceCalls = 0;
			let timerCancelled = false;
			const pause = async () => {
				entered.resolve();
				await blocked.promise;
				returned.resolve();
			};
			try {
				const recovery = recoverWith({
					...f.port,
					packageCollectionClock: {
						now: () => now,
						arm: (callback: () => void, _ms: number) => {
							expire = callback;
							return () => {
								timerCancelled = true;
							};
						},
					},
					readPersisted: async () => {
						if (boundary === "persisted") await pause();
						return f.before;
					},
					readPackageEvidence: async (locks) => {
						evidenceCalls++;
						const evidence = await f.port.readPackageEvidence(locks);
						if (boundary === "evidence") await pause();
						return evidence;
					},
				});
				await entered.promise;
				expect(f.paths.map(compete)).toEqual([75, 75, 75, 75]);
				// When the injected monotonic deadline expires before the read returns.
				now = 30_000;
				if (fireTimer) expire?.();
				if (!fireTimer || !expire) blocked.resolve();
				const recovered = await recovery;
				blocked.resolve();
				await returned.promise;
				// Then neither timeout nor late clean data grants cleanup or publication.
				expect({ recovered, effects: f.effects, evidenceCalls }).toEqual({
					recovered: false,
					effects: [],
					evidenceCalls: boundary === "evidence" ? 1 : 0,
				});
				expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
				expect(timerCancelled).toBe(true);
			} finally {
				blocked.resolve();
				await f.close();
			}
		});
}
