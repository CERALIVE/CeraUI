import { expect, test } from "bun:test";
import { osAttemptIntentSchema } from "../modules/system/update-orchestrator/os-attempt-intent.ts";
import { publishingIntentPending } from "../modules/system/update-orchestrator/os-attempt-intent-admission.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { packageSuccessState } from "../modules/system/update-orchestrator/pending-success-state.ts";
import {
	fromPersisted,
	loadOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	allowCellularOnce,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	attemptIntent,
	intentCrashFixture,
} from "./helpers/os-attempt-intent-fixture.ts";

test("valid publishing snapshots cannot reserve a tracked package completion", async () => {
	// Given real valid publishing crash files and a retained physical-proof wait.
	const f = intentCrashFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	let attachedPackages = 0;
	let producers = 0;
	const startup = startUpdateOrchestrator({
		...f.deps,
		proveOsWriterQuiescent: () => {
			entered.resolve();
			return release.promise;
		},
		recoverSoftwareUpdateIfRunning: async () => {
			attachedPackages++;
			return true;
		},
		stageOs: async () => {
			producers++;
		},
	});
	try {
		await entered.promise;
		const original = await Bun.file(f.file).text();
		// When admission joins startup's real publishing recovery.
		const admission = admitAndPrepareStreamStart();
		// Then startup has no tracked package owner in either valid intent phase.
		expect(publishingIntentPending(f.intentStore)).toBe(true);
		expect(pendingPackageSuccess.pending).toBe(false);
		expect(attachedPackages).toBe(0);
		expect(() => allowCellularOnce("third-snapshot")).toThrow("initializing");
		expect(await Bun.file(f.file).text()).toBe(original);
		release.resolve(true);
		await startup;
		expect(await admission).toEqual({ allowed: true });
		expect(await loadOrchestratorState(f.file)).toEqual(
			fromPersisted(f.intent.before),
		);
		expect(publishingIntentPending(f.intentStore)).toBe(false);
		expect(pendingPackageSuccess.pending).toBe(false);
		expect(attachedPackages).toBe(0);
		expect(producers).toBe(0);
	} finally {
		release.resolve(true);
		await startup;
		f.cleanup();
	}
});

test("publishing authority rejects package-shaped baselines rather than granting no-producer restoration", () => {
	// Given a schema-valid producer transition and the actual package success reducer.
	const intent = attemptIntent();
	// When package phases are offered as a publishing baseline, they are not authority.
	for (const phase of [
		"downloading",
		"committing",
		"restarting-services",
		"settled",
	] as const) {
		expect(
			osAttemptIntentSchema.safeParse({
				...intent,
				before: { ...intent.before, phase },
			}).success,
		).toBe(false);
	}
	// Then neither valid publishing snapshot can manufacture package-success intent.
	expect(packageSuccessState(fromPersisted(intent.before), 999)).toBeNull();
	expect(packageSuccessState(fromPersisted(intent.staged), 999)).toBeNull();
});
