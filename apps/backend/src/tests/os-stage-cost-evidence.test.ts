import { afterEach, expect, test } from "bun:test";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	discoverCandidates,
	rankTransports,
} from "../modules/system/update-transport/core.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test.each(["unknown", "yes", "no"])(
	"OS pin cost=%s without candidate approval",
	async (cost) => {
		// Given a healthy connected Wi-Fi candidate with this observed cost.
		const h = await harness();
		const candidates = discoverCandidates(
			["wlan0"],
			`GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:${cost}`,
			[],
			[],
		);
		const selection = rankTransports(
			candidates.map((candidate) => ({
				candidate,
				family: 4 as const,
				hosts: [{ host: "fixture", state: "clear" as const, latencyMs: 1 }],
			})),
		);
		// When the real OS runner and pin controller decide admission.
		const result = runOsStageJob(manifest, h.control, {
			...h.deps,
			selection: async () => selection,
			attempt: (input) => ({
				...h.deps.attempt(input),
				cli: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
				outcome: Promise.resolve({
					kind: "succeeded" as const,
					result: { exitCode: 0, stdout: "", stderr: "" },
				}),
			}),
		});
		// Then only positively unmetered Wi-Fi can dispatch without the grant.
		if (cost === "no") expect(await result).toBe("receipt");
		else
			await expect(result).rejects.toHaveProperty(
				"reason",
				"os_cellular_approval_required",
			);
		expect(h.attempts()).toBe(cost === "no" ? 1 : 0);
	},
);

test.each(["unknown", "yes"])(
	"candidate approval permits cost=%s OS transfer",
	async (cost) => {
		const h = await harness();
		const candidates = discoverCandidates(
			["wlan0"],
			`GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:${cost}`,
			[],
			[],
		);
		const selection = rankTransports(
			candidates.map((candidate) => ({
				candidate,
				family: 4 as const,
				hosts: [{ host: "fixture", state: "clear" as const, latencyMs: 1 }],
			})),
		);
		expect(
			await runOsStageJob(
				manifest,
				{ ...h.control, cellularApproved: true },
				{
					...h.deps,
					selection: async () => selection,
					attempt: (input) => ({
						...h.deps.attempt(input),
						cli: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
						outcome: Promise.resolve({
							kind: "succeeded" as const,
							result: { exitCode: 0, stdout: "", stderr: "" },
						}),
					}),
				},
			),
		).toBe("receipt");
		expect(h.attempts()).toBe(1);
	},
);
