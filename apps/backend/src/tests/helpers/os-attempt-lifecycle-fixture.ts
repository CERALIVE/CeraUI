import { dirname, join } from "node:path";
import {
	OsAgentError,
	type OsStageReceipt,
	saveStagedManifest,
} from "../../modules/system/update-orchestrator/os-agent.ts";
import {
	prepareOsStageJob,
	readOsStageJob,
	retireOsStageJob,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import { osStageCandidateKey } from "../../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	checkUpdatesNow,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	startUpdateOrchestrator,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { RootSlotStatus } from "../../modules/system/update-orchestrator/slot-status.ts";
import { record } from "./os-stage-startup-harness.ts";
import { input, manifest } from "./os-stage-unlaunched-fixture.ts";
import { NOW, runtimeFixture } from "./os-unlaunched-runtime-fixture.ts";

export function lifecycleFixture() {
	const f = runtimeFixture();
	const effects = {
		bootId: input.bootId,
		bootedVersion: "2026.9.0",
		healthy: true,
		stages: 0,
		arms: 0,
	};
	let receipt: OsStageReceipt | undefined;
	const receiptPath = join(dirname(f.file), "os-staged.json");
	const jobDir = join(dirname(f.file), "stage-job");
	const deps: OrchestratorRuntimeDeps = {
		...f.deps,
		readOsStageJob: () => readOsStageJob(jobDir, f.witnessDeps.uid),
		proveOsWriterQuiescent: async () =>
			(await readOsStageJob(jobDir, f.witnessDeps.uid)) === null,
		loadSettings: async () => ({
			...(await f.deps.loadSettings()),
			packagesAuto: false,
			systemAuto: false,
		}),
		readBootId: async () => effects.bootId,
		readBootedVersion: async () => effects.bootedVersion,
		readStagedActivation: async () => "consumed",
		readRootSlots: async () =>
			(await f.deps.readRootSlots()).map<RootSlotStatus>((slot) =>
				effects.bootedVersion === manifest.version
					? { ...slot, state: slot.bootname === "A" ? "booted" : "inactive" }
					: slot,
			),
		readHealthyState: async () =>
			effects.healthy
				? {
						boot_id: effects.bootId,
						slot: effects.bootedVersion === manifest.version ? "A" : "B",
						build_id: "b",
						dpkg_status_sha256: "d".repeat(64),
						recorded_at: "2026-10-02T00:00:00Z",
					}
				: null,
		readOsReceipt: async () => {
			if (!(await Bun.file(receiptPath).exists())) return undefined;
			if (
				!receipt ||
				(await Bun.file(receiptPath).text()) !== JSON.stringify(receipt)
			)
				throw new OsAgentError("staged_receipt_invalid");
			return receipt;
		},
		armOs: async () => {
			effects.arms++;
		},
		killAndRestartRaucForStream: async () => undefined,
		stageOs: async (_candidate, _progress, control) => {
			receipt = await saveStagedManifest(
				manifest,
				effects.bootId,
				NOW,
				dirname(f.file),
			);
			control?.commit?.(receipt);
		},
	};
	return {
		...f,
		deps,
		effects,
		receiptPath,
		jobDir,
		offer: async (overrides: Partial<OrchestratorRuntimeDeps> = {}) => {
			setOrchestratorRuntimeDepsForTest({
				...deps,
				...overrides,
				stageOs: async (candidate, progress, control) => {
					if (!control) throw new Error("fixture requires stage control");
					await prepareOsStageJob(
						{
							...record,
							attemptId: control.attemptId,
							candidateKey: osStageCandidateKey(candidate),
							bundleUrl: candidate.bundle.url,
							processes: [],
							resources: [],
						},
						jobDir,
						f.witnessDeps.uid,
					);
					effects.stages++;
					try {
						await (overrides.stageOs ?? deps.stageOs)(
							candidate,
							progress,
							control,
						);
					} finally {
						await retireOsStageJob(jobDir);
					}
				},
			});
			await checkUpdatesNow();
		},
		restart: async (overrides: Partial<OrchestratorRuntimeDeps> = {}) => {
			resetOrchestratorRuntimeForTest();
			await startUpdateOrchestrator({ ...deps, ...overrides });
		},
	};
}
