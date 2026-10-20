import { afterEach, expect, test } from "bun:test";
import { OsAgentError } from "../modules/system/update-orchestrator/os-identity.ts";
import { validateSignedOsManifest } from "../modules/system/update-orchestrator/os-manifest.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	getOrchestratorState,
	getOsUpdateSummary,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	cleanupRecovery,
	recoveryHarness,
} from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("an unclassified pre-install timeout cannot manufacture transport evidence", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			revalidate: async () => {
				throw Object.assign(new Error("validation timeout"), {
					code: "ETIMEDOUT",
				});
			},
		}),
	).rejects.toHaveProperty("reason", "rauc_install_failed");
	expect(h.attempts()).toBe(0);
	expect(h.deps.pin.unhealthyUntil("wlan0", 4)).toBeUndefined();
});

test.each([
	["stale", { serial: manifest.serial - 1 }, "serial_replayed"],
	["expired", { expires_at: "2026-10-01T00:00:00Z" }, "expired"],
	["changed", { serial: manifest.serial + 1 }, "manifest_changed_before_stage"],
	["quarantined", {}, "version_quarantined"],
	["same version", {}, "downgrade_or_same"],
] as const)(
	"integrated characterization: %s signed pointer revalidation invalidates C's offer before write",
	async (_kind, change, refusal) => {
		// Given a freshly read trusted pointer invalidating the cached offer.
		const h = await harness();
		const cause = new OsAgentError(refusal);
		const stageDeps = {
			...h.deps,
			revalidate: async () => {
				const result = await validateSignedOsManifest(
					new TextEncoder().encode(JSON.stringify({ ...manifest, ...change })),
					new Uint8Array([1]),
					{
						board: manifest.board,
						compatible: manifest.compatible,
						channel: manifest.channel,
						serial: manifest.serial - 1,
						bootedVersion:
							refusal === "downgrade_or_same" ? manifest.version : "2026.9.0",
						installedVersion: "2026.9.3",
						now: Date.parse("2026-10-02T00:00:00Z"),
					},
					{
						verifyCms: async () => ({
							cn: "CeraLive OTA Manifest Signer",
							eku: ["codeSigning"],
							issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
						}),
						compare: async (newer, older) => newer !== older,
						isQuarantined: async () => refusal === "version_quarantined",
					},
				);
				if (!result.ok) {
					if (refusal === "manifest_changed_before_stage")
						throw new Error("changed pointer should pass strict admission");
					expect(result.reason).toBe(refusal);
					throw cause;
				}
				expect(result.manifest.serial).not.toBe(manifest.serial);
				throw cause;
			},
		};
		await recoveryHarness({
			checkOsManifest: async () => ({
				available: true,
				failed: false,
				rateLimited: false,
				reason: "",
				manifest,
			}),
			stageOs: async (candidate, _progress, control) => {
				if (!control) throw new Error("missing stage control");
				try {
					await runOsStageJob(candidate, control, stageDeps);
				} catch (error) {
					expect(error).toMatchObject({
						reason: "rauc_install_failed",
						mode: "operator",
						cause,
					});
					throw error;
				}
			},
		});
		// When B's real job executes strict per-pair revalidation through C's runtime.
		await runOrchestratorTick();
		// CR deliberately flips ACB's operator-pause characterization: the exact
		// pre-write marker now drops the offer AFTER B's safe guardian release.
		expect(getOrchestratorState().phase).toBe("idle");
		expect(getOrchestratorState().osStageRecovery).toBeUndefined();
		expect(getOsUpdateSummary().candidate).toBeNull();
		expect(h.attempts()).toBe(0);
		expect(h.events).toContain("release");
		expect(h.events).not.toContain("prepare-receipt");
	},
);
