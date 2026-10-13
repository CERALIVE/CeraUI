import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repository from "../modules/system/apt-reachability.ts";
import * as device from "../modules/system/device-detection.ts";
import * as updates from "../modules/system/software-updates.ts";
import { readUpdateCapabilities } from "../modules/system/update-capabilities.ts";
import {
	checkUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { validCapabilities } from "./helpers/capability-authority-inputs.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

test("unknown device detection cannot grant emulated repository success in production", async () => {
	// Given a production package offer but no positive device identity and unknown repository evidence.
	await using h = await updateHarness();
	using _device = spyOn(device, "isRealDevice").mockResolvedValue(false);
	using probe = spyOn(repository, "probeAptReachability").mockResolvedValue(
		repository.deriveVerdict([]),
	);
	updates.resetAptReachabilityProbeForTest();
	let effects = 0;
	updates.setAptCommandRunnerForTest(async () => {
		effects++;
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	try {
		// When discovery uses the production network adapter.
		await updates.runUpdateDiscoveryAndReport();
		// Then file/detection absence cannot select a positive mock regime or admit package commands.
		expect(probe).toHaveBeenCalledTimes(1);
		expect(effects).toBe(0);
		expect(h.launches).toHaveLength(0);
	} finally {
		updates.setAptCommandRunnerForTest(null);
	}
});

test("manual check re-reads capability authority before the package effect port", async () => {
	// Given valid entry evidence followed by a corrupted declaration at the next authority read.
	const root = await mkdtemp(join(tmpdir(), "capability-check-late-"));
	const path = join(root, "capabilities.json");
	let reads = 0;
	let checks = 0;
	await writeFile(path, validCapabilities);
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			loadCapabilities: async () => {
				if (++reads === 2) await writeFile(path, "{");
				return readUpdateCapabilities(path);
			},
			quarantine: testQuarantine(),
			runPackageCheck: async () => {
				checks++;
				return null;
			},
		}),
	);
	try {
		// When admission's later read fails, then no package effect is submitted and the typed refusal survives.
		await expect(checkUpdatesNow()).rejects.toMatchObject({
			reason: "discovery_failed",
		});
		expect(checks).toBe(0);
	} finally {
		resetOrchestratorRuntimeForTest();
		await rm(root, { recursive: true, force: true });
		for (const dir of quarantineDirs.splice(0))
			await rm(dir, { recursive: true, force: true });
	}
});
