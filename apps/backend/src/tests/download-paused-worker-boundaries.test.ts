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

test.each(["withdraw", "replace"] as const)(
	"a delayed %s cannot retire the successor's genuine interruption",
	async (operation) => {
		let entries: readonly DownloadPausedRecord[] = [
			{ ...fact, status: "active" },
		];
		let readable = false;
		const successor = {
			...fact,
			id: "packages:22222222-2222-4222-8222-222222222222",
		};
		const f = downloadNoticeFixture({
			ledger: {
				read: () => {
					if (!readable) throw new Error("synthetic read failure");
					return entries;
				},
				write: (next) => {
					entries = next;
				},
				acknowledge: () => undefined,
			},
		});
		fixtures.push(f);
		if (operation === "withdraw")
			f.worker.withdraw(fact.candidate, successor.id);
		else f.worker.replacePackages(successor.id);
		await f.worker.settled();
		readable = true;
		f.worker.interrupted(successor);
		await f.worker.settled();
		f.worker.hydrate();
		await f.worker.settled();
		expect(entries).toEqual([
			{ ...fact, status: "withdrawn" },
			{ ...successor, status: "active" },
		]);
		expect(f.publications).toEqual([successor.id]);
	},
);

test("the publisher observes the committed intent, not merely a queued write", async () => {
	let entries: readonly DownloadPausedRecord[] = [];
	const observed: Array<readonly DownloadPausedRecord[]> = [];
	const f = downloadNoticeFixture({
		ledger: {
			read: () => entries,
			write: (next) => {
				entries = next;
			},
			acknowledge: () => undefined,
		},
		publish: () => {
			observed.push(entries);
		},
	});
	fixtures.push(f);
	f.worker.interrupted(fact);
	await f.worker.settled();
	expect(observed).toEqual([[{ ...fact, status: "active" }]]);
});

test("a flooded notice queue remains capped at 128 pending facts", async () => {
	const f = downloadNoticeFixture();
	fixtures.push(f);
	for (let index = 0; index < 129; index++)
		f.worker.interrupted({
			...fact,
			id: `packages:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
		});
	await f.worker.settled();
	expect(f.entries()).toHaveLength(128);
	expect(f.diagnostics).toEqual(["queue-full"]);
});

test("a fresh runtime retires only the last package transaction when it is superseded", async () => {
	const older = {
		...fact,
		id: "packages:22222222-2222-4222-8222-222222222222",
		candidate: "b".repeat(64),
		status: "active" as const,
	};
	const os = {
		...fact,
		id: "os:33333333-3333-4333-8333-333333333333",
		candidate: "c".repeat(64),
		status: "active" as const,
	};
	let entries: readonly DownloadPausedRecord[] = [
		older,
		{ ...fact, status: "active" },
		os,
	];
	const f = downloadNoticeFixture({
		ledger: {
			read: () => entries,
			write: (next) => {
				entries = next;
			},
			acknowledge: () => undefined,
		},
	});
	fixtures.push(f);
	f.worker.replacePackages("packages:44444444-4444-4444-8444-444444444444");
	await f.worker.settled();
	expect(entries).toEqual([older, { ...fact, status: "withdrawn" }, os]);
});

test("failed withdrawal storage still retracts only that candidate and retries after repair", async () => {
	let entries: readonly DownloadPausedRecord[] = [
		{ ...fact, status: "active" },
	];
	let writable = false;
	const cleared: string[] = [];
	const f = downloadNoticeFixture({
		ledger: {
			read: () => entries,
			write: (next) => {
				if (!writable) throw new Error("synthetic disk error");
				entries = next;
			},
			acknowledge: () => undefined,
		},
		clear: (id) => {
			cleared.push(id);
		},
	});
	fixtures.push(f);
	f.worker.withdraw(fact.candidate);
	await f.worker.settled();
	expect(cleared).toEqual([fact.id]);
	expect(entries[0]?.status).toBe("active");
	writable = true;
	f.worker.hydrate();
	await f.worker.settled();
	expect(entries[0]?.status).toBe("withdrawn");
	expect(f.publications).toEqual([]);
});
