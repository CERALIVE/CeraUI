import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

const initialize = () =>
	initMutationRecovery({ sleep: new JournalRetryClock().sleep });

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
