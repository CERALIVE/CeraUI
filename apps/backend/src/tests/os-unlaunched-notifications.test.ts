import { afterEach, beforeEach, expect, test } from "bun:test";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { osStageNoticeId } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import {
	getPersistentNotifications,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	D8_STATE,
	identifiedState,
	KEY,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
// The notification store is process-global; earlier files may leave notices.
beforeEach(() => {
	for (const notice of getPersistentNotifications(true).show)
		notificationRemove(notice.name);
});
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
	for (const notice of getPersistentNotifications(true).show)
		if (notice.name.startsWith("update:")) notificationRemove(notice.name);
});

test("replaces only the matching unresolved notice when witness settlement persists", async () => {
	// Given a matching unresolved notice plus unrelated candidate/check notices.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const id = osStageNoticeId(KEY);
	notifyUpdate({ kind: "os-stage-unresolved", id, version: manifest.version });
	notifyUpdate({
		kind: "os-stage-unresolved",
		id: "other-candidate",
		version: "2026.10.53",
	});
	notifyUpdate({ kind: "refused", id: "os-check:expired", reason: "expired" });
	// When the actual startup adapter accepts the completed witness.
	await startUpdateOrchestrator(f.deps);
	// Then the matching error is operator guidance, without a success claim.
	const names = getPersistentNotifications(true)
		.show.map((notice) => notice.name)
		.sort();
	expect(names).toEqual(
		[
			`update:os-stage-operator:${id}`,
			"update:os-stage-unresolved:other-candidate",
			"update:refused:os-check:expired",
		].sort(),
	);
});

test("retains unresolved notice when the real D8 legacy record cannot be identified", async () => {
	// Given the original D8 record, with no historical attempt identity.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(D8_STATE, f.file);
	const name = `update:os-stage-unresolved:${osStageNoticeId(KEY)}`;
	notifyUpdate({
		kind: "os-stage-unresolved",
		id: osStageNoticeId(KEY),
		version: manifest.version,
	});
	// When startup evaluates the witness against the legacy record.
	await startUpdateOrchestrator(f.deps);
	// Then no notice is withdrawn or replaced on candidate equality alone.
	expect(
		getPersistentNotifications(true).show.map((notice) => notice.name),
	).toEqual([name]);
});

test("publishes no settlement notice when the state write fails", async () => {
	// Given a matching witness whose state persistence will fail.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const name = `update:os-stage-unresolved:${osStageNoticeId(KEY)}`;
	notifyUpdate({
		kind: "os-stage-unresolved",
		id: osStageNoticeId(KEY),
		version: manifest.version,
	});
	// When dispatch cannot persist the new recovery disposition.
	await expect(
		startUpdateOrchestrator({
			...f.deps,
			persist: () => {
				throw new Error("write fault");
			},
		}),
	).rejects.toThrow("write fault");
	// Then the existing unresolved notice remains the only notice.
	expect(
		getPersistentNotifications(true).show.map((notice) => notice.name),
	).toEqual([name]);
});
