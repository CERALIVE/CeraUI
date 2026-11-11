import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createKernelRuntime,
	defaultKernelEffects,
	type KernelRuntimePort,
} from "../modules/system/update-orchestrator/kernel-runtime.ts";
import {
	type KernelState,
	KernelUpdateError,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	kernelCapabilities,
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";

test.each(["succeeded", "failed"] as const)(
	"#419 a newer failed download reports its own version after a %s attempt, retry and restart",
	async (outcome) => {
		let state = initialOrchestratorState(0);
		let device: KernelState | null = null;
		let offered = kernelRecord;
		const port: KernelRuntimePort = {
			state: () => state,
			set: (patch) => {
				state = { ...state, ...patch };
			},
			now: () => 0,
			capabilities: async () => kernelCapabilities,
			settings: async () => ({
				packagesAuto: true,
				systemAuto: true,
				channel: "stable",
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			idle: async () => true,
			metered: async () => false,
			busy: () => false,
			bootedSlot: async () => (outcome === "succeeded" ? "B" : "A"),
			activate: async () => false,
			effects: () => ({
				...defaultKernelEffects,
				discover: async () => offered,
				readState: async () => device,
				readOverlay: async () => ({
					...kernelOverlay,
					attempt: device?.attempt ?? kernelState.attempt,
					status: "confirmed",
				}),
				readBooted: async () => kernelRecord,
				ensureHealthyState: async () => {},
				download: async (record) => {
					if (record.version !== kernelRecord.version)
						throw new KernelUpdateError("kernel_download_failed");
					return "/var/tmp/fixture/kernel.deb";
				},
				launch: async (attempt) => {
					device = {
						...kernelState,
						attempt: attempt.id,
						state: outcome,
						reason: outcome === "failed" ? "kernel_staging_failed" : null,
					};
				},
				inspect: async () => ({ kind: "terminal", exitCode: 0 }),
				acknowledge: () => {
					if (device) device = { ...device, acknowledged: true };
				},
				removeDownload: async () => {},
				notify: () => true,
			}),
		};
		const lane = createKernelRuntime(port);

		expect(await lane.install(true)).toBe(true);
		await lane.reconcile();
		await lane.reconcile();
		expect(state.phase).toBe("idle");
		expect((await lane.summary()).version).toBe(kernelRecord.version);

		offered = { ...kernelRecord, version: "7.2.0-ceralive3" };
		await lane.check();
		expect(await lane.install(true)).toBe(false);
		expect(state).toMatchObject({
			phase: "kernel-failed",
			failureReason: "kernel_download_failed",
		});
		expect(await lane.summary()).toMatchObject({
			candidate: null,
			version: offered.version,
		});

		// The old device record remains intact when the download never reaches staging.
		expect(device).toMatchObject({ version: kernelRecord.version });
		await lane.reconcile();
		expect(await lane.summary()).toMatchObject({
			state: "failed",
			version: offered.version,
			reason: "kernel_download_failed",
		});
		await lane.check();
		expect(await lane.install(true)).toBe(false);
		expect((await lane.summary()).version).toBe(offered.version);

		// A new runtime rehydrates the retained record alongside the persisted attempt.
		const directory = await mkdtemp(join(tmpdir(), "kernel-attempt-restart-"));
		try {
			const file = join(directory, "agent.json");
			saveOrchestratorState(state, file);
			const loaded = await loadOrchestratorState(file);
			if (loaded === null) throw new Error("Persisted attempt missing");
			state = loaded;
			const restarted = createKernelRuntime(port);
			await restarted.reconcile();
			expect((await restarted.summary()).version).toBe(offered.version);
			expect(await restarted.summary()).toMatchObject({
				state: "failed",
				reason: "kernel_download_failed",
			});
		} finally {
			await rm(directory, { recursive: true });
		}
	},
);
