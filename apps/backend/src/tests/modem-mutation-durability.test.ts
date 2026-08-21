/**
 * The journal's DURABILITY sequence, with a real filesystem and injected faults.
 *
 * The harness wraps the four primitives — temp-write, temp-fsync, rename,
 * parent-dir fsync — over a REAL temp directory, so what is exercised is the
 * shipped `node:fs` path with one step made to fail, not a simulation of it. The
 * three properties asserted at every injection point:
 *
 *   1. a failure BEFORE the rename+dir-fsync commit boundary leaves the PREVIOUS
 *      journal state byte-intact;
 *   2. that failure REJECTS, so the caller cannot proceed with the mutation;
 *   3. no injection point can leave a torn or unparseable file — `rename` over an
 *      existing path is atomic, so a reader sees one whole document or the other.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	modemMutationEntrySchema,
} from "@ceraui/rpc/schemas";

import {
	commitMutationEntry,
	defaultMutationJournalFs,
	listMutationEntries,
	type MutationJournalDeps,
	type MutationJournalFs,
	mutationSlotName,
	readMutationEntry,
	removeMutationEntry,
} from "../modules/modems/mutation-journal.ts";

type Step = "writeTemp" | "fsyncFile" | "rename" | "fsyncDir";
const STEPS: readonly Step[] = ["writeTemp", "fsyncFile", "rename", "fsyncDir"];

/** Steps at or after which the NEW state is on disk (rename already happened). */
const AFTER_COMMIT: ReadonlySet<Step> = new Set<Step>(["fsyncDir"]);

let dir: string;

function faultyFs(failAt: Step | undefined): MutationJournalFs {
	const wrap =
		<K extends Step>(name: K) =>
		(...args: Parameters<MutationJournalFs[K]>): Promise<void> => {
			if (name === failAt) {
				return Promise.reject(new Error(`injected failure at ${name}`));
			}
			return (
				defaultMutationJournalFs[name] as (
					...a: Parameters<MutationJournalFs[K]>
				) => Promise<void>
			)(...args);
		};
	return {
		...defaultMutationJournalFs,
		writeTemp: wrap("writeTemp"),
		fsyncFile: wrap("fsyncFile"),
		rename: wrap("rename"),
		fsyncDir: wrap("fsyncDir"),
	};
}

function deps(failAt?: Step): MutationJournalDeps {
	return { fs: faultyFs(failAt), dir, now: () => 1_000 };
}

