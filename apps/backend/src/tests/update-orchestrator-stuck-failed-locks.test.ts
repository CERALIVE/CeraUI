import { expect, test } from "bun:test";
import { packageLocksIdle } from "../modules/system/update-orchestrator/package-recovery-evidence.ts";
import {
	compete,
	lockFixture,
	packageWriterArgv,
	recoverWith,
} from "./helpers/package-recovery-lock-fixture.ts";

for (const index of [0, 1, 2, 3])
	test(`external POSIX writer on lock ${index} acquired after idle observation leaves failure untouched`, async () => {
		// Given an idle observation followed by a readiness-acknowledged external writer.
		const f = await lockFixture();
		const path = f.paths[index];
		if (!path) throw new TypeError("missing fixture path");
		expect(await packageLocksIdle(f.paths)).toBe(true);
		const holder = Bun.spawn(packageWriterArgv(path, "hold"), {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		try {
			const reader = holder.stdout.getReader();
			try {
				expect(new TextDecoder().decode((await reader.read()).value)).toBe(
					"ready\n",
				);
			} finally {
				reader.releaseLock();
			}
			// When recovery tries to settle after the ordinary writer won the race.
			const recovered = await recoverWith(f.port);
			// Then no plan, persisted state or published state may be changed.
			expect({ recovered, effects: f.effects }).toEqual({
				recovered: false,
				effects: [],
			});
		} finally {
			await holder.stdin.end();
			await holder.exited;
			expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
			await f.close();
		}
	});

test("recovery excludes external writers from first evidence through both publication boundaries", async () => {
	// Given otherwise eligible recovery and independent real lock contenders.
	const f = await lockFixture();
	const attempts: number[][] = [];
	const observe = () => {
		attempts.push(f.paths.map(compete));
	};
	try {
		// When evidence, durable publication and wire publication each attempt entry.
		const recovered = await recoverWith({
			...f.port,
			readPersisted: async () => {
				observe();
				return f.before;
			},
			readPackageEvidence: async (locks) => {
				observe();
				return f.port.readPackageEvidence(locks);
			},
			persist: () => {
				observe();
				f.effects.push("persist");
			},
			adopt: () => {
				observe();
				f.effects.push("adopt");
			},
		});
		// Then all four locks exclude writers until publication, not merely until collection.
		expect({ recovered, attempts }).toEqual({
			recovered: true,
			attempts: Array.from({ length: 4 }, () => [75, 75, 75, 75]),
		});
		expect(f.paths.map(compete)).toEqual([0, 0, 0, 0]);
	} finally {
		await f.close();
	}
});
