import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateCapabilities } from "../modules/system/update-capabilities.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import * as storage from "../modules/system/update-orchestrator/stored-state-file.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { deriveUpdateIdentity } from "../modules/system/update-state.ts";
import {
	capabilityVariants,
	validCapabilities,
} from "./helpers/capability-authority-inputs.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";

for (const action of [
	"scheduled-install",
	"manual-install",
	"manual-check",
	"scheduled-check",
] as const) {
	test.each(capabilityVariants)(
		`${action} submits zero work when capability authority is %s`,
		async (kind, bytes) => {
			// Given eligible automation and a nonempty prior package offer, but unknown regime authority.
			const root = await mkdtemp(join(tmpdir(), "capability-scheduler-"));
			const path = join(root, "capabilities.json");
			await writeFile(path, bytes);
			if (kind === "ELOOP") {
				await rm(path);
				await symlink("capabilities.json", path);
			}
			const original = storage.readStoredStateJson;
			using _reader = spyOn(storage, "readStoredStateJson").mockImplementation(
				async (file, limit) => {
					if (file === path && (kind === "EIO" || kind === "EACCES"))
						throw Object.assign(new Error("fixture read failure"), {
							code: kind,
						});
					return original(file, limit);
				},
			);
			let installs = 0;
			let checks = 0;
			setOrchestratorRuntimeDepsForTest(
				fakeDeps({
					loadCapabilities: () => readUpdateCapabilities(path),
					quarantine: testQuarantine(),
					getPackageInstallWireState: () => ({
						kind: "available",
						identity: deriveUpdateIdentity(["cerastream"], 1),
						package_count: 1,
						actionable_count: 1,
						packages: [{ name: "cerastream", layer: "app", actionable: true }],
					}),
					startPackageInstall: () => {
						installs++;
						return { started: true };
					},
					runPackageCheck: async () => {
						checks++;
						return null;
					},
				}),
			);
			setOrchestratorStateForTest({
				...initialOrchestratorState(1_000_000),
				phase:
					action === "scheduled-install"
						? "awaiting-idle"
						: action === "manual-install"
							? "available"
							: "idle",
			});
			try {
				// When production scheduling or manual admission reads the actual capability boundary.
				if (action === "scheduled-install") await runOrchestratorTick();
				else if (action === "manual-install") await installUpdatesNow();
				else if (action === "manual-check") await checkUpdatesNow();
				else await runOrchestratorTick();
				// Then no discovery/installer port is called and no transaction phase is entered.
				expect(installs).toBe(0);
				expect(checks).toBe(0);
				expect(["downloading", "committing"]).not.toContain(
					getOrchestratorState().phase,
				);
				if (kind !== "ELOOP")
					expect(await readFile(path)).toEqual(Buffer.from(bytes));
			} finally {
				resetOrchestratorRuntimeForTest();
				await rm(root, { recursive: true, force: true });
				for (const dir of quarantineDirs.splice(0))
					await rm(dir, { recursive: true, force: true });
			}
		},
	);
}

test.each(["absent", "valid"])(
	"scheduler preserves %s legacy regime control",
	async (kind) => {
		// Given genuine legacy authority and an eligible queued install.
		const root = await mkdtemp(join(tmpdir(), "capability-scheduler-control-"));
		const path = join(root, "capabilities.json");
		let installs = 0;
		try {
			if (kind === "valid") await writeFile(path, validCapabilities);
			setOrchestratorRuntimeDepsForTest(
				fakeDeps({
					loadCapabilities: () => readUpdateCapabilities(path),
					quarantine: testQuarantine(),
					startPackageInstall: () => {
						installs++;
						return { started: true };
					},
				}),
			);
			setOrchestratorStateForTest({
				...initialOrchestratorState(1_000_000),
				phase: "awaiting-idle",
			});
			// When scheduled, then legacy control still submits exactly one install.
			await runOrchestratorTick();
			expect(installs).toBe(1);
		} finally {
			resetOrchestratorRuntimeForTest();
			await rm(root, { recursive: true, force: true });
			for (const dir of quarantineDirs.splice(0))
				await rm(dir, { recursive: true, force: true });
		}
	},
);
