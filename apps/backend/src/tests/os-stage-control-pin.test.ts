import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import { drainRetainedOsStagePin } from "../modules/system/update-orchestrator/os-stage-pin-retention.ts";
import type { RaucStageSnapshot } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import {
	type OsStageRunControl,
	type OsStageRunDeps,
	runOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-run.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";

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
const helper = join(
	import.meta.dir,
	"../../../../deployment/ceralive-os-stage-guard",
);

test("an unsafe producer fences dispatch, surrenders the lease, and its parked pin drains only under the reconciler's lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "ceraui-control-pin-"));
	// Each acquisition is a real flock child process on one control lock.
	const lease = () =>
		acquireOsOrphanLock(
			{ lock: join(root, "control.lock"), helper },
			"os_update_lock_held",
		);
	let now = 0;
	let snapshot: RaucStageSnapshot = record.baseline;
	let attempts = 0;
	let guarded: OsStageRunControl | undefined;
	const contention: string[] = [];
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse({
				schema: 1,
				features: ["apt-all-packages", "transport-uidrange"],
				apt_uid: 42042,
				ota_uid: 42043,
			}),
		now: () => now,
		run: async (_bin, args) =>
			args.join(" ").endsWith("route show default") ? "default dev eth0\n" : "",
	});
	await pin.sweep();
	let current = {
		...record,
		attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	};
	const deps: OsStageRunDeps<string> = {
		acquireControl: lease,
		pin,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		blocked: async () => false,
		observe: async () => snapshot,
		selection: async () => {
			// While the producer runs, a second controller is excluded.
			await lease().catch((error: unknown) => {
				if (error instanceof OsStageError) contention.push(error.reason);
			});
			return rankTransports([
				{
					candidate: { ifname: "eth0", kind: "ethernet", metered: false },
					family: 4,
					hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
				},
			]);
		},
		revalidate: async () => {},
		readProgress: async () => null,
		progress: () => {},
		restart: async () => {},
		prepareReceipt: async () => () => "receipt",
		owner: (input) => {
			current = input;
			return {
				acquire: async () => {},
				held: async () => true,
				remember: (_snapshot, launched = true, cliSettled = false) => {
					current = { ...current, launched, cliSettled };
				},
				beginAttempt: (base, pair) => {
					current = { ...current, baseline: base, launched: true, pair };
				},
				record: () => current,
				release: async () => {
					throw new OsStageError("rauc_recovery_unproven");
				},
			};
		},
		attempt: ({ control }) => {
			attempts++;
			guarded = control;
			return {
				outcome: Promise.resolve({
					kind: "failed" as const,
					error: new OsStageError("rauc_install_failed"),
				}),
				cli: Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }),
				cliSettled: () => true,
				dispose: () => {},
			};
		},
	};
	try {
		// When the attempt's recovery never becomes independently quiescent.
		await expect(
			runOsStageJob(
				manifest,
				{ attemptId: current.attemptId, signal: new AbortController().signal },
				deps,
			),
		).rejects.toMatchObject({ reason: "rauc_recovery_unproven" });
		// Then dispatch is fenced before the lease is surrendered, and the pin stays parked.
		expect(contention).toEqual(["os_update_lock_held"]);
		expect(guarded?.canCommit?.()).toBe(false);
		expect(attempts).toBe(1);
		await expect(pin.sweep()).rejects.toHaveProperty("reason", "busy");
		// And only the reconciler, now owning the lease, drains it: no late dispatch, no deadlock.
		{
			await using reconciler = await lease();
			expect(reconciler.held()).toBe(true);
			snapshot = {
				...record.baseline,
				instance: "retired:100",
				processes: ["retired:100"],
			};
			await drainRetainedOsStagePin(current.attemptId, {
				deadline: performance.now() + 10_000,
				now: () => performance.now(),
				fence: () => {
					if (!reconciler.held())
						throw new OsStageError("rauc_recovery_unproven");
				},
			});
			await pin.sweep();
		}
		expect(attempts).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
