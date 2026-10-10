import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStagedReceiptEvidence } from "../modules/system/update-orchestrator/os-agent.ts";
import { readReceiptFile } from "../modules/system/update-orchestrator/os-receipt-file-identity.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import { writeOsUnlaunchedWitness } from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});
const bytes =
	'{"schema":1,"version":"2026.10.64","channel":"drill","stagedAt":1791464043236,"bootId":"070fd8ac-4a40-4b85-9d31-f21502ebd117"}';
const next = {
	...manifest,
	version: "2026.10.68",
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
};

test.each([true, false])(
	"Rock both-good .68 recovery permits retry only with a completed never-launched baseline witness=%s",
	async (neverLaunched) => {
		// Given booted .64, its stale legacy receipt, both slots good and a failed/unsafe .68 record.
		const f = runtimeFixture();
		fixtures.push(f);
		const dir = dirname(f.file);
		const live = join(dir, "os-staged.json");
		writeFileSync(live, bytes);
		const identity = readReceiptFile(dir)?.identity;
		if (!identity) throw new Error("receipt fixture missing");
		const before = identifiedState();
		if (!before.osStageRecovery) throw new Error("recovery fixture missing");
		saveOrchestratorState(
			{
				...before,
				osStageRecovery: {
					...before.osStageRecovery,
					candidateKey: osStageCandidateKey(next),
				},
			},
			f.file,
		);
		if (neverLaunched)
			writeOsUnlaunchedWitness(
				{
					...input,
					manifestJson: JSON.stringify(next),
					receiptBaseline: identity,
				},
				f.witnessDeps,
			);
		let producers = 0;
		const runtimeDeps = {
			...f.deps,
			loadSettings: async () => ({
				...(await f.deps.loadSettings()),
				packagesAuto: false,
				systemAuto: false,
			}),
			readBootedVersion: async () => "2026.10.64",
			readOsReceipt: async () =>
				(await readStagedReceiptEvidence(dir))?.receipt,
			readOsReceiptEvidence: () => readStagedReceiptEvidence(dir),
			readOsReceiptIdentity: () => readReceiptFile(dir)?.identity ?? null,
			checkOsManifest: async () => ({
				available: true,
				rateLimited: false,
				failed: false,
				reason: "",
				manifest: next,
			}),
			stageOs: async () => {
				producers++;
			},
		};
		// When startup settles and the operator requests Check then Install.
		await startUpdateOrchestrator(runtimeDeps);
		await checkUpdatesNow();
		await installUpdatesNow();
		// Then a positive never-launched witness admits retry, but an unrecorded installation stays unsafe.
		expect(producers).toBe(neverLaunched ? 1 : 0);
		expect(getOrchestratorState().phase).toBe(
			neverLaunched ? "os-staged" : "failed",
		);
		if (!neverLaunched)
			expect(getOrchestratorState().osStageRecovery?.mode).toBe("unsafe");
		expect(readFileSync(live, "utf8")).toBe(bytes);
	},
);