function entry(
	state: ModemMutationEntry["state"],
	detail: string,
): ModemMutationEntry {
	return {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: "platform-xhci-hcd.0.auto-usb-0:1.4.1",
		kind: "usb-mode",
		state,
		attemptId: `attempt-${detail}`,
		startedAt: 1_000,
		updatedAt: 1_000,
		preState: { mode: "qmi", vidPid: "2c7c:0801" },
		detail,
		history: [{ state, at: 1_000 }],
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceraui-mutation-journal-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mutation journal — durability sequence", () => {
	test("a clean commit is readable back, and lands at the hashed slot", async () => {
		const first = entry("armed", "first");
		await commitMutationEntry(first, deps());

		const files = await readdir(dir);
		expect(files).toEqual([`${mutationSlotName(first.stableKey)}.json`]);
		expect(await readMutationEntry(first.stableKey, deps())).toEqual(first);
	});

	for (const failAt of STEPS) {
		test(`an injected failure at ${failAt} rejects and never tears the file`, async () => {
			const previous = entry("armed", "previous");
			await commitMutationEntry(previous, deps());
			const before = await readFile(
				join(dir, `${mutationSlotName(previous.stableKey)}.json`),
				"utf8",
			);

			const next = entry("executing", "next");
			await expect(commitMutationEntry(next, deps(failAt))).rejects.toThrow(
				/injected failure/,
			);

			const after = await readFile(
				join(dir, `${mutationSlotName(previous.stableKey)}.json`),
				"utf8",
			);

			// Whatever the injection point, the file on disk is a WHOLE document.
			const parsed = modemMutationEntrySchema.safeParse(JSON.parse(after));
			expect(parsed.success).toBe(true);

			if (AFTER_COMMIT.has(failAt)) {
				// The rename landed, so the NEW state is visible — but the caller was
				// told the write did not commit, which is the fail-CLOSED direction:
				// the visible state is the more restrictive one.
				expect(parsed.success && parsed.data.attemptId).toBe(next.attemptId);
			} else {
				expect(after).toBe(before);
				expect(parsed.success && parsed.data.attemptId).toBe(
					previous.attemptId,
				);
			}
		});
	}

	test("a failure before the commit boundary leaves NO temp file behind", async () => {
		const first = entry("armed", "first");
		await commitMutationEntry(first, deps());
		await expect(
			commitMutationEntry(entry("executing", "next"), deps("fsyncFile")),
		).rejects.toThrow();

		const files = await readdir(dir);
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("the new state counts as durable only after the parent-directory fsync", async () => {
		const order: string[] = [];
		const tracing: MutationJournalFs = {
			...defaultMutationJournalFs,
			writeTemp: async (p, d) => {
				order.push("writeTemp");
				await defaultMutationJournalFs.writeTemp(p, d);
			},
			fsyncFile: async (p) => {
				order.push("fsyncFile");
				await defaultMutationJournalFs.fsyncFile(p);
			},
			rename: async (a, b) => {
				order.push("rename");
				await defaultMutationJournalFs.rename(a, b);
			},
			fsyncDir: async (p) => {
				order.push("fsyncDir");
				await defaultMutationJournalFs.fsyncDir(p);
			},
		};
		await commitMutationEntry(entry("armed", "ordered"), {
			fs: tracing,
			dir,
			now: () => 1_000,
		});
		expect(order).toEqual(["writeTemp", "fsyncFile", "rename", "fsyncDir"]);
	});

	test("a durable deletion unlinks and fsyncs the parent", async () => {
		const order: string[] = [];
		const tracing: MutationJournalFs = {
			...defaultMutationJournalFs,
			unlink: async (p) => {
				order.push("unlink");
				await defaultMutationJournalFs.unlink(p);
			},
			fsyncDir: async (p) => {
				order.push("fsyncDir");
				await defaultMutationJournalFs.fsyncDir(p);
			},
		};
		const first = entry("completed", "gone");
		await commitMutationEntry(first, deps());
		await removeMutationEntry(first.stableKey, {
			fs: tracing,
			dir,
			now: () => 1_000,
		});
		expect(order).toEqual(["unlink", "fsyncDir"]);
		expect(await readdir(dir)).toEqual([]);
	});

	test("an unparseable slot is reported, never silently repaired", async () => {
		const first = entry("armed", "corrupt");
		await commitMutationEntry(first, deps());
		await Bun.write(
			join(dir, `${mutationSlotName(first.stableKey)}.json`),
			"{not json",
		);
		expect(await readMutationEntry(first.stableKey, deps())).toBeUndefined();
		expect(await listMutationEntries(deps())).toEqual([]);
		// It is LEFT IN PLACE: a mutation record we cannot read is exactly what
		// fail-closed exists for, so deleting it would erase the evidence.
		expect(await readdir(dir)).toHaveLength(1);
	});

	test("the journal file is created mode 0600", async () => {
		const first = entry("armed", "mode");
		await commitMutationEntry(first, deps());
		const stat = await Bun.file(
			join(dir, `${mutationSlotName(first.stableKey)}.json`),
		).stat();
		expect(stat.mode & 0o777).toBe(0o600);
	});

	test("two devices never contend for one document", async () => {
		const a = entry("armed", "a");
		const b = { ...entry("failed", "b"), stableKey: "usb-0:2.1" };
		await commitMutationEntry(a, deps());
		await commitMutationEntry(b, deps());
		const entries = await listMutationEntries(deps());
		expect(entries.map((e) => e.stableKey).sort()).toEqual(
			[a.stableKey, b.stableKey].sort(),
		);
	});
});
