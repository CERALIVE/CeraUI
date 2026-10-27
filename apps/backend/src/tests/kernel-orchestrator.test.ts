import { afterEach, expect, test } from "bun:test";
import { defaultKernelEffects } from "../modules/system/update-orchestrator/kernel-runtime.ts";
import {
	type KernelState,
	KernelUpdateError,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	kernelCapabilities,
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";
import { fakeDeps } from "./helpers/orchestrator-runtime-harness.ts";
import { setup as setupOs } from "./helpers/os-agent-runtime-harness.ts";

useSessionOwnerForFile();
afterEach(resetOrchestratorRuntimeForTest);
test("real runtime routes scoped kernel install, continues local staging during Go Live, and arms only confirmed staging", async () => {
	let record: KernelState | null = null;
	let attempt = kernelState.attempt;
	let running = false;
	let osStages = 0;
	let mirrors = 0;
	const arms: boolean[] = [];
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			loadCapabilities: async () => kernelCapabilities,
			isUpdateAdmissionReady: async () => true,
			stageOs: async () => {
				osStages++;
			},
			startSlotSync: async () => {
				mirrors++;
			},
			readRootSlots: async () => [
				{
					name: "rootfs.0",
					bootname: "A",
					state: "booted",
					bootStatus: "good",
					version: "2026.10.0",
					lastSyncedAt: null,
				},
			],
			kernel: {
				...defaultKernelEffects,
				discover: async () => kernelRecord,
				readState: async () => record,
				readBooted: async () => ({
					...kernelRecord,
					version: "7.2.0-ceralive1",
				}),
				readOverlay: async () => ({ ...kernelOverlay, attempt }),
				download: async () => "/var/tmp/fixture/kernel.deb",
				launch: async (value) => {
					attempt = value.id;
					running = true;
				},
				inspect: async () =>
					running ? { kind: "running" } : { kind: "terminal", exitCode: 0 },
				arm: async (now) => {
					arms.push(now);
				},
				removeDownload: async () => {},
				acknowledge: () => {},
				notify: () => true,
			},
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(0));
	expect(await installUpdatesNow({ scope: "kernel" })).toEqual({
		started: true,
	});
	expect(getOrchestratorState().phase).toBe("kernel-staging");
	expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
	expect(await installUpdatesNow()).toEqual({ started: false, reason: "busy" });
	expect(osStages).toBe(0);
	expect(mirrors).toBe(0);
	running = false;
	record = {
		...kernelState,
		attempt,
		timestamps: { staged: new Date(1_000_000).toISOString() },
	};
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("kernel-staged");
	expect(arms).toEqual([false]);
	expect(mirrors).toBe(0);
});
test("real runtime surfaces OS kernel downgrade as the named refusal", async () => {
	setupOs({
		stageOs: async () => {
			throw new KernelUpdateError("os_kernel_downgrade");
		},
	});
	expect(await installUpdatesNow()).toEqual({
		started: false,
		reason: "not_available",
	});
	expect(getOrchestratorState()).toMatchObject({
		phase: "idle",
		failureReason: "os_kernel_downgrade",
	});
});
