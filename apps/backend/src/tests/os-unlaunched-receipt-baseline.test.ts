import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readReceiptFile } from "../modules/system/update-orchestrator/os-receipt-file-identity.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	consumeOsUnlaunchedWitness,
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { settleOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-unlaunched-adapter.ts";
import { reduceOsUnlaunchedSettlement } from "../modules/system/update-orchestrator/os-unlaunched-state.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import type { OrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	GOOD_SLOTS,
	identifiedState,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const legacyBytes =
	'{"schema":1,"version":"2026.10.64","channel":"drill","stagedAt":1791464043236,"bootId":"070fd8ac-4a40-4b85-9d31-f21502ebd117"}';
const next = {
	...manifest,
	version: "2026.10.68",
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	bundle: {
		...manifest.bundle,
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.68/bundle.raucb",
	},
};

test.each(["unchanged", "identical replacement", "new outcome"] as const)(
	"attributes %s receipt against admission baseline",
	async (change) => {
		// Given a stale legacy .64 receipt and a positively identified never-launched next attempt.
		const dir = mkdtempSync("/var/tmp/ceraui-baseline-state-");
		const live = join(dir, "os-staged.json");
		writeFileSync(live, legacyBytes);
		const baseline = readReceiptFile(dir);
		if (!baseline) throw new Error("baseline fixture missing");
		const initial = identifiedState();
		if (!initial.osStageRecovery) throw new Error("recovery fixture missing");
		let state: OrchestratorState = {
			...initial,
			osStageRecovery: {
				...initial.osStageRecovery,
				candidateKey: osStageCandidateKey(next),
			},
		};
		const file = join(dir, "agent.json");
		saveOrchestratorState(state, file);
		const witnessDeps = {
			path: join(dir, "witness.json"),
			uid: process.getuid?.() ?? 0,
		};
		writeOsUnlaunchedWitness(
			{
				...input,
				manifestJson: JSON.stringify(next),
				receiptBaseline: baseline.identity,
			},
			witnessDeps,
		);
		let consumed = false;
		const port = {
			snapshot: () => ({
				state,
				generation: 1,
				candidate: undefined,
				producer: undefined,
			}),
			acquireControl: acquireTestOsStageControl,
			readWitness: () => readOsUnlaunchedWitness(witnessDeps),
			readEvidence: async () => ({
				raucOperation: "idle" as const,
				writerQuiescent: true,
				rootSlots: GOOD_SLOTS,
				healthyBootId: input.bootId,
				bootId: input.bootId,
				stagedReceiptPresent: true,
				activationArmed: false,
			}),
			readPersisted: async () => {
				if (change !== "unchanged") {
					writeFileSync(
						join(dir, "replacement"),
						change === "new outcome"
							? legacyBytes.replace("2026.10.64", "2026.10.68")
							: legacyBytes,
					);
					renameSync(join(dir, "replacement"), live);
				}
				return loadOrchestratorState(file);
			},
			readReceiptIdentity: () => readReceiptFile(dir)?.identity ?? null,
			dispatch: (event: Parameters<typeof reduceOsUnlaunchedSettlement>[1]) => {
				state = reduceOsUnlaunchedSettlement(state, event);
				saveOrchestratorState(state, file);
				return state;
			},
			persist: () => saveOrchestratorState(state, file),
			consume: (attemptId: string) => {
				consumeOsUnlaunchedWitness(attemptId, witnessDeps);
				consumed = true;
			},
			now: () => 1791465043236,
		};
		// When state-side recovery rechecks receipt attribution after final authority.
		const settled = await settleOsUnlaunchedWitness(port);
		// Then only the unchanged baseline permits retry; it is never deleted or consumed.
		expect(settled).toBe(change === "unchanged");
		expect(consumed).toBe(change === "unchanged");
		expect(state.phase).toBe(
			change === "unchanged" ? "os-available" : "failed",
		);
		expect(readFileSync(live, "utf8")).toBe(
			change === "new outcome"
				? legacyBytes.replace("2026.10.64", "2026.10.68")
				: legacyBytes,
		);
	},
);
