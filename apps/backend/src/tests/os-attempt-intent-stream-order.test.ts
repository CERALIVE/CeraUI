import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	fromPersisted,
	loadOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	type StreamStartUpdateAdmission,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { intentCrashFixture } from "./helpers/os-attempt-intent-fixture.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import type { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

for (const first of ["startup", "stream"] as const) {
	test(`${first}-first publishing recovery owns staging before D8 can change it`, async () => {
		// Given exact crash files with physical proof held under CONTROL.
		const f = intentCrashFixture();
		fixtures.push(f);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<boolean>();
		let probes = 0;
		let kills = 0;
		let controlTail = Promise.resolve();
		let streamRequested = false;
		let streamFlight: Promise<StreamStartUpdateAdmission> | undefined;
		const deps = {
			...f.deps,
			now: () => {
				if (
					first === "stream" &&
					getOrchestratorState().phase === "os-staging" &&
					!streamRequested
				) {
					streamRequested = true;
					streamFlight = admitAndPrepareStreamStart();
				}
				return f.deps.now();
			},
			acquireOsStageControl: async () => {
				const previous = controlTail;
				const released = Promise.withResolvers<void>();
				controlTail = released.promise;
				await previous;
				const lease = await acquireTestOsStageControl();
				return {
					held: lease.held,
					[Symbol.asyncDispose]: async () => {
						await lease[Symbol.asyncDispose]();
						released.resolve();
					},
				};
			},
			proveOsWriterQuiescent: () => {
				probes++;
				entered.resolve();
				return release.promise;
			},
			killAndRestartRaucForStream: async () => {
				kills++;
			},
		};
		const bytes = readFileSync(f.file);
		const leading = startUpdateOrchestrator(deps);
		await entered.promise;
		const following =
			first === "startup" ? admitAndPrepareStreamStart() : streamFlight;
		if (!following) throw new Error("D8 must enter at startup adoption");
		let streamSettled = false;
		const stream = following.then(() => {
			streamSettled = true;
		});
		try {
			// When the competing admission gets a turn while proof is unresolved.
			await Promise.resolve();
			await Promise.resolve();
			expect(streamSettled).toBe(false);
			expect(readFileSync(f.file)).toEqual(bytes);
			expect(probes).toBe(1);
		} finally {
			release.resolve(true);
			await Promise.allSettled([leading, following, stream]);
		}
		// Then one recovery restores before D8, with no phantom cancellation.
		await leading;
		expect(await following).toEqual({ allowed: true });
		expect(kills).toBe(0);
		expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
		expect(await loadOrchestratorState(f.file)).toEqual(
			fromPersisted(f.intent.before),
		);
		expect(f.intentStore.read()).toBeNull();
		resetOrchestratorRuntimeForTest();
		await startUpdateOrchestrator(f.deps);
		expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
	});
}

test("D8 refuses unproven publishing recovery without changing its restart authority", async () => {
	// Given publishing authority but no conclusive writer-quiescence proof.
	const f = intentCrashFixture();
	fixtures.push(f);
	let quiescent = false;
	let kills = 0;
	setOrchestratorRuntimeDepsForTest({
		...f.deps,
		proveOsWriterQuiescent: async () => quiescent,
		killAndRestartRaucForStream: async () => {
			kills++;
		},
	});
	setOrchestratorStateForTest(fromPersisted(f.intent.staged));
	const bytes = readFileSync(f.file);
	// When stream admission cannot resolve authority or prove a live producer.
	await expect(admitAndPrepareStreamStart()).rejects.toMatchObject({
		code: "UPDATE_ORCHESTRATOR_INITIALIZING",
		data: { retryable: true },
	});
	// Then a later proof can still restore; no third snapshot or RAUC kill occurred.
	expect(readFileSync(f.file)).toEqual(bytes);
	expect(kills).toBe(0);
	quiescent = true;
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
	resetOrchestratorRuntimeForTest();
	await startUpdateOrchestrator(f.deps);
	expect(getOrchestratorState()).toEqual(fromPersisted(f.intent.before));
});
