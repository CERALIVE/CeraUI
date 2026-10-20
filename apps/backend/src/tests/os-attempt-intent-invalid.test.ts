import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { fromPersisted } from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	installUpdatesNow,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	attemptIntent,
	intentCrashFixture,
} from "./helpers/os-attempt-intent-fixture.ts";

const fixtures: ReturnType<typeof intentCrashFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const corruption of [
	"corrupt",
	"foreign",
	"wrong-candidate",
	"wrong-attempt",
	"other-uid",
] as const) {
	test(`startup preserves ${corruption} intent and closes Check/Install`, async () => {
		// Given an intent that cannot authorize this exact staging snapshot.
		const f = intentCrashFixture();
		fixtures.push(f);
		const store = f.intentStore;
		switch (corruption) {
			case "corrupt":
				writeFileSync(store.storage.path, "{");
				break;
			case "foreign":
				writeFileSync(
					store.storage.path,
					JSON.stringify({ ...f.intent, foreign: true }),
				);
				break;
			case "wrong-candidate":
				store.retire(f.intent);
				store.write(
					attemptIntent(fromPersisted(f.intent.before), {
						...f.intent.manifest,
						version: "2026.10.99",
					}),
					null,
				);
				break;
			case "wrong-attempt":
				writeFileSync(
					store.storage.path,
					JSON.stringify({
						...f.intent,
						attemptId: "00000000-0000-4000-8000-000000000099",
					}),
				);
				break;
			case "other-uid":
				break;
		}
		const bytes = readFileSync(store.storage.path);
		const deps = {
			...f.deps,
			...(corruption === "other-uid"
				? {
						osAttemptIntentStore: new OsAttemptIntentStore({
							...store.storage,
							uid: store.storage.uid + 1,
						}),
					}
				: {}),
		};
		// When startup parses the authority boundary.
		await expect(startUpdateOrchestrator(deps)).rejects.toThrow();
		// Then even a healthy both-good-slot board cannot silently clear it.
		expect(readFileSync(store.storage.path)).toEqual(bytes);
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
		await expect(installUpdatesNow()).rejects.toMatchObject({
			data: { retryable: true },
		});
	});
}
