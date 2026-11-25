import { beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModemMutationEntry } from "@ceraui/rpc/schemas";
import { acknowledgeMutation } from "../modules/modems/mutation-acknowledge.ts";
import {
	currentMutationBlocks,
	refreshMutationBlocks,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	mutationSlotName,
	readMutationEntry,
	removeMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { persistMutationFailure } from "../modules/modems/mutation-journal-retirement.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { registerMutationRollback } from "../modules/modems/mutation-rollback.ts";
import {
	streamingBlockingMutation,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	JournalRetryClock,
	seedFailedMutation,
	useJournalReconciliationHarness,
} from "./helpers/journal-reconciliation-harness.ts";

const harness = useJournalReconciliationHarness();
// Publish this test's empty journal over any list another test left behind.
beforeEach(async () => {
	await refreshMutationBlocks();
});
const pathFor = (key: string) =>
	join(harness.root(), `${mutationSlotName(key)}.json`);
const boot = () =>
	initMutationRecovery({ sleep: new JournalRetryClock().sleep });

test("a lone torn slot is incomplete authority, not permission to stream or mutate", async () => {
	const torn = pathFor("usb:b");
	writeFileSync(torn, "{");

	expect((await boot()).unreadable).toBe(2);

	expect(currentMutationBlocks()).toEqual([]);
	expect(await acknowledgeMutation("usb:b", "verified-rollback")).toEqual({
		success: false,
		error: "no_entry",
	});
	expect(tryAcquireModemMutation("usb:a")).toEqual({
		admitted: false,
		refusal: "recovery_pending",
	});
	expect(isRecoveryPending()).toBe(true);
	expect(readFileSync(torn, "utf8")).toBe("{");
});

test("Keep on a listed readable row beside a torn slot durably succeeds without clearing recovery", async () => {
	await seedFailedMutation();
	const torn = pathFor("usb:b");
	writeFileSync(torn, "{");
	await boot();
	expect(currentMutationBlocks().map((block) => block.stableKey)).toEqual([
		"usb:a",
	]);

	expect(await acknowledgeMutation("usb:a", "verified-rollback")).toEqual({
		success: true,
		state: "acknowledged",
	});

	expect(existsSync(pathFor("usb:a"))).toBe(false);
	expect(currentMutationBlocks()).toEqual([]);
	expect(isRecoveryPending()).toBe(true);
	expect(readFileSync(torn, "utf8")).toBe("{");
});

test("a per-slot read failure does not prevent safe pruning of a completed neighbor", async () => {
	const unreadable = pathFor("usb:b");
	mkdirSync(unreadable);
	await commitMutationEntry({
		version: 1,
		stableKey: "usb:a",
		kind: "usb-mode",
		state: "completed",
		attemptId: "finished",
		startedAt: 1,
		updatedAt: 1,
		preState: {},
		history: [{ state: "completed", at: 1 }],
	});

	expect(await boot()).toMatchObject({ pruned: 1, unreadable: 2 });

	expect(existsSync(pathFor("usb:a"))).toBe(false);
	expect(statSync(unreadable).isDirectory()).toBe(true);
	expect(isRecoveryPending()).toBe(true);
});

const tear = (path: string) => writeFileSync(path, "{");

test("another read of the damage during a publication refuses that publication", async () => {
	await seedFailedMutation();
	tear(pathFor("usb:b"));
	const presence = harness.pausePresence();
	const older = refreshMutationBlocks();
	try {
		await Promise.race([presence.entered, older]);
		expect(await readMutationEntry("usb:b")).toBeUndefined();
	} finally {
		presence.release();
		await expect(older).rejects.toMatchObject({
			name: "MutationJournalRevisionError",
		});
	}
});

test("a change during both censuses refuses the publication, however many faults they met", async () => {
	await seedFailedMutation();
	tear(pathFor("usb:b"));
	let commits = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			// Another modem commits after this census read the torn slot or before it.
			readText: async (path) => {
				const text = await defaultMutationJournalFs.readText(path);
				if (path === pathFor("usb:a")) {
					commits++;
					await seedFailedMutation("usb:c");
				}
				return text;
			},
		},
	});

	await expect(refreshMutationBlocks()).rejects.toMatchObject({
		name: "MutationJournalRevisionError",
	});

	expect(commits).toBe(2);
	expect(currentMutationBlocks()).toEqual([]);
});

test("a change during the first census only is answered by one fresh census", async () => {
	await seedFailedMutation();
	tear(pathFor("usb:b"));
	let moved = false;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			readText: async (path) => {
				const text = await defaultMutationJournalFs.readText(path);
				if (path === pathFor("usb:a") && !moved) {
					moved = true;
					await seedFailedMutation("usb:c");
				}
				return text;
			},
		},
	});

	const blocks = await refreshMutationBlocks();

	expect(blocks.map((block) => block.stableKey).sort()).toEqual([
		"usb:a",
		"usb:c",
	]);
});

test("a row whose slot becomes damaged stays listed and blocked beside readable rows", async () => {
	await seedFailedMutation();
	await seedFailedMutation("usb:b");
	await boot();
	tear(pathFor("usb:b"));

	expect(await acknowledgeMutation("usb:a", "verified-rollback")).toEqual({
		success: true,
		state: "acknowledged",
	});

	expect(currentMutationBlocks().map((block) => block.stableKey)).toEqual([
		"usb:b",
	]);
	expect(streamingBlockingMutation()?.stableKey).toBe("usb:b");
	expect(isRecoveryPending()).toBe(true);
});

