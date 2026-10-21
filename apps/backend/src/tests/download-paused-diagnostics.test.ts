import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadPausedLedger } from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../modules/system/update-orchestrator/download-paused-notices.ts";
import type { NoticeDiagnostic } from "../modules/system/update-orchestrator/download-paused-ports.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import { resetNotificationState } from "./helpers/notification-state.ts";

const markers = [
	"-----BEGIN PRIVATE KEY-----",
	"/etc/apt/certs/client.key",
] as const;
const fact = {
	id: "packages:11111111-1111-4111-8111-111111111111",
	candidate: "a".repeat(64),
};
const successor = {
	...fact,
	id: "packages:22222222-2222-4222-8222-222222222222",
};
let root: string;
let oldDismissals: string | undefined;
let worker: DownloadPausedNotices | undefined;
const rejections: unknown[] = [];
const exceptions: unknown[] = [];
const onRejection = (error: unknown) => rejections.push(error);
const onException = (error: unknown) => exceptions.push(error);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "download-diagnostics-"));
	oldDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(root, "dismissals.json");
	resetDismissalStoreForTests();
	resetNotificationState();
	rejections.length = 0;
	exceptions.length = 0;
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
});
afterEach(() => {
	worker?.dispose();
	worker = undefined;
	process.off("unhandledRejection", onRejection);
	process.off("uncaughtException", onException);
	resetNotificationState();
	if (oldDismissals === undefined) delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = oldDismissals;
	resetDismissalStoreForTests();
	rmSync(root, { recursive: true });
});

test("deadline isolates a throwing reporter and later hydration publishes the retained hold", async () => {
	// Given a held read and a diagnostic transport that throws private-looking text.
	const ledger = new DownloadPausedLedger(join(root, "ledger.json"));
	const entered = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const diagnosed = Promise.withResolvers<void>();
	const reasons: NoticeDiagnostic[] = [];
	worker = new DownloadPausedNotices({
		ledger: {
			read: async () => {
				entered.resolve();
				await held.promise;
				return ledger.read();
			},
			write: (entries) => ledger.write(entries),
			acknowledge: (id) => ledger.acknowledge(id),
		},
		publish: (value) => {
			notifyUpdate({ kind: "download-paused", id: value.id });
		},
		clear: () => undefined,
		report: (reason) => {
			reasons.push(reason);
			diagnosed.resolve();
			throw new Error(markers.join(" "));
		},
	});
	try {
		// When the real deadline expires, the read resumes, then hydration retries.
		worker.interrupted(fact);
		await entered.promise;
		await diagnosed.promise;
		held.resolve();
		await worker.settled();
		expect(ledger.read()).toEqual([]);
		worker.hydrate();
		await worker.settled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		// Then expiry still fences the late read and the retained fact is delivered safely.
		expect(reasons).toEqual(["worker-timeout"]);
		expect(ledger.read()).toEqual([{ ...fact, status: "active" }]);
		expect(getPersistentNotifications(true).show).toMatchObject([
			{
				name: `update:download-paused:${fact.id}`,
				key: "notifications.updatePausedForStream",
			},
		]);
		expect(exceptions).toEqual([]);
		expect(rejections).toEqual([]);
		const payload = JSON.stringify(
			getPersistentNotifications(true).show.map(({ name, params }) => ({
				name,
				params,
			})),
		);
		for (const marker of markers) expect(payload).not.toContain(marker);
	} finally {
		held.resolve();
		await worker.settled();
	}
});

test("worker catch isolates a throwing reporter while the next queued hold is committed and published", async () => {
	// Given one failed publisher followed by a healthy queued interruption.
	const ledger = new DownloadPausedLedger(join(root, "ledger.json"));
	const reasons: NoticeDiagnostic[] = [];
	worker = new DownloadPausedNotices({
		ledger,
		publish: (value) => {
			if (value.id === fact.id)
				throw new Error("synthetic publication failure");
			notifyUpdate({ kind: "download-paused", id: value.id });
		},
		clear: () => undefined,
		report: (reason) => {
			reasons.push(reason);
			throw new Error(markers.join(" "));
		},
	});
	// When detached publication fails and its diagnostic transport throws too.
	worker.interrupted(fact);
	worker.interrupted(successor);
	await worker.settled();
	await new Promise<void>((resolve) => setImmediate(resolve));
	// Then both intents survive, the next notice publishes, and neither error escapes.
	expect(reasons).toEqual(["publication-failed"]);
	expect(ledger.read()).toEqual([
		{ ...fact, status: "active" },
		{ ...successor, status: "active" },
	]);
	expect(getPersistentNotifications(true).show).toMatchObject([
		{
			name: `update:download-paused:${successor.id}`,
			key: "notifications.updatePausedForStream",
		},
	]);
	expect(exceptions).toEqual([]);
	expect(rejections).toEqual([]);
	const payload = JSON.stringify(
		getPersistentNotifications(true).show.map(({ name, params }) => ({
			name,
			params,
		})),
	);
	for (const marker of markers) expect(payload).not.toContain(marker);
});
