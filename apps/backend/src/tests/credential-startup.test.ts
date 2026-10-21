/// <reference types="bun" />
import { expect, test } from "bun:test";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { credentialObserverFixture } from "./helpers/credential-observer-fixture.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

test("startup forces an independent observation while recovery is still held", async () => {
	// Given startup held at real witness reconciliation; When bootstrap starts; Then forced credential observation is visible before recovery completes.
	const fixture = await credentialObserverFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	let observation: Promise<void> = Promise.resolve();
	let forced: boolean | undefined;
	const runtime = runtimeFixture({
		observeCredentials: (force) => {
			forced = force;
			observation = fixture.observer.refresh(force);
			return observation;
		},
		proveOsWriterQuiescent: () => {
			entered.resolve();
			return release.promise;
		},
	});
	runtime.writeWitness();
	saveOrchestratorState(identifiedState(), runtime.file);
	const starting = startUpdateOrchestrator(runtime.deps);
	try {
		await entered.promise;
		await observation;
		expect(forced).toBe(true);
		expect(
			getPersistentNotifications(true).show.filter((notice) =>
				notice.name.startsWith("update:credentials-"),
			),
		).toHaveLength(1);
	} finally {
		release.resolve(true);
		await starting;
		runtime.cleanup();
		fixture.observer.stop();
		for (const notice of getPersistentNotifications(true).show)
			notificationRemove(notice.name);
		await fixture.cleanup();
	}
});
