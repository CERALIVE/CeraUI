import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetMutationBlockDeps,
	setMutationBlockDeps,
} from "../modules/modems/mutation-blocks.ts";
import {
	listMutationEntries,
	mutationSlotName,
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

let dir: string;
const key = "usb:authority";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "modem-authority-"));
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	setMutationJournalDeps({ dir });
	setMutationBlockDeps({
		listEntries: () => listMutationEntries(),
		presentStableKeys: async () => new Set([key]),
	});
});
afterEach(() => {
	resetMutationJournalDeps();
	resetMutationBlockDeps();
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	delete process.env.CERALIVE_FCC_POLICY_PATH;
	rmSync(dir, { recursive: true, force: true });
});

test.each(["duplicate", "truncated"])(
	"unreadable %s journal cannot grant mutation admission or prune evidence",
	async (layout) => {
		// Given a present journal whose terminal state cannot be established.
		const path = join(dir, `${mutationSlotName(key)}.json`);
		const valid = JSON.stringify({
			version: 1,
			stableKey: key,
			kind: "usb-mode",
			state: "executing",
			attemptId: "attempt",
			startedAt: 1,
			updatedAt: 1,
			preState: {},
			history: [{ state: "executing", at: 1 }],
		});
		const bytes =
			layout === "duplicate"
				? `${valid.slice(0, -1)},"state":"completed"}`
				: valid.slice(0, -1);
		writeFileSync(path, bytes);
		// When startup recovery runs through the real journal boundary.
		await initMutationRecovery();
		// Then no ambiguous terminal state clears admission or deletes its evidence.
		expect(tryAcquireModemMutation(key).admitted).toBe(false);
		expect(isRecoveryPending()).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	},
);

test("duplicate FCC opt-in grants zero enabled models", async () => {
	// Given contradictory per-model policy at its real path boundary.
	const path = join(dir, "fcc.json");
	const bytes =
		'{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":false,"2c7c:0801":true}}';
	writeFileSync(path, bytes);
	process.env.CERALIVE_FCC_POLICY_PATH = path;
	const store = await import(
		`../modules/modems/fcc-unlock-store.ts?authority=${encodeURIComponent(path)}`
	);
	// When the production policy loader evaluates opt-in.
	const loaded = await store.loadFccUnlockPolicy();
	// Then corruption cannot enable a model and bytes remain available.
	expect(Object.values(loaded).filter(Boolean)).toHaveLength(0);
	expect(readFileSync(path, "utf8")).toBe(bytes);
});
