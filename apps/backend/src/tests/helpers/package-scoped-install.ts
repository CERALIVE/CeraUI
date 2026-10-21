import { rmSync } from "node:fs";
import type { UpdateState } from "@ceraui/rpc/schemas";
import {
	type getOrchestratorState,
	type OrchestratorRuntimeDeps,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../../modules/system/update-orchestrator/types.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./orchestrator-runtime-harness.ts";

export const offeredPackages: UpdateState = {
	kind: "available",
	identity: { version: "pkg", packages: ["cerastream", "informational"] },
	package_count: 2,
	actionable_count: 1,
	packages: [
		{
			name: "cerastream",
			version: "2026.10.1",
			layer: "app",
			actionable: true,
		},
		{
			name: "informational",
			version: "2",
			layer: "platform",
			actionable: false,
		},
	],
};

export function scopedFixture(
	overrides: Partial<OrchestratorRuntimeDeps> = {},
) {
	let launches = 0;
	let stages = 0;
	const quarantine = testQuarantine();
	const deps = fakeDeps({
		quarantine,
		isUpdateAdmissionReady: async () => true,
		loadCapabilities: async () => ({
			mode: "capable",
			features: ["apt-all-packages", "rauc-verity-streaming"],
		}),
		getPackageInstallWireState: () => offeredPackages,
		isIdle: async () => {
			throw new Error("manual package install must bypass idle");
		},
		startPackageInstall: () => {
			launches++;
			return { started: true };
		},
		stageOs: async () => {
			stages++;
		},
		readOsReceipt: async () => undefined,
		...overrides,
	});
	setOrchestratorRuntimeDepsForTest(deps);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "available",
	});
	return { deps, quarantine, launches: () => launches, stages: () => stages };
}

export function movePhase(
	phase: ReturnType<typeof getOrchestratorState>["phase"],
): void {
	setOrchestratorStateForTest({ ...initialOrchestratorState(0), phase });
}

export function cleanScopedFixture(): void {
	resetOrchestratorRuntimeForTest();
	for (const dir of quarantineDirs.splice(0)) rmSync(dir, { recursive: true });
}