test("a view read before a repair cannot drop the repaired row once the barrier is down", async () => {
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	// An older publication met B torn and is still reading presence.
	tear(pathFor("usb:b"));
	const presence = harness.pausePresence();
	const older = refreshMutationBlocks();
	await Promise.race([presence.entered, older]);
	setMutationBlockDeps({ presentStableKeys: async () => new Set(["usb:a"]) });
	const row = JSON.parse(readFileSync(pathFor("usb:a"), "utf8"));
	writeFileSync(
		pathFor("usb:b"),
		JSON.stringify({ ...row, stableKey: "usb:b" }),
	);
	clock.advance();
	await Promise.race([awaitRecoveryBarrier(), clock.at(2)]);
	expect(isRecoveryPending()).toBe(false);

	presence.release();
	await older;

	expect(
		currentMutationBlocks()
			.map((block) => block.stableKey)
			.sort(),
	).toEqual(["usb:a", "usb:b"]);
	expect(tryAcquireModemMutation("usb:b").admitted).toBe(false);
});

// One damaged read of an interrupted row, at each read of the first pass.
for (const kind of ["torn", "directory"] as const) {
	for (const read of [1, 2, 3]) {
		test(`a ${kind} at read ${read} never drops the barrier on an unreplayed change`, async () => {
			let rollbacks = 0;
			registerMutationRollback("usb-mode", {
				rollback: async () => {
					rollbacks++;
					return "restored";
				},
			});
			const slot = pathFor("usb:a");
			await commitMutationEntry({
				version: 1,
				stableKey: "usb:a",
				kind: "usb-mode",
				state: "executing",
				attemptId: "interrupted",
				startedAt: 1,
				updatedAt: 1,
				preState: { mode: "mbim" },
				history: [{ state: "executing", at: 1 }],
			});
			const bytes = readFileSync(slot);
			let reads = 0;
			setMutationJournalDeps({
				dir: harness.root(),
				fs: {
					...defaultMutationJournalFs,
					readText: async (path) => {
						if (++reads !== read || !existsSync(slot))
							return defaultMutationJournalFs.readText(path);
						rmSync(slot);
						if (kind === "torn") tear(slot);
						else mkdirSync(slot);
						try {
							return await defaultMutationJournalFs.readText(path);
						} finally {
							rmSync(slot, { recursive: true });
							writeFileSync(slot, bytes);
						}
					},
				},
			});
			const clock = new JournalRetryClock();

			const first = await initMutationRecovery({ sleep: clock.sleep });
			expect(first.unreadable).toBeGreaterThan(0);
			expect(isRecoveryPending()).toBe(true);
			for (let n = 2; isRecoveryPending(); n++) {
				clock.advance();
				await Promise.race([awaitRecoveryBarrier(), clock.at(n)]);
			}

			expect(await readMutationEntry("usb:a")).toBeUndefined();
			expect(rollbacks).toBe(1);
			expect(currentMutationBlocks()).toEqual([]);
		});
	}
}

test("runtime verification publishes readable rows beside damage and keeps the barrier", async () => {
	await seedFailedMutation();
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	expect(isRecoveryPending()).toBe(false);
	// A durable removal whose own refresh was lost, then damage in another slot.
	await removeMutationEntry("usb:a");
	tear(pathFor("usb:b"));
	expect(currentMutationBlocks()).toHaveLength(1);

	beginRecoveryBarrier();
	clock.advance();
	await Promise.race([clock.at(2), awaitRecoveryBarrier()]);

	expect(currentMutationBlocks()).toEqual([]);
	expect(isRecoveryPending()).toBe(true);
});

test("a torn slot keeps its pending failed transition until it is readable again", async () => {
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	const row: ModemMutationEntry = {
		version: 1,
		stableKey: "usb:b",
		kind: "usb-mode",
		state: "executing",
		attemptId: "unsettled",
		startedAt: 1,
		updatedAt: 1,
		preState: {},
		history: [{ state: "executing", at: 1 }],
	};
	await commitMutationEntry(row);
	const bytes = readFileSync(pathFor("usb:b"), "utf8");
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			rename: async () => {
				throw new Error("EIO rename");
			},
		},
	});
	await persistMutationFailure({ ...row, state: "failed" });
	setMutationJournalDeps({ dir: harness.root() });
	// Two passes meet the same torn bytes: a new fault, then a known one.
	tear(pathFor("usb:b"));
	for (const pass of [2, 3]) {
		clock.advance();
		await Promise.race([clock.at(pass), awaitRecoveryBarrier()]);
		expect(isRecoveryPending()).toBe(true);
	}

	writeFileSync(pathFor("usb:b"), bytes);
	clock.advance();
	await Promise.race([clock.at(4), awaitRecoveryBarrier()]);

	expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
});

test("the first verification after a repair lowers the barrier", async () => {
	const clock = new JournalRetryClock();
	await initMutationRecovery({ sleep: clock.sleep });
	tear(pathFor("usb:b"));
	expect(await readMutationEntry("usb:b")).toBeUndefined();
	clock.advance();
	await clock.at(2);
	expect(isRecoveryPending()).toBe(true);

	unlinkSync(pathFor("usb:b"));
	clock.advance();
	await Promise.race([clock.at(3), awaitRecoveryBarrier()]);

	expect(isRecoveryPending()).toBe(false);
});
