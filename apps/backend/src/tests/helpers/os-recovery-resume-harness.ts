import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../../modules/system/update-orchestrator/persistence.ts";
import { UpdateQuarantine } from "../../modules/system/update-orchestrator/quarantine.ts";
import {
	defaultOrchestratorRuntimeDeps,
	type OrchestratorRuntimeDeps,
	startUpdateOrchestrator,
} from "../../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import {
	BOOT_ID,
	type Evidence,
	manifest,
	NOW,
} from "./os-recovery-resume-inputs.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export const dirs: string[] = [];

export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-os-recovery-"));
	dirs.push(dir);
	return dir;
}

export function deps(
	evidence: Evidence,
	calls: { stages: number },
	overrides: Partial<OrchestratorRuntimeDeps> = {},
): OrchestratorRuntimeDeps {
	return {
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		now: () => NOW,
		random: () => 0.5,
		loadSettings: async () => ({
			packagesAuto: true,
			systemAuto: true,
			schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
			channel: "stable",
			allowPackagesOverCellular: true,
			allowSystemOverCellular: true,
		}),
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming"],
		}),
		isIdle: async () => true,
		isStreamLive: () => false,
		onlyMeteredCandidateExists: async () => false,
		runPackageCheck: async () => null,
		getPackageInstallWireState: () => ({ kind: "idle" }),
		recoverSoftwareUpdateIfRunning: async () => false,
		checkOsManifest: async () => ({
			available: true,
			rateLimited: false,
			failed: false,
			reason: "",
			manifest,
		}),
		stageOs: async () => {
			calls.stages++;
		},
		inspectSlotSync: async () => ({ kind: "absent" }),
		inspectOsOperation: async () => {
			if (evidence.operation === "unreadable")
				throw new Error("rauc_operation_unknown");
			return evidence.operation;
		},
		readRootSlots: async () => evidence.slots,
		readOsReceipt: async () =>
			evidence.receipt
				? {
						schema: 1,
						version: "2026.10.0",
						channel: "stable",
						stagedAt: 1,
						bootId: BOOT_ID,
					}
				: undefined,
		readHealthyState: async () => ({
			boot_id: BOOT_ID,
			slot: "A",
			build_id: "b",
			dpkg_status_sha256: "d".repeat(64),
			recorded_at: "2026-10-01T00:00:00Z",
		}),
		readBootId: async () => BOOT_ID,
		readActivationArmed: async () => evidence.armed,
		proveOsWriterQuiescent: async () => evidence.quiescent,
		persist: saveOrchestratorState,
		quarantine: new UpdateQuarantine(
			join(tempDir(), "quarantine.json"),
			async () => {
				// Quarantine persistence is real; host APT pin writes are not.
			},
		),
		...overrides,
	};
}

export async function bootFrom(
	persisted: OrchestratorState,
	evidence: Evidence,
): Promise<{ stages: number }> {
	setOrchestratorStateFilePathForTest(join(tempDir(), "agent.json"));
	saveOrchestratorState(persisted);
	const calls = { stages: 0 };
	await startUpdateOrchestrator(deps(evidence, calls));
	return calls;
}
