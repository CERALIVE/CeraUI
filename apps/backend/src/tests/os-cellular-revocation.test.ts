import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	allowCellularOnce,
	getOrchestratorState,
	getOsUpdateSummary,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	loadUpdateSettings,
	saveUpdateSettings,
} from "../modules/system/update-settings.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	candidate,
	settings,
	setup,
} from "./helpers/os-agent-runtime-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { ranking } from "./helpers/os-stage-run-inputs.ts";

useSessionOwnerForFile();
const dir = mkdtempSync(join(tmpdir(), "os-consent-revocation-"));
const file = join(dir, "update-settings.json");
const sidecar = join(dir, "update-image-channel.json");
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	rmSync(file, { force: true });
	rmSync(sidecar, { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

for (const boundary of ["idle", "ready"] as const) {
	test.each([
		"enabled",
		"revoked",
		"unreadable",
		"override",
		"other-candidate",
	] as const)(
		`automatic OS download at ${boundary} honors %s consent`,
		async (choice) => {
			saveUpdateSettings(settings, file);
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const pause = async () => {
				entered.resolve();
				await resume.promise;
			};
			let downloads = 0;
			setup({
				loadSettings: () => loadUpdateSettings(file),
				isIdle: async () => {
					if (boundary === "idle") await pause();
					return true;
				},
				isOsStageReady: async () => {
					if (boundary === "ready") await pause();
					return true;
				},
				onlyMeteredCandidateExists: async () => true,
				stageOs: async () => {
					downloads++;
				},
			});
			if (choice === "override") allowCellularOnce(candidate.version);
			else if (choice === "other-candidate")
				allowCellularOnce(`${candidate.version}-old`);
			const install = runOrchestratorTick().catch((error: unknown) => error);
			await entered.promise;
			if (
				choice === "revoked" ||
				choice === "override" ||
				choice === "other-candidate"
			)
				saveUpdateSettings(
					{ ...settings, allowSystemOverCellular: false },
					file,
				);
			else if (choice === "unreadable") writeFileSync(sidecar, "{damaged");
			resume.resolve();
			await install;

			const allowed = choice === "enabled" || choice === "override";
			expect(downloads).toBe(allowed ? 1 : 0);
			expect(getOrchestratorState().phase).toBe(
				allowed ? "os-staged" : "os-available",
			);
			if (choice === "revoked" || choice === "other-candidate")
				expect(getOsUpdateSummary().pendingCellular).toEqual({
					id: candidate.version,
					sizeBytes: candidate.bundle.size,
				});
			if (allowed) expect(getOrchestratorState().cellularOverrideId).toBeNull();
		},
	);
}

test.each(["enabled", "revoked", "override"] as const)(
	"automatic OS admission carries %s consent through real job preparation",
	async (choice) => {
		saveUpdateSettings(settings, file);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const h = await harness();
		let paused = false;
		setup({
			loadSettings: () => loadUpdateSettings(file),
			onlyMeteredCandidateExists: async () => true,
			stageOs: async (manifest, _progress, control) => {
				if (!control) throw new Error("missing stage control");
				await runOsStageJob(manifest, control, {
					...h.deps,
					selection: async () =>
						ranking([h.attempts() === 0 ? "wlan0" : "eth0"], true),
					revalidate: async () => {
						if (paused) return;
						paused = true;
						entered.resolve();
						await resume.promise;
					},
				});
			},
		});
		if (choice === "override") allowCellularOnce(candidate.version);
		const install = runOrchestratorTick();
		await entered.promise;
		if (choice !== "enabled")
			saveUpdateSettings({ ...settings, allowSystemOverCellular: false }, file);
		resume.resolve();
		await install;

		const allowed = choice !== "revoked";
		expect(h.attempts()).toBe(allowed ? 2 : 0);
		expect(getOrchestratorState().phase).toBe(
			allowed ? "os-staged" : "os-available",
		);
		if (!allowed)
			expect(getOrchestratorState().failureReason).toBe(
				"os_cellular_approval_required",
			);
		expect(h.events).toContain("release");
		expect(getOrchestratorState().cellularOverrideId).toBeNull();
	},
);
