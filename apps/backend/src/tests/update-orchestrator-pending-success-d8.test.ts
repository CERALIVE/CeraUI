import { expect, test } from "bun:test";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	setOrchestratorStateForTest,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

for (const phase of ["downloading", "os-staging"] as const) {
	test(`D8 leaves disk and effects unchanged when success is pending in ${phase}`, async () => {
		// Given an initialized downloading owner and an observed but unacknowledged completion.
		let complete = false;
		let stops = 0;
		let kills = 0;
		const f = runtimeFixture({
			recoverSoftwareUpdateIfRunning: async () => true,
			getPackageInstallWireState: () =>
				complete
					? { kind: "success" }
					: {
							kind: "downloading",
							progress: {
								total: 1,
								downloading: 0,
								unpacking: 0,
								setting_up: 0,
							},
						},
			stopPackageInstallUnit: async () => {
				stops++;
			},
			killAndRestartRaucForStream: async () => {
				kills++;
			},
		});
		saveOrchestratorState(
			{ ...initialOrchestratorState(0), phase: "downloading" },
			f.file,
		);
		try {
			await startUpdateOrchestrator(f.deps);
			pendingPackageSuccess.observe();
			complete = true;
			setOrchestratorStateForTest({ ...getOrchestratorState(), phase });
			saveOrchestratorState(getOrchestratorState(), f.file);
			const before = await Bun.file(f.file).text();
			// When a stream start arrives before durability acknowledgement.
			const result = await admitAndPrepareStreamStart();
			// Then existing in-progress vocabulary refuses without changing its retained baseline.
			expect(result).toMatchObject({
				allowed: false,
				reason: "update_in_progress",
			});
			expect(await Bun.file(f.file).text()).toBe(before);
			expect(stops).toBe(0);
			expect(kills).toBe(0);
		} finally {
			f.cleanup();
		}
	});
}

test("D8 rechecks pending success after its awaited commit probe before submitting stop", async () => {
	// Given D8 admitted a download and is waiting on the fresh commit probe.
	const probed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<boolean>();
	let stops = 0;
	const f = runtimeFixture({
		recoverSoftwareUpdateIfRunning: async () => true,
		getPackageInstallWireState: () => ({
			kind: "downloading",
			progress: { total: 1, downloading: 0, unpacking: 0, setting_up: 0 },
		}),
		isCommitStageRunning: () => {
			probed.resolve();
			return release.promise;
		},
		stopPackageInstallUnit: async () => {
			stops++;
		},
	});
	saveOrchestratorState(
		{ ...initialOrchestratorState(0), phase: "downloading" },
		f.file,
	);
	try {
		await startUpdateOrchestrator(f.deps);
		const before = await Bun.file(f.file).text();
		const admission = admitAndPrepareStreamStart();
		await probed.promise;
		// When completion is observed while that probe is outstanding.
		pendingPackageSuccess.observe();
		release.resolve(false);
		// Then no new stop or aborted-phase persistence can be submitted.
		expect(await admission).toMatchObject({
			allowed: false,
			reason: "update_in_progress",
		});
		expect(stops).toBe(0);
		expect(await Bun.file(f.file).text()).toBe(before);
	} finally {
		release.resolve(false);
		f.cleanup();
	}
});
