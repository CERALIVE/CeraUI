import { afterEach, expect, test } from "bun:test";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import {
	type defaultOrchestratorRuntimeDeps,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { withMemoryPersistence } from "./helpers/orchestrator-memory-persistence.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const candidate = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});
const receipt = {
	schema: 1 as const,
	version: candidate.version,
	channel: candidate.channel,
	stagedAt: 1000,
	bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

function setup(overrides: Partial<typeof defaultOrchestratorRuntimeDeps> = {}) {
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence({
			acquireOsStageControl: acquireTestOsStageControl,
			now: () => 2000,
			persist: () => {},
			isStreamLive: () => false,
			isIdle: async () => true,
			isUpdateAdmissionReady: async () => true,
			isOsStageReady: async () => true,
			loadSettings: async () => ({
				packagesAuto: false,
				systemAuto: true,
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				channel: "stable",
				allowPackagesOverCellular: true,
				allowSystemOverCellular: true,
			}),
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			onlyMeteredCandidateExists: async () => false,
			checkOsManifest: async () => ({
				available: true,
				failed: false,
				rateLimited: false,
				reason: "",
				manifest: candidate,
			}),
			stageOs: async () => {},
			armOs: async () => {},
			readOsReceipt: async () => receipt,
			readBootId: async () => receipt.bootId,
			readBootedVersion: async () => "2026.9.0",
			...overrides,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
}
afterEach(resetOrchestratorRuntimeForTest);

test("publication under the job lock cannot arm activation before producer settlement", async () => {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const arms: boolean[] = [];
	setup({
		stageOs: async (_manifest, _progress, control) => {
			if (!control?.commit) throw new Error("missing stage commit fence");
			control.commit(receipt);
			entered.resolve();
			await finish.promise;
		},
		armOs: async (now) => {
			arms.push(now);
		},
	});
	const install = installUpdatesNow();
	await entered.promise;
	await runOrchestratorTick();
	expect(getOrchestratorState().phase).toBe("os-staged");
	expect(arms).toEqual([]);
	finish.resolve();
	await install;
	await runOrchestratorTick();
	expect(arms).toEqual([false]);
});

test("a retained guardian blocks activation without mistaking staging readiness for activation readiness", async () => {
	const arms: boolean[] = [];
	let ready = false;
	setup({
		isUpdateAdmissionReady: async () => ready,
		isOsStageReady: async () => false,
		armOs: async (now) => {
			arms.push(now);
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-staged",
	});
	await runOrchestratorTick();
	expect(arms).toEqual([]);
	ready = true;
	await runOrchestratorTick();
	expect(arms).toEqual([false]);
});

test("a superseded producer cannot publish progress, success or clear its replacement fence", async () => {
	const oldEntered = Promise.withResolvers<void>();
	const oldFinish = Promise.withResolvers<void>();
	const newEntered = Promise.withResolvers<void>();
	const newFinish = Promise.withResolvers<void>();
	let replacementStages = 0;
	setup({
		stageOs: async (_manifest, progress) => {
			oldEntered.resolve();
			await oldFinish.promise;
			progress(99);
		},
	});
	const oldInstall = installUpdatesNow();
	await oldEntered.promise;
	resetOrchestratorRuntimeForTest();
	setup({
		stageOs: async () => {
			replacementStages += 1;
			newEntered.resolve();
			await newFinish.promise;
		},
	});
	const newInstall = installUpdatesNow();
	await newEntered.promise;
	oldFinish.resolve();
	await oldInstall;
	expect(getOrchestratorState()).toMatchObject({
		phase: "os-staging",
		progress: { percent: 0, etaSeconds: 0 },
		failureReason: null,
	});
	await installUpdatesNow();
	expect(replacementStages).toBe(1);
	newFinish.resolve();
	await newInstall;
	expect(getOrchestratorState().phase).toBe("os-staged");
});

test("cancellation at the readiness await prevents launch even after a positive answer", async () => {
	const entered = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<boolean>();
	let stages = 0;
	setup({
		isOsStageReady: async () => {
			entered.resolve();
			return await answer.promise;
		},
		stageOs: async () => {
			stages += 1;
		},
	});
	const install = installUpdatesNow();
	await entered.promise;
	setOrchestratorStateForTest(initialOrchestratorState(1));
	answer.resolve(true);
	await install;
	expect(stages).toBe(0);
	expect(getOrchestratorState().phase).toBe("idle");
});
