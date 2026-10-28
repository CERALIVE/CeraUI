import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createKernelRuntime,
	defaultKernelEffects,
	type KernelEffects,
} from "../modules/system/update-orchestrator/kernel-runtime.ts";
import type { KernelStageObservation } from "../modules/system/update-orchestrator/kernel-stage-job.ts";
import type {
	KernelState,
	SlotOverlay,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	KernelUpdateError,
	readKernelState,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import { slotSyncGate } from "../modules/system/update-orchestrator/slot-sync-gate.ts";
import {
	initialOrchestratorState,
	type OrchestratorPhase,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import {
	kernelCapabilities,
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";

function fixture(
	initial: Partial<OrchestratorState> = {},
	overrides: Partial<KernelEffects> = {},
) {
	let state = { ...initialOrchestratorState(0), ...initial };
	let device: KernelState | null = null;
	let overlay: SlotOverlay | null = kernelOverlay;
	let observation: KernelStageObservation = { kind: "absent" };
	let bootedSlot = "A";
	let busy = false;
	let live = false;
	let launches = 0;
	let acknowledgements = 0;
	const phases: OrchestratorPhase[] = [];
	const arms: boolean[] = [];
	const notices: string[] = [];
	const effects: KernelEffects = {
		...defaultKernelEffects,
		discover: async () => kernelRecord,
		readState: async () => device,
		readOverlay: async () => overlay,
		readBooted: async () => kernelRecord,
		download: async () => "/var/tmp/fixture/kernel.deb",
		launch: async () => {
			launches++;
			observation = { kind: "running" };
		},
		inspect: async () => observation,
		arm: async (now) => {
			arms.push(now);
		},
		acknowledge: () => {
			acknowledgements++;
			if (device) device = { ...device, acknowledged: true };
		},
		removeDownload: async () => {},
		notify: (notice) => {
			notices.push(notice.kind);
			return true;
		},
		...overrides,
	};
	const lane = createKernelRuntime({
		effects: () => effects,
		state: () => state,
		set: (patch) => {
			state = { ...state, ...patch };
			phases.push(state.phase);
		},
		now: () => Date.parse("2026-10-27T00:00:00Z"),
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
		busy: () => busy || live,
		bootedSlot: async () => bootedSlot,
		activate: async (_now, action) => {
			if (live) return false;
			await action();
			return true;
		},
	});
	return {
		lane,
		phases,
		arms,
		notices,
		state: () => state,
		launches: () => launches,
		acks: () => acknowledgements,
		device: (value: KernelState | null) => {
			device = value;
		},
		overlay: (value: SlotOverlay | null) => {
			overlay = value;
		},
		unit: (value: KernelStageObservation) => {
			observation = value;
		},
		slot: (value: string) => {
			bootedSlot = value;
		},
		busy: (value: boolean) => {
			busy = value;
		},
		live: (value: boolean) => {
			live = value;
		},
	};
}
test("kernel download and guarded staging persist exact attempt identity before launch", async () => {
	const f = fixture();
	expect(await f.lane.install(true)).toBe(true);
	expect(f.phases).toEqual(["kernel-downloading", "kernel-staging"]);
	expect(f.state().kernelAttempt?.deb).toBe("/var/tmp/fixture/kernel.deb");
	expect(f.launches()).toBe(1);
	expect(await f.lane.reconcile()).toBe(true);
	expect(f.state().phase).toBe("kernel-staging");
});
test.each([
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
	"syncing",
	"committing",
] as const)("kernel installation cannot overlap %s", async (phase) => {
	const f = fixture({ phase });
	expect(await f.lane.install(true)).toBe(false);
	expect(f.launches()).toBe(0);
});
test("stream admission cancels only kernel download and late download success cannot launch a stager", async () => {
	const started = Promise.withResolvers<void>();
	const complete = Promise.withResolvers<string>();
	let signal: AbortSignal | undefined;
	const f = fixture(
		{},
		{
			download: async (_record, abort) => {
				signal = abort;
				started.resolve();
				return complete.promise;
			},
		},
	);
	const installation = f.lane.install(true);
	await started.promise;
	f.lane.cancelDownload();
	complete.resolve("/var/tmp/fixture/kernel.deb");
	expect(await installation).toBe(false);
	expect(signal?.aborted).toBe(true);
	expect(f.state().phase).toBe("idle");
	expect(f.launches()).toBe(0);
});
test("stager failure reason surfaces without retrying or arming", async () => {
	const f = fixture({ phase: "kernel-staging" });
	f.device({ ...kernelState, state: "failed", reason: "missing_firmware" });
	f.unit({ kind: "terminal", exitCode: 75 });
	await f.lane.reconcile();
	expect(f.state()).toMatchObject({
		phase: "kernel-failed",
		failureReason: "missing_firmware",
	});
	expect(f.arms).toEqual([]);
	expect(f.launches()).toBe(0);
});
test("a hung stager submission retains staging exclusion until actual unit settlement", async () => {
	const f = fixture(
		{},
		{
			launch: async () => {
				throw new KernelUpdateError("kernel_staging_failed");
			},
		},
	);
	expect(await f.lane.install(true)).toBe(false);
	expect(f.state()).toMatchObject({
		phase: "kernel-staging",
		failureReason: "kernel_stage_ownership_unknown",
	});
	expect(f.lane.busy()).toBe(true);
	f.unit({ kind: "running" });
	await f.lane.reconcile();
	expect(f.state().phase).toBe("kernel-staging");
	f.device({
		...kernelState,
		attempt: f.state().kernelAttempt?.id ?? kernelState.attempt,
		state: "failed",
		reason: "kernel_stage_timeout",
	});
	f.unit({ kind: "terminal", exitCode: 143 });
	await f.lane.reconcile();
	expect(f.state()).toMatchObject({
		phase: "kernel-failed",
		failureReason: "kernel_stage_timeout",
	});
});
for (const [phase, deviceState, expected] of [
	["kernel-downloading", null, "kernel-failed"],
	["kernel-staging", "staging", "kernel-failed"],
	["kernel-staged", "staged", "kernel-staged"],
	["kernel-verifying", "activated", "kernel-verifying"],
	["kernel-succeeded", "succeeded", "idle"],
	["kernel-rolled-back", "rolled_back", "idle"],
	["kernel-failed", "failed", "idle"],
] as const) {
	test(`restart recovery settles ${phase} from device state without replaying install`, async () => {
		const f = fixture({ phase });
		if (deviceState) f.device({ ...kernelState, state: deviceState });
		if (deviceState === "succeeded") {
			f.slot("B");
			f.overlay({ ...kernelOverlay, status: "confirmed" });
		}
		await f.lane.reconcile();
		expect(f.state().phase).toBe(expected);
		expect(f.launches()).toBe(0);
	});
}
test("succeeded and rolled-back outcomes acknowledge without deleting producer evidence or blocking future updates", async () => {
	for (const outcome of ["succeeded", "rolled_back"] as const) {
		const f = fixture();
		f.device({ ...kernelState, state: outcome });
		if (outcome === "succeeded") {
			f.slot("B");
			f.overlay({ ...kernelOverlay, status: "confirmed" });
		}
		await f.lane.reconcile();
		expect(f.state().phase).toBe(
			outcome === "succeeded" ? "kernel-succeeded" : "kernel-rolled-back",
		);
		await f.lane.reconcile();
		expect(f.state().phase).toBe("idle");
		expect(f.acks()).toBe(1);
		expect(f.lane.busy()).toBe(false);
	}
});
test("seven-day escalation is submitted once and only while idle", async () => {
	const f = fixture();
	f.device({ ...kernelState, state: "armed" });
	f.live(true);
	await f.lane.reconcile();
	expect(f.arms).toEqual([]);
	f.live(false);
	await f.lane.reconcile();
	await f.lane.reconcile();
	expect(f.arms).toEqual([true]);
});
test("a 26-day armed record escalates from its retained staged timestamp despite a recent arm", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-aged-armed-"));
	await writeFile(
		join(directory, "kernel-state.json"),
		JSON.stringify({
			...kernelState,
			state: "armed",
			timestamps: {
				staging: "2026-09-30T23:00:00Z",
				staged: "2026-10-01T00:00:00Z",
				armed: "2026-10-26T23:59:00Z",
			},
		}),
	);
	const f = fixture(
		{ phase: "kernel-staged" },
		{
			readState: () => readKernelState(directory),
		},
	);
	try {
		f.live(true);
		await f.lane.reconcile();
		expect(f.arms).toEqual([]);
		f.live(false);
		await f.lane.reconcile();
		await f.lane.reconcile();
		expect(f.arms).toEqual([true]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("an armed record with only legacy timestamp labels fails closed instead of waiting forever", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-missing-staged-"));
	await writeFile(
		join(directory, "kernel-state.json"),
		JSON.stringify({
			...kernelState,
			state: "armed",
			timestamps: {
				started_at: "2026-10-01T00:00:00Z",
				updated_at: "2026-10-01T00:00:00Z",
			},
		}),
	);
	const f = fixture(
		{ phase: "kernel-staged" },
		{
			readState: () => readKernelState(directory),
		},
	);
	try {
		await expect(f.lane.reconcile()).rejects.toThrow();
		expect(f.arms).toEqual([]);
		expect(f.lane.busy()).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("runtime refuses an armed state missing the staged anchor instead of silently disabling escalation", async () => {
	const f = fixture({ phase: "kernel-staged" });
	f.device({
		...kernelState,
		state: "armed",
		timestamps: { armed: "2026-10-01T00:00:00Z" },
	});
	await expect(f.lane.reconcile()).rejects.toHaveProperty(
		"reason",
		"kernel_staged_timestamp_missing",
	);
	expect(f.arms).toEqual([]);
	expect(f.lane.busy()).toBe(true);
});
test("startup recovery follows an activating state without replaying install or activation", async () => {
	const f = fixture({ phase: "kernel-verifying" });
	f.device({
		...kernelState,
		state: "activating",
		boot_id_at_activation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		timestamps: {
			staging: "2026-10-20T00:00:00Z",
			staged: "2026-10-20T00:01:00Z",
			armed: "2026-10-20T00:02:00Z",
			activating: "2026-10-20T01:00:00Z",
		},
	});
	expect(await f.lane.reconcile()).toBe(true);
	expect(f.state().phase).toBe("kernel-verifying");
	expect(f.launches()).toBe(0);
	expect(f.arms).toEqual([]);
});
test("origin mismatch yields the named kernel failure before any privileged writer", async () => {
	const f = fixture(
		{},
		{
			download: async () => {
				throw new KernelUpdateError("kernel_origin_mismatch");
			},
		},
	);
	expect(await f.lane.install(true)).toBe(false);
	expect(f.state()).toMatchObject({
		phase: "kernel-failed",
		failureReason: "kernel_origin_mismatch",
	});
	expect(f.launches()).toBe(0);
});
test("OS and slot-sync cannot overwrite a pending kernel target", () => {
	for (const phase of [
		"kernel-downloading",
		"kernel-staging",
		"kernel-staged",
		"kernel-verifying",
	] as const) {
		const healthy = {
			boot_id: "boot",
			slot: "A",
			build_id: "build",
			dpkg_status_sha256: "a",
			recorded_at: "2026-10-01",
		};
		expect(
			slotSyncGate({
				phase,
				capabilities: { mode: "capable", features: ["slot-sync"] },
				healthyState: healthy,
				bootId: "boot",
				buildId: "build",
				statusSha256: "a",
				receiptStateSha256: null,
				receiptTarget: "other",
				receiptTargetSlot: "B",
				mirrorTarget: "good",
			}),
		).toEqual({ allowed: false, reason: "update-busy" });
	}
});
