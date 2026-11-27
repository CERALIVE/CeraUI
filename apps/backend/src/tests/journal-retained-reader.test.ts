import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import {
	link,
	mkdir,
	mkdtemp,
	open,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import {
	listUnreadableSlots,
	mutationSlotName,
	readMutationEntry,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	resetLifecycleInterlock,
	tryAcquireModemMutation,
} from "../modules/streaming/lifecycle-admission.ts";
import {
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import { listMutationBlocksProcedure } from "../rpc/procedures/modems.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";
import { JournalRetryClock } from "./helpers/journal-reconciliation-harness.ts";

const key = "usb:archived";
const slot = mutationSlotName(key);
const torn = Buffer.from('{"version":');
const archiveDigest = createHash("sha256").update(torn).digest("hex");
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ceraui-retained-reader-"));
	setMutationJournalDeps({ dir: root });
});

afterEach(async () => {
	resetRecoveryBarrier();
	resetLifecycleInterlock();
	resetMutationJournalDeps();
	await rm(root, { recursive: true, force: true });
});

type FutureEvidence = "complete" | "pending" | "missing" | "alias";

// Seed the future on-disk format without importing or exercising an archive writer.
async function seedRetained(kind: FutureEvidence) {
	const live = join(root, `${slot}.json`);
	await writeFile(live, torn, { mode: 0o600 });
	const parent = await stat(root, { bigint: true });
	const file = await stat(live, { bigint: true });
	const identity = `${parent.dev}:${parent.ino}:${parent.birthtimeNs}`;
	const receipt = createHash("sha256")
		.update(
			`${identity}:${slot}:${file.dev}:${file.ino}:${file.birthtimeNs}:${file.mtimeNs}:`,
		)
		.update(torn)
		.digest("hex");
	const suffix = kind === "pending" ? ".json" : ".retained.json";
	const name = `.set-aside-${slot}-${receipt}${suffix}`;
	const archive = join(root, `${slot}.json.damaged-${archiveDigest}`);
	await mkdir(join(root, name), { mode: 0o700 });
	if (kind === "alias") await link(live, archive);
	else if (kind !== "missing") await writeFile(archive, torn, { mode: 0o600 });
	const record = join(root, name, "record");
	const writer = await open(live, "r+");
	try {
		await rename(live, record);
	} catch (error) {
		await writer.close();
		throw error;
	}
	return { name, writer };
}

const initialize = () => initializeWith(new JournalRetryClock());

const initializeWith = (clock: JournalRetryClock) =>
	initMutationRecovery({ sleep: clock.sleep });

test("the rollback reader ignores only verified and independently archived retained evidence", async () => {
	const { writer } = await seedRetained("complete");
	await writer.close();
	expect(await initialize()).toEqual({
		rolledBack: 0,
		pruned: 0,
		blocked: 0,
		quarantined: 0,
		unreadable: 0,
	});
	expect(await listUnreadableSlots()).toEqual([]);
	expect(await readMutationEntry(key)).toBeUndefined();
	expect(isRecoveryPending()).toBe(false);
	const admission = tryAcquireModemMutation("usb:unrelated");
	expect(admission.admitted).toBe(true);
	if (admission.admitted) admission.lease.release();
});

for (const kind of ["pending", "missing", "alias"] as const) {
	test(`rollback replay holds ${kind} evidence without treating it as a live record`, async () => {
		const { name, writer } = await seedRetained(kind);
		await writer.close();
		expect((await initialize()).unreadable).toBeGreaterThan(0);
		expect(await listUnreadableSlots()).toEqual([name]);
		expect(await readMutationEntry(key)).toBeUndefined();
		expect(isRecoveryPending()).toBe(true);
	});
}

test("a clean verified set-aside admits an operator Start on the previous slot", async () => {
	const { writer } = await seedRetained("complete");
	await writer.close();
	expect((await initialize()).unreadable).toBe(0);
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => "retained-clean",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		recoveryPending: streamSessionProductionDeps.recoveryPending,
	});
	let launches = 0;
	expect(
		await session.start({
			origin: "ui",
			launch: async () => {
				launches++;
			},
		}),
	).toMatchObject({ result: "started" });
	expect(launches).toBe(1);
	expect(isRecoveryPending()).toBe(false);
});

