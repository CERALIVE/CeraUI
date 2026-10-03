import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import {
	fromPersisted,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { reduceOrchestrator } from "../modules/system/update-orchestrator/reducer.ts";
import {
	checkUpdatesNow,
	installUpdatesNow,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";

const fixtures: ReturnType<typeof intentCrashFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const invalid of [
	"json",
	"foreign",
	"owner",
	"oversized",
	"mode",
	"utf8",
] as const) {
	test(`stale cleanup preserves ${invalid} launching authority and keeps readiness closed`, async () => {
		// Given a cleared attempt, but the leftover launching record is untrustworthy.
		const f = intentCrashFixture("launching");
		fixtures.push(f);
		const published = reduceOrchestrator(fromPersisted(f.intent.staged), {
			type: "OS_STAGED",
			now: 999,
			attemptId: f.intent.attemptId,
		});
		saveOrchestratorState(
			reduceOrchestrator(published, {
				type: "OS_STAGE_SETTLED",
				now: 999,
				attemptId: f.intent.attemptId,
			}),
			f.file,
		);
		const path = f.intentStore.storage.path;
		switch (invalid) {
			case "json":
				writeFileSync(path, "{");
				break;
			case "foreign":
				writeFileSync(path, JSON.stringify({ ...f.intent, foreign: true }));
				break;
			case "owner":
				break;
			case "oversized":
				writeFileSync(path, " ".repeat(65_537));
				break;
			case "mode":
				chmodSync(path, 0o644);
				break;
			case "utf8":
				writeFileSync(path, Buffer.from([0xff]));
				break;
		}
		const bytes = readFileSync(path);
		const deps = {
			...f.deps,
			...(invalid === "owner"
				? {
						osAttemptIntentStore: new OsAttemptIntentStore({
							...f.intentStore.storage,
							uid: f.intentStore.storage.uid + 1,
						}),
					}
				: {}),
		};
		// When startup attempts to classify stale authority.
		await expect(startUpdateOrchestrator(deps)).rejects.toThrow();
		// Then none of these failures can be laundered into stale-file retirement.
		expect(readFileSync(path)).toEqual(bytes);
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
		await expect(installUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
	});
}
