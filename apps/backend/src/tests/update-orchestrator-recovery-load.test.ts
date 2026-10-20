import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateOrchestratorPersistedStateSchema } from "@ceraui/rpc/schemas";
import {
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const dirs: string[] = [];
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

test.each([
	"commit_unit_absent_on_resume",
	"apt-exit-nonzero",
	"commit_resume_inconclusive",
	"rauc_install_failed",
])(
	"H2-R2 keeps %s terminal when persisted recovery contradicts it",
	async (reason) => {
		// Given a real writer storing contradictory recovery alongside a legacy failure.
		const dir = mkdtempSync(join(tmpdir(), "ceraui-invalid-recovery-"));
		dirs.push(dir);
		const file = join(dir, "agent.json");
		setOrchestratorStateFilePathForTest(file);
		saveOrchestratorState({
			...initialOrchestratorState(0),
			phase: "failed",
			failureReason: reason,
			osStageRecovery: {
				candidateKey: "k",
				activeAttemptId: null,
				failedRounds: 1,
				nextRetryAt: 10,
				mode: "unsafe",
				reason,
			},
		});
		const bytes = await Bun.file(file).text();
		let probes = 0;
		// When the real loader is consumed by startup and later manual/scheduled checks.
		await startUpdateOrchestrator({
			...defaultOrchestratorRuntimeDeps,
			acquireOsStageControl: acquireTestOsStageControl,
			startupRetryClock: { wait: () => Promise.resolve() },
			now: () => 100,
			persist: saveOrchestratorState,
			isUpdateAdmissionReady: async () => true,
			proveOsWriterQuiescent: async () => {
				probes++;
				return true;
			},
		});
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: reason,
		});
		await runOrchestratorTick();
		await expect(checkUpdatesNow()).rejects.toHaveProperty(
			"code",
			"UPDATE_ORCHESTRATOR_INITIALIZING",
		);
		await expect(installUpdatesNow()).rejects.toHaveProperty(
			"code",
			"UPDATE_ORCHESTRATOR_INITIALIZING",
		);
		// Then no failure is erased, no automatic migration probes and the corrupt evidence survives.
		expect(getOrchestratorState()).toMatchObject({
			phase: "failed",
			failureReason: reason,
		});
		expect(probes).toBe(0);
		expect(await Bun.file(file).text()).toBe(bytes);
		await expect(loadOrchestratorState()).rejects.toMatchObject({
			name: "OrchestratorRecoveryLoadError",
			terminalState: { phase: "failed", failureReason: reason },
		});
	},
);

const RECORD = {
	candidateKey: "k",
	activeAttemptId: null,
	failedRounds: 1,
	nextRetryAt: null,
	mode: "unsafe",
	reason: "rauc_recovery_unproven",
} as const;
const invalidStates: readonly OrchestratorState[] = [
	{ ...initialOrchestratorState(0), osStageRecovery: RECORD },
	{
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "rauc_recovery_unproven",
		osStageRecovery: { ...RECORD, activeAttemptId: "orphan" },
	},
	{
		...initialOrchestratorState(0),
		phase: "os-staging",
		osStageRecovery: {
			...RECORD,
			mode: "automatic",
			activeAttemptId: "a",
			nextRetryAt: 100,
		},
	},
	{
		...initialOrchestratorState(0),
		phase: "os-available",
		osStageRecovery: { ...RECORD, mode: "operator", nextRetryAt: 100 },
	},
];

test.each([...invalidStates])(
	"H2-R2 refuses inconsistent recovery during startup %#",
	async (state) => {
		const dir = mkdtempSync(join(tmpdir(), "ceraui-recovery-consistency-"));
		dirs.push(dir);
		setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
		saveOrchestratorState(state);
		await startUpdateOrchestrator({
			...defaultOrchestratorRuntimeDeps,
			acquireOsStageControl: acquireTestOsStageControl,
			startupRetryClock: { wait: () => Promise.resolve() },
			persist: saveOrchestratorState,
			isUpdateAdmissionReady: async () => true,
		});
		expect(getOrchestratorState().phase).toBe("failed");
		expect(
			updateOrchestratorPersistedStateSchema.safeParse(toPersisted(state))
				.success,
		).toBe(false);
	},
);

test("H2-R2 leaves legacy package recovery unchanged when OS metadata is absent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-legacy-recovery-"));
	dirs.push(dir);
	setOrchestratorStateFilePathForTest(join(dir, "agent.json"));
	const legacy: OrchestratorState = {
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "commit_unit_absent_on_resume",
	};
	saveOrchestratorState(legacy);
	expect(await loadOrchestratorState()).toEqual(legacy);
	await startUpdateOrchestrator({
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		persist: saveOrchestratorState,
	});
	expect(getOrchestratorState()).toEqual(legacy);
});
