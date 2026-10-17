import { afterEach, expect, test } from "bun:test";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import type { OsStageJobRecord } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import {
	osUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import {
	defaultOrchestratorRuntimeDeps,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
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
	version: "2026.10.51",
	serial: 13,
	published_at: "2026-10-01T00:00:00Z",
	expires_at: "2026-12-01T00:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/bundle.raucb",
		size: 1,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/flash.raw.xz",
		size: 1,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url: "https://images.ceralive.tv/releases/packages.lock.json",
});
const job: OsStageJobRecord = {
	schema: 1,
	attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	candidateKey: "candidate",
	bundleUrl: candidate.bundle.url,
	launched: true,
	cliSettled: false,
	requireNewInstance: true,
	processes: [],
	resources: [],
	baseline: {
		instance: "659:10",
		active: true,
		operation: "idle",
		processes: ["659:10"],
		resources: [],
		bootId: "boot-B",
		bootPrimary: "rootfs.1",
		bootedSlot: "rootfs.1",
		bootedDevice: "179:5",
		bootedHealthy: true,
		targetSlot: "rootfs.0",
		targetDevice: "179:4",
		targetInactive: true,
		activationArmed: false,
	},
};
afterEach(resetOrchestratorRuntimeForTest);

test("a parked admission read cannot reconcile the newly live producer", async () => {
	// Given admission is ready and its next job-file read is parked.
	const read = Promise.withResolvers<OsStageJobRecord | null>();
	const reading = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const effects: string[] = [];
	await reconcileOsStageStartup({
		acquireControl: acquireTestOsStageControl,
		readJob: async () => null,
		run: async () => ({
			exitCode: 0,
			stdout: "LoadState=not-found\n",
			stderr: "",
		}),
		sweep: async () => {},
	});
	setOrchestratorRuntimeDepsForTest(
		withMemoryPersistence({
			acquireOsStageControl: acquireTestOsStageControl,
			persist: () => {},
			isStreamLive: () => false,
			isOsStageReady: async () => true,
			isUpdateAdmissionReady: async () => true,
			readOsStageJob: async () => {
				reading.resolve();
				return read.promise;
			},
			osStageStartupDeps: {
				acquireControl: acquireTestOsStageControl,
				readJob: async () => job,
				run: async () => ({
					exitCode: 0,
					stdout: "LoadState=loaded\n",
					stderr: "",
				}),
				owner: () => {
					effects.push("adopt");
					throw new Error("live job adopted");
				},
				restart: async () => {
					effects.push("restart");
				},
			},
			newOsAttemptId: () => job.attemptId,
			loadSettings: async () => ({
				packagesAuto: false,
				systemAuto: true,
				channel: "stable",
				schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
				allowPackagesOverCellular: false,
				allowSystemOverCellular: false,
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
			stageOs: async () => {
				entered.resolve();
				await finish.promise;
			},
			readOsReceipt: async () => undefined,
		}),
	);
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-available",
	});
	// When a manual producer starts while the real default admission expression awaits.
	await withDeviceType("real", async () => {
		const probe = defaultOrchestratorRuntimeDeps.isUpdateAdmissionReady?.();
		await reading.promise;
		const install = installUpdatesNow();
		await entered.promise;
		read.resolve(job);
		expect(await probe).toBe(true);
		await reconcileOsStageStartup({
			acquireControl: acquireTestOsStageControl,
			readJob: async () => job,
			run: async () => ({
				exitCode: 0,
				stdout: "LoadState=loaded\n",
				stderr: "",
			}),
			restart: async () => {
				effects.push("restart");
			},
			sweep: async () => {
				effects.push("sweep");
			},
		});
		// Then queued reconciliation leaves the exact producer's writer and pin untouched.
		expect(effects).toEqual([]);
		expect(osUpdateAdmissionReady()).toBe(true);
		finish.resolve();
		await install;
	});
});