test("a clean internal boot origin launches on the previous slot", async () => {
	const { writer } = await seedRetained("complete");
	await writer.close();
	expect((await initialize()).unreadable).toBe(0);
	const session = createStreamSessionOrchestrator({
		initialLiveness: () => "idle",
		createAttemptId: () => "retained-autostart-clean",
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		recoveryPending: streamSessionProductionDeps.recoveryPending,
		awaitRecovery: streamSessionProductionDeps.awaitRecovery,
	});
	let launches = 0;
	expect(
		await session.start({
			origin: "autostart",
			launch: async () => {
				launches++;
			},
		}),
	).toMatchObject({ result: "started" });
	expect(launches).toBe(1);
});

test("an internal boot origin holds instead of failing terminally when drift appears between its admission gates", async () => {
	const { writer } = await seedRetained("complete");
	const clock = new JournalRetryClock();
	const productionPending = streamSessionProductionDeps.recoveryPending;
	let drifted = false;
	try {
		expect((await initializeWith(clock)).unreadable).toBe(0);
		const session = createStreamSessionOrchestrator({
			initialLiveness: () => "idle",
			createAttemptId: () => "retained-autostart",
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
			recoveryPending: productionPending,
			awaitRecovery: streamSessionProductionDeps.awaitRecovery,
			// Clean at the first gate; an already-open writer drifts the evidence
			// while the attempt is between that gate and the one before admission.
			blockingMutation: () => {
				if (!drifted) {
					drifted = true;
					writeSync(writer.fd, "out-of-band repair");
				}
				return undefined;
			},
		});
		let launches = 0;
		const started = session.start({
			origin: "autostart",
			launch: async () => {
				launches++;
			},
		});
		const early = await Promise.race([
			started,
			new Promise((resolve) => setTimeout(() => resolve("held"), 50)),
		]);
		expect(early).toBe("held");
		expect(launches).toBe(0);
		expect(isRecoveryPending()).toBe(true);

		// The receipt binds the file's mtime, so drifted evidence never becomes
		// verified again: the attempt must stay held, not become a terminal failure.
		const stillWaiting = await Promise.race([
			started,
			new Promise((resolve) => setTimeout(() => resolve("held"), 50)),
		]);
		expect(stillWaiting).toBe("held");
		expect(launches).toBe(0);
	} finally {
		await writer.close();
	}
});

for (const entry of ["Start", "modem mutation", "Cellular list"] as const) {
	test(`late retained-record drift after startup blocks ${entry}`, async () => {
		const { writer } = await seedRetained("complete");
		try {
			expect((await initialize()).unreadable).toBe(0);
			expect(isRecoveryPending()).toBe(false);
			await writer.writeFile("out-of-band repair");
			await writer.sync();
			expect(isRecoveryPending()).toBe(false);

			switch (entry) {
				case "Start": {
					const session = createStreamSessionOrchestrator({
						initialLiveness: () => "idle",
						createAttemptId: () => "retained-drift",
						setStreamingStatus: () => {},
						stopRuntime: async () => {},
						queryRuntime: async () => "idle",
						recoveryPending: streamSessionProductionDeps.recoveryPending,
					});
					let launches = 0;
					expect(
						await session.start({
							origin: "ui",
							launch: async () => {
								launches++;
							},
						}),
					).toMatchObject({
						result: "failed",
						failure: { code: "recovery_pending" },
					});
					expect(launches).toBe(0);
					break;
				}
				case "modem mutation":
					expect(tryAcquireModemMutation(key)).toEqual({
						admitted: false,
						refusal: "recovery_pending",
					});
					break;
				case "Cellular list":
					expect(
						await call(listMutationBlocksProcedure, undefined, {
							context: makeRpcContext(),
						}),
					).toEqual({ replayComplete: false, blocks: [] });
					break;
			}
			expect(isRecoveryPending()).toBe(true);
		} finally {
			await writer.close();
		}
	});
}
