import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DownloadPausedLedger,
	type DownloadPausedRecord,
} from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const roots: string[] = [];
const fixtures: ReturnType<typeof downloadNoticeFixture>[] = [];
const fact = {
	id: "packages:ffffffff-ffff-4fff-8fff-ffffffffffff",
	candidate: "a".repeat(64),
};
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.worker.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(status: DownloadPausedRecord["status"]) {
	const root = mkdtempSync(join(tmpdir(), "download-capacity-"));
	roots.push(root);
	const path = join(root, "ledger.json");
	const ledger = new DownloadPausedLedger(path);
	const entries = Array.from({ length: 4096 }, (_, index) => ({
		id: `os:${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
		candidate: "b".repeat(64),
		status,
	}));
	ledger.write(entries);
	const counts = { reads: 0, writes: 0 };
	const notices = downloadNoticeFixture({
		ledger: {
			read: () => {
				counts.reads++;
				return ledger.read();
			},
			write: (next) => {
				counts.writes++;
				ledger.write(next);
			},
			acknowledge: (id) => ledger.acknowledge(id),
		},
	});
	fixtures.push(notices);
	return { ...notices, path, ledger, counts };
}

test("withdrawn history at capacity is compacted in the new intent's single write and reloads in a fresh process", async () => {
	// Given: every stored record has already been withdrawn.
	const f = fixture("withdrawn");
	// When: a new interruption needs room at the strict cap.
	f.worker.interrupted(fact);
	await f.worker.settled();
	// Then: one atomic replacement stores only the new obligation.
	expect(f.counts).toEqual({ reads: 1, writes: 1 });
	expect(f.diagnostics).toEqual([]);
	expect(f.publications).toEqual([fact.id]);
	const module = new URL(
		"../modules/system/update-orchestrator/download-paused-ledger.ts",
		import.meta.url,
	).href;
	const child = await runTestCommand([
		process.execPath,
		"-e",
		`import { DownloadPausedLedger } from ${JSON.stringify(module)}; console.log(JSON.stringify(new DownloadPausedLedger(process.argv[1]).read()));`,
		f.path,
	]);
	expect(child.code).toBe(0);
	expect(JSON.parse(child.stdout)).toEqual([{ ...fact, status: "active" }]);
});

test.each(["active", "acknowledged"] as const)(
	"protected %s capacity reports once without retry I/O over ten observer ticks",
	async (status) => {
		// Given: the cap contains no disposable history.
		const f = fixture(status);
		const original = readFileSync(f.path, "utf8");
		// When: the fact is rejected for capacity and ten observers run.
		f.worker.interrupted(fact);
		await f.worker.settled();
		for (let tick = 0; tick < 10; tick++) {
			f.worker.hydrate();
			await f.worker.settled();
		}
		// Then: only normal hydration reads remain; no write or retry warning.
		expect(f.counts).toEqual({ reads: 11, writes: 0 });
		expect(f.diagnostics).toEqual(["ledger-full"]);
		expect(f.publications.filter((id) => id === fact.id)).toEqual([fact.id]);
		expect(readFileSync(f.path, "utf8")).toBe(original);
	},
);

test("compaction preserves active notices and acknowledgements in order", async () => {
	// Given: a full ledger with both protected states among withdrawn records.
	const f = fixture("withdrawn");
	const entries = f.ledger.read();
	const protectedEntries = entries.slice(0, 2).map((entry, index) => ({
		...entry,
		status: index === 0 ? ("active" as const) : ("acknowledged" as const),
	}));
	f.ledger.write([...protectedEntries, ...entries.slice(2)]);
	// When: capacity compaction admits another fact.
	f.worker.interrupted(fact);
	await f.worker.settled();
	// Then: no current obligation or acknowledgement is evicted.
	expect(f.ledger.read()).toHaveLength(3);
	expect(f.ledger.read()).toEqual([
		...protectedEntries,
		{ ...fact, status: "active" },
	]);
	expect(f.counts.writes).toBe(1);
});
