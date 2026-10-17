import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import {
	currentMutationBlocks,
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	resetMutationCaptureDeps,
	setMutationCaptureDeps,
} from "../modules/modems/mutation-rollback.ts";
import {
	resetLifecycleInterlock,
	streamingBlockingMutation,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
const KEY = "usb:a";
let root: string;
let release = () => {};
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "journal-enumeration-"));
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	setMutationJournalDeps({ dir: root, now: () => 2 });
	setMutationBlockDeps({ presentStableKeys: async () => new Set([KEY]) });
	setMutationCaptureDeps({
		enumerate: async () => [
			{
				vendorId: "2c7c",
				productId: "0801",
				physicalUid: KEY,
				model: "fixture",
				firmwareRevision: "one",
				ifname: "wwan0",
				bDeviceClass: 0,
				interfaces: [
					{
						interfaceClass: 255,
						interfaceSubClass: 255,
						interfaceProtocol: 255,
						driver: "qmi_wwan",
					},
				],
			},
		],
	});
});
afterEach(() => {
	resetRecoveryBarrier();
	release();
	resetLifecycleInterlock();
	resetMutationJournalDeps();
	resetMutationBlockDeps();
	resetMutationCaptureDeps();
	rmSync(root, { recursive: true, force: true });
});
async function seed(): Promise<void> {
	await commitMutationEntry({
		version: 1,
		stableKey: KEY,
		kind: "usb-mode",
		state: "failed",
		attemptId: "retained",
		startedAt: 1,
		updatedAt: 1,
		preState: {
			vidPid: "2c7c:0801",
			model: "fixture",
			firmwareRevision: "one",
			mode: "qmi",
		},
		history: [{ state: "failed", at: 1 }],
	});
}

test("acknowledgement removal followed by one enumeration EIO automatically clears stale blocks", async () => {
	// Given a failed real slot and completed startup with a registered runtime owner.
	await seed();
	const waits: number[] = [];
	let launches = 0;
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => "enumeration-start",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		recoveryPending: () =>
			streamSessionProductionDeps.recoveryPending?.() ?? true,
		blockingMutation: () => streamSessionProductionDeps.blockingMutation?.(),
	});
	const start = () =>
		session.start({
			origin: "ui",
			launch: async () => {
				launches++;
			},
		});
	await initMutationRecovery({
		sleep: (ms, signal) => {
			waits.push(ms);
			return new Promise<void>((resolve) => {
				release = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	});
	expect(streamingBlockingMutation()).toEqual({
		stableKey: KEY,
		refusal: "mutation_blocked",
		blocksStreaming: true,
	});
	const fault = spyOn(fs, "readdir").mockRejectedValueOnce(
		Object.assign(new Error("EIO readdir"), { code: "EIO" }),
	);
	try {
		// When acknowledgement durably removes the slot but the post-open listing fails.
		await expect(acknowledgeMutation(KEY, "verified-rollback")).rejects.toThrow(
			"EIO readdir",
		);
		expect(readdirSync(root)).toEqual([]);
		expect(isRecoveryPending()).toBe(true);
		expect(waits).toEqual([1000]);
		expect(currentMutationBlocks()).toHaveLength(1);
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "recovery_pending",
		});
		expect(await start()).toEqual({
			result: "failed",
			attemptId: "enumeration-start",
			failure: {
				attemptId: "enumeration-start",
				phase: "params",
				class: "recovery_pending",
				code: "recovery_pending",
				retriable: false,
			},
		});
		expect(launches).toBe(0);
		fault.mockRestore();
		release();
		await awaitRecoveryBarrier();
		// Then the READ-ONLY owner sees the empty disk and refreshes Start/modem admission.
		expect(currentMutationBlocks()).toEqual([]);
		expect(streamingBlockingMutation()).toBeUndefined();
		expect(isRecoveryPending()).toBe(false);
		expect(waits).toEqual([1000]);
		const admission = tryAcquireModemMutation(KEY);
		expect(admission.admitted).toBe(true);
		if (admission.admitted) admission.lease.release();
		expect((await start()).result).toBe("started");
		expect(launches).toBe(1);
		await session.stop("operator");
		expect(await acknowledgeMutation(KEY, "verified-rollback")).toEqual({
			success: false,
			error: "no_entry",
		});
	} finally {
		fault.mockRestore();
	}
});

test("permanent post-open enumeration EIO stays barrier-owned with capped waits and no spin", async () => {
	// Given healthy startup, then permanently unavailable enumeration.
	const waits: number[] = [];
	let reached = () => {};
	await initMutationRecovery({
		sleep: (ms, signal) => {
			waits.push(ms);
			reached();
			return new Promise<void>((resolve) => {
				release = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	});
	const fault = spyOn(fs, "readdir").mockRejectedValue(
		Object.assign(new Error("EIO readdir"), { code: "EIO" }),
	);
	try {
		// When the production listing raises and each manually released retry fails.
		await expect(defaultMutationJournalFs.listDir(root)).rejects.toThrow(
			"EIO readdir",
		);
		expect(isRecoveryPending()).toBe(true);
		for (let n = 1; n < 10; n++) {
			let next = () => {};
			const arrived = new Promise<void>((resolve) => {
				next = resolve;
			});
			const original = release;
			reached = next;
			original();
			await arrived;
		}
		expect(waits).toEqual([
			1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000,
		]);
		expect(fault).toHaveBeenCalledTimes(10);
		expect(isRecoveryPending()).toBe(true);
		expect(tryAcquireModemMutation(KEY)).toEqual({
			admitted: false,
			refusal: "recovery_pending",
		});
	} finally {
		fault.mockRestore();
	}
});

test("absent journal directory lowers boot barrier without a scheduled retry", async () => {
	// Given genuine absence, not a successful open followed by EIO.
	setMutationJournalDeps({ dir: join(root, "absent") });
	const waits: number[] = [];
	// When production startup inventories it.
	await initMutationRecovery({
		sleep: (ms, signal) => {
			waits.push(ms);
			return new Promise<void>((resolve) => {
				release = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	});
	// Then ordinary first boot is not classified as damage or retry work.
	expect(isRecoveryPending()).toBe(false);
	expect(waits).toEqual([]);
});
