import {
	createKernelRuntime,
	defaultKernelEffects,
	type KernelEffects,
	type KernelRuntimePort,
} from "../../modules/system/update-orchestrator/kernel-runtime.ts";
import type { KernelAttempt } from "../../modules/system/update-orchestrator/kernel-stage-job.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../../modules/system/update-orchestrator/types.ts";
import {
	kernelCapabilities,
	kernelRecord,
	kernelState,
} from "./kernel-update-fixture.ts";

export const attemptB: KernelAttempt = {
	id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	package: kernelRecord.package,
	version: "7.2.0-ceralive3",
	deb_sha256: kernelRecord.deb_sha256,
	deb: null,
};

export function attemptFixture(
	initial: Partial<OrchestratorState> = {},
	overrides: Partial<KernelEffects> = {},
	bootedSlot = "A",
) {
	let state = { ...initialOrchestratorState(0), ...initial };
	const effects: KernelEffects = {
		...defaultKernelEffects,
		discover: async () => ({ ...kernelRecord, version: attemptB.version }),
		readState: async () => ({
			...kernelState,
			state: "succeeded",
			acknowledged: true,
		}),
		readBooted: async () => kernelRecord,
		readOverlay: async () => null,
		ensureHealthyState: async () => undefined,
		download: async () => "/var/tmp/fixture/kernel.deb",
		launch: async () => undefined,
		inspect: async () => ({ kind: "terminal", exitCode: 0 }),
		arm: async () => undefined,
		acknowledge: () => undefined,
		removeDownload: async () => undefined,
		notify: () => true,
		...overrides,
	};
	const port: KernelRuntimePort = {
		state: () => state,
		set: (patch) => {
			state = { ...state, ...patch };
		},
		now: () => Date.parse("2026-10-20T00:00:00Z"),
		effects: () => effects,
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
		bootedSlot: async () => bootedSlot,
		activate: async () => false,
	};
	return { lane: createKernelRuntime(port), port, effects };
}
