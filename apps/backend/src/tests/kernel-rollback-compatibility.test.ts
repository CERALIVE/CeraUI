import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernelRuntime } from "../modules/system/update-orchestrator/kernel-runtime.ts";
import {
	type KernelState,
	KernelUpdateError,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	OrchestratorRecoveryLoadError as OldRecoveryError,
	loadOrchestratorState as oldLoad,
	toPersisted as oldPersisted,
	saveOrchestratorState as oldSave,
} from "./fixtures/kernel-reader-044bdd49/persistence.ts";
import { attemptB, attemptFixture } from "./helpers/kernel-attempt-fixture.ts";
import {
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";

test.each([
	"downloading",
	"failed",
	"staged",
	"installed",
	"rolled_back",
	"cancelled",
	"stage_failed",
] as const)(
	"old strict reader accepts every new writer snapshot for %s",
	async (scenario) => {
		const directory = await mkdtemp(join(tmpdir(), "kernel-rollback-reader-"));
		const entered = Promise.withResolvers<void>();
		const downloaded = Promise.withResolvers<string>();
		let device: KernelState = {
			...kernelState,
			state: "succeeded",
			acknowledged: true,
			target_slot: "A",
			booted_slot_at_stage: "B",
		};
		let booted = kernelRecord;
		let slot = "A";
		const f = attemptFixture(
			{},
			{
				readState: async () => device,
				readBooted: async () => booted,
				readOverlay: async () => ({
					...kernelOverlay,
					attempt: device.attempt,
					kernel: { ...kernelOverlay.kernel, version: device.version },
					status: device.state === "succeeded" ? "confirmed" : "pending",
				}),
				download: async () => {
					entered.resolve();
					const path = await downloaded.promise;
					if (scenario === "failed")
						throw new KernelUpdateError("kernel_download_failed");
					return path;
				},
				launch: async (attempt) => {
					device = {
						...kernelState,
						attempt: attempt.id,
						version: attempt.version,
					};
				},
				acknowledge: () => {
					device = { ...device, acknowledged: true };
				},
			},
		);
		const snapshots: { path: string; state: OrchestratorState }[] = [];
		const lane = createKernelRuntime({
			...f.port,
			bootedSlot: async () => slot,
			set: (patch) => {
				f.port.set(patch);
				const state = f.port.state();
				const path = join(directory, `${snapshots.length}.json`);
				saveOrchestratorState(state, path);
				snapshots.push({ path, state });
			},
		});
		let installing: Promise<boolean> | undefined;
		try {
			await lane.reconcile();
			installing = lane.install(true);
			await entered.promise;
			if (scenario === "downloading" || scenario === "cancelled")
				lane.cancelDownload();
			downloaded.resolve("/var/tmp/fixture/kernel.deb");
			expect(await installing).toBe(
				!["failed", "downloading", "cancelled"].includes(scenario),
			);
			if (scenario === "installed") {
				device = { ...device, state: "succeeded" };
				booted = { ...kernelRecord, version: attemptB.version };
				slot = "B";
			} else if (scenario === "rolled_back") {
				device = {
					...device,
					state: "rolled_back",
					reason: "kernel_boot_failed",
				};
			} else if (scenario === "stage_failed") {
				device = {
					...device,
					state: "failed",
					reason: "kernel_staging_failed",
				};
			}
			await lane.reconcile();
			if (scenario !== "staged") await lane.reconcile();

			const last = snapshots.at(-1);
			if (!last) throw new Error("No kernel state was written");
			for (const snapshot of snapshots) {
				expect(await oldLoad(snapshot.path)).toEqual(snapshot.state);
				expect(await loadOrchestratorState(snapshot.path)).toEqual(
					snapshot.state,
				);
			}
			expect(await oldLoad(last.path)).toMatchObject({
				kernelAttempt: { version: attemptB.version },
			});
			if (scenario === "failed")
				expect(await oldLoad(last.path)).toMatchObject({
					phase: "idle",
					failureReason: "kernel_interrupted",
				});
		} finally {
			downloaded.resolve("/var/tmp/fixture/kernel.deb");
			await installing;
			await rm(directory, { recursive: true });
		}
	},
);

test.each([
	"kernel-downloading",
	"kernel-failed",
	"kernel-staged",
	"kernel-succeeded",
	"kernel-rolled-back",
	"idle",
] as const)(
	"new reader accepts old writer bytes at %s without new data",
	async (phase) => {
		const directory = await mkdtemp(join(tmpdir(), "kernel-old-writer-"));
		try {
			const file = join(directory, "agent.json");
			const state: OrchestratorState = {
				...initialOrchestratorState(0),
				phase,
				failureReason:
					phase === "kernel-failed" ? "kernel_download_failed" : null,
				kernelAttempt: attemptB,
			};
			oldSave(state, file);
			expect(await loadOrchestratorState(file)).toEqual(state);
		} finally {
			await rm(directory, { recursive: true });
		}
	},
);

test("frozen rollback reader still rejects the attempt-2-only nested field", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-old-strict-"));
	try {
		const file = join(directory, "agent.json");
		await writeFile(
			file,
			JSON.stringify({
				...oldPersisted(initialOrchestratorState(0)),
				kernelAttempt: { ...attemptB, failureReason: "kernel_download_failed" },
			}),
		);
		await expect(oldLoad(file)).rejects.toBeInstanceOf(OldRecoveryError);
	} finally {
		await rm(directory, { recursive: true });
	}
});
