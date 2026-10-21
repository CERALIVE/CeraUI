import { afterEach, expect, test } from "bun:test";
import type { DownloadPausedRecord } from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { downloadNoticeFixture } from "./helpers/download-paused-fixture.ts";

const fixtures: ReturnType<typeof downloadNoticeFixture>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.worker.dispose();
});
const fact = {
	id: "packages:11111111-1111-4111-8111-111111111111",
	candidate: "a".repeat(64),
};

test("repeated interruptions write each intent only once and yield a macrotask between facts", async () => {
	// Given: synchronous production-shaped storage with an independent turn sentinel.
	let entries: readonly DownloadPausedRecord[] = [];
	const events: string[] = [];
	const f = downloadNoticeFixture({
		ledger: {
			read: () => entries,
			write: (next) => {
				entries = next;
				const id = next.at(-1)?.id;
				events.push(`write:${id}`);
				setTimeout(() => events.push(`turn:${id}`), 0);
			},
			acknowledge: () => undefined,
		},
	});
	fixtures.push(f);
	const facts = Array.from({ length: 10 }, (_, index) => ({
		...fact,
		id: `packages:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
	}));
	// When: callers repeat each interruption before and after its first delivery.
	for (const value of facts) {
		f.worker.interrupted(value);
		f.worker.interrupted(value);
	}
	await f.worker.settled();
	for (const value of facts) f.worker.interrupted(value);
	await f.worker.settled();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	// Then: ten writes, with another timer serviced between every pair.
	expect(events).toEqual(
		facts.flatMap(({ id }) => [`write:${id}`, `turn:${id}`]),
	);
	expect(f.publications).toEqual(facts.map(({ id }) => id));
});

test("a failed intent write is attempted once rather than on every observer tick", async () => {
	// Given: a readable baseline whose write fails.
	const counts = { reads: 0, writes: 0 };
	const f = downloadNoticeFixture({
		ledger: {
			read: () => {
				counts.reads++;
				return [];
			},
			write: () => {
				counts.writes++;
				throw new Error("synthetic write failure");
			},
			acknowledge: () => undefined,
		},
	});
	fixtures.push(f);
	// When: ten ticks observe the failed fact after best-effort delivery.
	f.worker.interrupted(fact);
	await f.worker.settled();
	for (let tick = 0; tick < 10; tick++) {
		f.worker.hydrate();
		await f.worker.settled();
	}
	// Then: one diagnostic and one publication, without repeated write attempts.
	expect(counts).toEqual({ reads: 11, writes: 1 });
	expect(f.diagnostics).toEqual(["write-failed"]);
	expect(f.publications).toEqual([fact.id]);
});

test("an already committed intent is published without rewriting it", async () => {
	const entries: readonly DownloadPausedRecord[] = [
		{ ...fact, status: "active" },
	];
	let writes = 0;
	const f = downloadNoticeFixture({
		ledger: {
			read: () => entries,
			write: () => {
				writes++;
			},
			acknowledge: () => undefined,
		},
	});
	fixtures.push(f);
	f.worker.interrupted(fact);
	await f.worker.settled();
	expect(writes).toBe(0);
	expect(f.publications).toEqual([fact.id]);
});
