import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import { readOsStageJob } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import {
	type OsStageRunDeps,
	runOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-run.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { unlaunchedHarness } from "./helpers/os-stage-unlaunched-harness.ts";

const manifest = osChannelManifestSchema.parse({
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
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/bundle.raucb",
		size: 100,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/packages.lock.json",
});

test.each(["inspection", "submission", "held deadline"] as const)(
	"a post-creation %s failure settles without RAUC dispatch",
	async (fault) => {
		await using h = await unlaunchedHarness();
		await rm(h.directory, { recursive: true });
		let now = 0;
		let inspectFailed = false;
		let installs = 0;
		const pin = createUpdatePinController({
			readCapabilities: async () => undefined,
		});
		const deps: OsStageRunDeps<string> = {
			acquireControl: acquireTestOsStageControl,
			observe: h.deps.observe,
			owner: (record) =>
				createOsStageJobOwner(record, {
					directory: h.directory,
					uid: h.uid,
					now: () => now,
					sleep: async (ms) => {
						now += ms;
					},
					unlaunched: { ...h.deps, sweep: h.deps.sweep },
					kernel: async () => fault !== "held deadline",
					inspect: async () => {
						if (fault === "inspection" && !inspectFailed) {
							inspectFailed = true;
							throw new Error("accepted-unit inspection timed out");
						}
						return h.deps.inspect(record.attemptId);
					},
					run: async (argv) => {
						if (argv[0] === "systemd-run") {
							await writeFile(
								join(h.directory, "ready"),
								`${record.attemptId}\n`,
								{ mode: 0o600 },
							);
							if (fault === "submission")
								throw new Error("submission response timed out");
						}
						return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
					},
				}),
			pin,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			blocked: async () => false,
			selection: async () => ({
				status: "none",
				reason: "no-healthy-transport",
				ranked: [],
			}),
			revalidate: async () => undefined,
			restart: async () => {
				throw new Error("restart forbidden");
			},
			prepareReceipt: async () => {
				throw new Error("receipt forbidden");
			},
			progress: () => undefined,
			readProgress: async () => null,
			attempt: () => {
				installs++;
				throw new Error("install forbidden");
			},
		};
		await expect(
			runOsStageJob(
				manifest,
				{ attemptId: h.job.attemptId, signal: new AbortController().signal },
				deps,
			),
		).rejects.toMatchObject({
			reason: "rauc_install_failed",
			mode: "operator",
		});
		expect(installs).toBe(0);
		expect(h.effects).toContain("normal-exit");
		expect(h.effects.at(-1)).toBe("witness");
		expect(await readOsStageJob(h.directory, h.uid)).toBeNull();
	},
);

test("startup routes a live unlaunched orphan before a failing held inspection", async () => {
	await using h = await unlaunchedHarness();
	const result = await reconcileOsStageStartup({
		acquireControl: acquireTestOsStageControl,
		readJob: () => readOsStageJob(h.directory, h.uid),
		owner: () => {
			throw new Error("generic owner forbidden");
		},
		run: async () => {
			throw new Error("generic inspection forbidden");
		},
		liveProducer: () => null,
		orphan: async () => {
			await h.settle();
			return true;
		},
	});
	expect(result).toMatchObject({
		kind: "reconciled",
		attemptId: h.job.attemptId,
	});
	expect(h.effects).toContain("normal-exit");
});

test("an owned failed loaded unlaunched unit resets before a fresh acquisition", async () => {
	await using h = await unlaunchedHarness("terminal");
	await settleOsStageOrphan(await readOsStageJob(h.directory, h.uid), {
		directory: h.directory,
		uid: h.uid,
		lock: h.deps.lock,
		run: h.deps.run,
		observe: h.deps.observe,
		cliGone: h.deps.cliGone,
		sweep: h.deps.sweep,
		liveProducer: () => null,
		acquireControl: acquireTestOsStageControl,
		unlaunched: h.deps,
	});
	expect(h.effects).toContain("reset-failed");
	const next = createOsStageJobOwner(h.job, {
		directory: h.directory,
		uid: h.uid,
		now: () => 0,
		sleep: async () => undefined,
		inspect: async () => ({
			kind: "live",
			pid: "101",
			invocationId: "b".repeat(32),
		}),
		kernel: async () => true,
		run: async (argv) => {
			if (argv[0] === "systemd-run")
				await writeFile(join(h.directory, "ready"), `${h.job.attemptId}\n`, {
					mode: 0o600,
				});
			return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
		},
	});
	await next.acquire();
	expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
		lifecycle: "held",
		launched: false,
	});
});

test("a pre-existing foreign unit is neither adopted nor removed by failed acquisition", async () => {
	await using h = await unlaunchedHarness("absent");
	const owner = createOsStageJobOwner(h.job, {
		directory: h.directory,
		uid: h.uid,
		now: () => 0,
		sleep: async () => undefined,
		run: async () => ({
			exitCode: 0,
			stdout: "LoadState=loaded\n",
			stderr: "",
		}),
	});
	await expect(owner.acquire()).rejects.toHaveProperty(
		"reason",
		"os_update_lock_held",
	);
	expect(await owner.settleUnlaunched?.(h.deps.control)).toBe(false);
	expect(h.effects).toEqual([]);
	expect(await readOsStageJob(h.directory, h.uid)).toMatchObject({
		attemptId: h.job.attemptId,
	});
});
