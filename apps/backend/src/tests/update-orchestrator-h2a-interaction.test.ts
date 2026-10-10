import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import {
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	runOrchestratorTick,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { setUpdateAdmissionDeadlineTimerForTest } from "../modules/system/update-orchestrator/update-admission-deadline.ts";
import {
	cleanupRecovery,
	deferred,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const dirs: string[] = [];
afterEach(() => {
	cleanupRecovery();
	setUpdateAdmissionDeadlineTimerForTest(null);
	setOrchestratorStateFilePathForTest(null);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function admissionDeadline() {
	const armed = deferred<void>();
	const callbacks = new Set<() => void>();
	setUpdateAdmissionDeadlineTimerForTest((expire) => {
		callbacks.add(expire);
		armed.resolve();
		return () => {
			callbacks.delete(expire);
		};
	});
	return {
		armed: armed.promise,
		expire: () => {
			for (const callback of callbacks) callback();
		},
	};
}

test.each(["resolve", "reject"] as const)(
	"unsafe publication stays closed when a timed-out admission observer later %ss",
	async (completion) => {
		// Given a real commit callback and a producer retaining its published receipt.
		const published = deferred<void>();
		const release = deferred<void>();
		const observation = deferred<boolean>();
		const deadline = admissionDeadline();
		let blocked = false;
		let arms = 0;
		let receipt = false;
		await recoveryHarness({
			isUpdateAdmissionReady: () =>
				blocked ? observation.promise : Promise.resolve(true),
			armOs: async () => {
				arms++;
			},
			inspectOsOperation: async () => "idle",
			proveOsWriterQuiescent: async () => true,
			readRootSlots: async () => [
				{
					name: "rootfs.0",
					bootname: "A",
					state: "booted",
					bootStatus: "good",
					version: null,
					lastSyncedAt: null,
				},
				{
					name: "rootfs.1",
					bootname: "B",
					state: "inactive",
					bootStatus: "bad",
					version: null,
					lastSyncedAt: null,
				},
			],
			readHealthyState: async () => ({
				boot_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				slot: "A",
				build_id: "b",
				dpkg_status_sha256: "d".repeat(64),
				recorded_at: "2026-10-01T00:00:00Z",
			}),
			readBootId: async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			readActivationArmed: async () => false,
			readOsReceipt: async () =>
				receipt
					? {
							schema: 1,
							version: "2026.10.0",
							channel: "stable",
							stagedAt: 1,
							bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
						}
					: undefined,
			stageOs: async (_candidate, _progress, control) => {
				receipt = true;
				control?.commit?.({
					schema: 1,
					version: "2026.10.0",
					channel: "stable",
					stagedAt: 1,
					bootId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				});
				published.resolve();
				await release.promise;
				throw new OsStageError("rauc_recovery_unproven");
			},
		});
		const install = installUpdatesNow();
		await published.promise;
		try {
			blocked = true;
			const tick = runOrchestratorTick();
			const check = checkUpdatesNow();
			const contender = installUpdatesNow();
			await deadline.armed;
			// When unsafe release settles before the shared observer deadline.
			release.resolve();
			expect(await install).toEqual({
				started: false,
				reason: "not_available",
			});
			deadline.expire();
			await tick;
			expect(await check).toEqual({ started: false, reason: "busy" });
			expect(await contender).toEqual({ started: false, reason: "busy" });
			if (completion === "resolve") observation.resolve(true);
			else observation.reject(new OsStageError("rauc_recovery_unproven"));
			blocked = false;
			await runOrchestratorTick();
			expect(await checkUpdatesNow()).toEqual({
				started: false,
				reason: "busy",
			});
			// Then late observer completion/positive quiescence cannot promote the receipt.
			expect(getOrchestratorState()).toMatchObject({
				phase: "failed",
				failureReason: "rauc_recovery_unproven",
				osStageRecovery: {
					activeAttemptId: null,
					mode: "unsafe",
					failedRounds: 1,
				},
			});
			expect(arms).toBe(0);
			expect(receipt).toBe(true);
		} finally {
			release.resolve();
			observation.resolve(false);
			await install;
		}
	},
);

test("invalid legacy recovery cannot migrate after admission expiry and a fresh successful observer", async () => {
	// Given invalid new metadata whose terminal projection is the migratable legacy reason.
	const dir = mkdtempSync(join(tmpdir(), "ceraui-h2a-load-"));
	dirs.push(dir);
	const file = join(dir, "agent.json");
	setOrchestratorStateFilePathForTest(file);
	saveOrchestratorState({
		...initialOrchestratorState(0),
		phase: "failed",
		failureReason: "rauc_install_failed",
		osStageRecovery: {
			candidateKey: "k",
			activeAttemptId: null,
			failedRounds: 1,
			mode: "unsafe",
			nextRetryAt: 100,
			reason: "rauc_install_failed",
		},
	});
	const original = await Bun.file(file).text();
	const observation = deferred<boolean>();
	const deadline = admissionDeadline();
	let ready = false;
	let proofs = 0;
	await startUpdateOrchestrator({
		...defaultOrchestratorRuntimeDeps,
		acquireOsStageControl: acquireTestOsStageControl,
		startupRetryClock: { wait: () => Promise.resolve() },
		persist: saveOrchestratorState,
		isUpdateAdmissionReady: () =>
			ready ? Promise.resolve(true) : observation.promise,
		proveOsWriterQuiescent: async () => {
			proofs++;
			return true;
		},
	});
	// When a shared tick/check expires, then an old and a new observer report readiness.
	const tick = runOrchestratorTick();
	const check = expect(checkUpdatesNow()).rejects.toHaveProperty(
		"code",
		"UPDATE_ORCHESTRATOR_INITIALIZING",
	);
	await deadline.armed;
	deadline.expire();
	await tick;
	await check;
	observation.resolve(true);
	ready = true;
	await runOrchestratorTick();
	await expect(checkUpdatesNow()).rejects.toHaveProperty(
		"code",
		"UPDATE_ORCHESTRATOR_INITIALIZING",
	);
	// Then the invalid-load latch survives replacement; migration cannot clear the failure.
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		failureReason: "rauc_install_failed",
	});
	expect(proofs).toBe(0);
	expect(await Bun.file(file).text()).toBe(original);
});
