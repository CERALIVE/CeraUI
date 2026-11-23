import { afterEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { logger } from "../helpers/logger.ts";
import * as apt from "../modules/system/software-updates.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	notificationExists,
	notificationSend,
	notificationWithdraw,
} from "../modules/ui/notifications.ts";
import {
	fakeDeps,
	quarantineDirs,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { capabilities } from "./helpers/os-recovery-harness.ts";
import { offeredPackages } from "./helpers/package-scoped-install.ts";

const OLD = "update:updates-available:curl=2";
const NEW = "update:updates-available:cerastream=2026.10.1,informational=2";
const NOW = 1_000_000;

afterEach(async () => {
	apt.setAptCommandRunnerForTest(null);
	resetOrchestratorRuntimeForTest();
	notificationWithdraw(OLD);
	notificationWithdraw(NEW);
	for (const dir of quarantineDirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

test.each(["manual", "scheduled"] as const)(
	"%s package check finishes and reports an unexpected notice proof error",
	async (kind) => {
		const error = new TypeError("unexpected retirement fault");
		using _discovery = spyOn(apt, "isAptAllDiscovery").mockReturnValue(true);
		using warning = spyOn(logger, "warn");
		notificationSend(undefined, OLD, "info", "updates", 0, true);
		apt.setAptCommandRunnerForTest(async (argv) => {
			if (argv[0] === "dpkg-query") throw error;
			return { exitCode: 0, stdout: "arm64\n", stderr: "" };
		});
		const deps = fakeDeps({
			now: () => NOW,
			isUpdateAdmissionReady: async () => true,
			loadCapabilities: async () => capabilities,
			getPackageInstallWireState: () =>
				kind === "manual" ? { kind: "idle" } : offeredPackages,
			quarantine: testQuarantine(),
		});
		setOrchestratorRuntimeDepsForTest(deps);
		setOrchestratorStateForTest(initialOrchestratorState(NOW));

		if (kind === "manual") {
			await expect(checkUpdatesNow()).resolves.toEqual({ started: true });
			expect(getOrchestratorState().osCheck.lastSuccessAt).toBe(NOW);
		} else {
			await expect(runOrchestratorTick()).resolves.toBeUndefined();
			expect(notificationExists(NEW)).toBeDefined();
		}
		expect(getOrchestratorState().packageCheck.lastSuccessAt).toBe(NOW);
		expect(notificationExists(OLD)).toBeDefined();
		expect(warning).toHaveBeenCalledWith(expect.any(String), { error });
	},
);
