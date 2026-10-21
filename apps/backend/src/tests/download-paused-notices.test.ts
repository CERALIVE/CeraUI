import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DownloadInterruption,
	DownloadPausedLedger,
} from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import {
	type DownloadPausedNoticePorts,
	DownloadPausedNotices,
} from "../modules/system/update-orchestrator/download-paused-notices.ts";
import {
	clearUpdateNotice,
	notifyUpdate,
} from "../modules/system/update-orchestrator/notifications.ts";
import {
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	notificationDismiss,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { resetNotificationState } from "./helpers/notification-state.ts";

const fact: DownloadInterruption = {
	id: "packages:11111111-1111-4111-8111-111111111111",
	candidate: "a".repeat(64),
};
const next: DownloadInterruption = {
	id: "os:22222222-2222-4222-8222-222222222222",
	candidate: "b".repeat(64),
};
const name = (id: string) => `update:download-paused:${id}`;
let root: string;
let oldDismissals: string | undefined;
const workers: DownloadPausedNotices[] = [];
beforeEach(() => {
	resetNotificationState();
	root = mkdtempSync(join(tmpdir(), "download-notices-"));
	oldDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(root, "dismissals.json");
	resetDismissalStoreForTests();
});
afterEach(() => {
	for (const worker of workers.splice(0)) worker.dispose();
	resetNotificationState();
	if (oldDismissals === undefined) delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = oldDismissals;
	resetDismissalStoreForTests();
	rmSync(root, { recursive: true });
});
function fixture(overrides: Partial<DownloadPausedNoticePorts> = {}) {
	const ledger = new DownloadPausedLedger(join(root, "ledger.json"));
	const events: string[] = [];
	const worker = new DownloadPausedNotices({
		ledger,
		publish: (value, onDismiss) => {
			events.push(`publish:${value.id}`);
			notifyUpdate({ kind: "download-paused", id: value.id }, { onDismiss });
		},
		clear: (id) => clearUpdateNotice("download-paused", id),
		report: (reason) => events.push(reason),
		...overrides,
	});
	workers.push(worker);
	return { worker, ledger, events };
}

describe("detached download hold notices", () => {
	test("commits before publishing and deduplicates one interrupted attempt", async () => {
		const { worker, ledger } = fixture();
		worker.interrupted(fact);
		expect(ledger.read()).toEqual([]);
		expect(notificationExists(name(fact.id))).toBeUndefined();
		await worker.settled();
		expect(ledger.read()).toEqual([{ ...fact, status: "active" }]);
		const first = notificationExists(name(fact.id));
		expect(first?.action?.target).toBe("updates-dialog");
		expect(first?.authedOnly).toBe(true);
		expect(first?.isDismissable).toBe(true);
		expect(first?.isPersistent).toBe(true);
		worker.interrupted(fact);
		await worker.settled();
		expect(notificationExists(name(fact.id))?.revision).toBe(first?.revision);
		expect(ledger.read()).toHaveLength(1);
	});
	test("rehydrates the same undismissed identity after restart", async () => {
		const { worker } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		notificationRemove(name(fact.id));
		worker.dispose();
		const restarted = fixture();
		restarted.worker.hydrate();
		await restarted.worker.settled();
		expect(notificationExists(name(fact.id))?.key).toBe(
			"notifications.updatePausedForStream",
		);
	});
	test("durable dismissal survives restart and more than 256 ordinary dismissals", async () => {
		const { worker, ledger } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		notificationDismiss(name(fact.id));
		for (let index = 0; index < 260; index++)
			recordNotificationDismissal(`ordinary:${index}`);
		resetDismissalStoreForTests();
		const restarted = fixture();
		restarted.worker.hydrate();
		restarted.worker.interrupted(fact);
		await restarted.worker.settled();
		expect(notificationExists(name(fact.id))).toBeUndefined();
		expect(ledger.read()[0]?.status).toBe("acknowledged");
	});
	test("withdraws only the matching candidate and preserves withdrawal across restart", async () => {
		const { worker, ledger } = fixture();
		worker.interrupted(fact);
		worker.interrupted(next);
		await worker.settled();
		worker.withdraw(fact.candidate);
		await worker.settled();
		expect(notificationExists(name(fact.id))).toBeUndefined();
		expect(notificationExists(name(next.id))).toBeDefined();
		expect(ledger.read()[0]?.status).toBe("withdrawn");
		worker.hydrate();
		await worker.settled();
		expect(notificationExists(name(fact.id))).toBeUndefined();
	});
	test("withdrawal before the worker runs suppresses an obsolete hold", async () => {
		const { worker } = fixture();
		worker.interrupted(fact);
		worker.withdraw(fact.candidate);
		await worker.settled();
		expect(notificationExists(name(fact.id))).toBeUndefined();
	});
	test("a later attempt for the same candidate is a new notice", async () => {
		const { worker, ledger } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		worker.withdraw(fact.candidate);
		await worker.settled();
		worker.interrupted({ ...next, candidate: fact.candidate });
		await worker.settled();
		expect(notificationExists(name(next.id))).toBeDefined();
		expect(ledger.read()).toHaveLength(2);
	});
	test("write failure still publishes a best-effort in-memory notice", async () => {
		const disk = new DownloadPausedLedger(join(root, "ledger.json"));
		const { worker, events } = fixture({
			ledger: {
				read: () => [],
				write: () => {
					throw new Error("private diagnostic");
				},
				acknowledge: (id) => disk.acknowledge(id),
			},
		});
		worker.interrupted(fact);
		await worker.settled();
		expect(events).toEqual(["write-failed", `publish:${fact.id}`]);
		expect(notificationExists(name(fact.id))).toBeDefined();
	});
	test("attempts one write when duplicate interruption facts meet a throwing ledger", async () => {
		// Given a readable ledger whose writes always fail.
		const disk = new DownloadPausedLedger(join(root, "ledger.json"));
		let writes = 0;
		const { worker } = fixture({
			ledger: {
				read: () => [],
				write: () => {
					writes++;
					throw new Error("injected ledger failure");
				},
				acknowledge: (id) => disk.acknowledge(id),
			},
		});
		// When the same fact arrives twice before the detached worker drains.
		worker.interrupted(fact);
		worker.interrupted(fact);
		await worker.settled();
		// Then the failed write is attempted only once.
		expect(writes).toBe(1);
	});
	test("attempts one publication per fact when duplicate interruption facts meet a failing publisher", async () => {
		// Given a durable ledger and a publisher that rejects every attempt.
		const attempts: string[] = [];
		const { worker } = fixture({
			publish: async (value) => {
				attempts.push(value.id);
				throw new Error("injected publication failure");
			},
		});
		// When each of two distinct facts arrives twice before the worker drains.
		worker.interrupted(fact);
		worker.interrupted(fact);
		worker.interrupted(next);
		worker.interrupted(next);
		await worker.settled();
		// Then failure does not multiply attempts or suppress the other fact.
		expect(attempts).toEqual([fact.id, next.id]);
	});
	test("unknown ledger state defers without publishing or overwriting it", async () => {
		writeFileSync(join(root, "ledger.json"), '{"schema":99}');
		const { worker, events } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		expect(events).toEqual(["read-unavailable"]);
		expect(notificationExists(name(fact.id))).toBeUndefined();
	});
	test("storage repair retries the retained in-memory fact on a later observer tick", async () => {
		writeFileSync(join(root, "ledger.json"), '{"schema":99}');
		const { worker, ledger } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		writeFileSync(join(root, "ledger.json"), '{"schema":1,"entries":[]}');
		worker.hydrate();
		await worker.settled();
		expect(ledger.read()).toEqual([{ ...fact, status: "active" }]);
		expect(notificationExists(name(fact.id))).toBeDefined();
	});
	test("failed acknowledgement preserves the visible notice", async () => {
		const { worker } = fixture();
		worker.interrupted(fact);
		await worker.settled();
		writeFileSync(join(root, "ledger.json"), "unavailable");
		expect(() => notificationDismiss(name(fact.id))).toThrow();
		expect(notificationExists(name(fact.id))).toBeDefined();
	});
});
