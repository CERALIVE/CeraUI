import { afterEach, expect, test } from "bun:test";
import {
	setOsStageEntryDepsForTest,
	stageOsBundle,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(() => {
	cleanupRecovery();
	setOsStageEntryDepsForTest(null);
});

test.each(["before publication", "during final helper wait"])(
	"the product entry keeps successful unpublished CLI unsafe when cancelled %s",
	async (boundary) => {
		// Given the sole production entry with synthetic trusted manifest I/O and the actual runner.
		const h = await harness();
		let publishing = false;
		let retired = false;
		setOsStageEntryDepsForTest({
			settings: async () => ({
				packagesAuto: false,
				systemAuto: true,
				channel: "stable",
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
			}),
			readSigned: async () => ({
				data: new TextEncoder().encode(JSON.stringify(manifest)),
				signature: new Uint8Array([1]),
				context: {
					board: manifest.board,
					compatible: manifest.compatible,
					channel: manifest.channel,
					serial: manifest.serial - 1,
					bootedVersion: "2026.10.0",
					installedVersion: "2026.9.3",
					now: Date.parse("2026-10-02T00:00:00Z"),
				},
				verification: {
					verifyCms: async () => ({
						cn: "CeraLive OTA Manifest Signer",
						eku: ["codeSigning"],
						issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
					}),
					compare: async (left, right) => left > right,
					isQuarantined: async () => false,
				},
			}),
			board: async () => ({
				board: manifest.board,
				compatible: manifest.compatible,
			}),
			booted: async () => "2026.10.0",
			compare: async (left, right) => left > right,
			runJob: async (offer, control) => {
				await runOsStageJob(offer, control, {
					...h.deps,
					prepareReceipt: async () => {
						publishing = true;
						if (boundary === "before publication") h.signal.abort();
						return h.deps.prepareReceipt();
					},
					observe: async (...args) => {
						const snapshot = await h.deps.observe(...args);
						return publishing &&
							boundary === "during final helper wait" &&
							!retired &&
							snapshot
							? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
							: snapshot;
					},
					sleep: async (ms) => {
						retired = true;
						h.signal.abort();
						await h.deps.sleep(ms);
					},
				});
				throw new Error("cancelled producer must not return a receipt");
			},
		});
		// When cancellation wins after successful CLI but before any publication.
		await expect(
			stageOsBundle(manifest, () => undefined, h.control),
		).rejects.toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
		});
		// Then the agent receives existing unsafe policy, never a cancelled/manual-restage grant.
		expect(h.attempts()).toBe(2);
		expect(h.events).not.toContain("receipt+serial+OS_STAGED");
		expect(h.events).toContain("release");
	},
);
