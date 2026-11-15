import { afterEach, expect, spyOn, test } from "bun:test";
import type { LogFollowMessage } from "@ceraui/rpc/schemas";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { startFollow, stopFollow } from "../modules/device-logs/follow.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import * as sharing from "../modules/device-logs/sharing.ts";
import { journalLine } from "./helpers/device-journal.ts";
import { bootId } from "./helpers/device-query.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";
import { historyJournal } from "./helpers/history-journal.ts";

const reserve = sharing.reserveLogSharing;
let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

for (const concurrent of [
	"clear",
	"stop then clear",
	"replace then clear",
	"stop",
] as const) {
	test(`catch-up resolution cannot publish or become ready during ${concurrent}`, async () => {
		h = historyFixture(false);
		const messages: LogFollowMessage[] = [];
		const conn = h.socket(messages);
		const process = historyJournal();
		const baseline = h.scan.getMockImplementation();
		if (!baseline) throw new Error("missing native transport");
		let probes = 0;
		let clearing: Promise<Awaited<ReturnType<typeof clearAll>>> | undefined;
		let replacement: ReturnType<typeof startFollow> | undefined;
		let stopping: ReturnType<typeof stopFollow> | undefined;
		const clearStarted = Promise.withResolvers<void>();
		h.scan.mockImplementation((input) => {
			const result = baseline(input);
			if (++probes !== 2) return result;
			return result.then((value) => {
				queueMicrotask(() => {
					if (concurrent === "stop") {
						queueMicrotask(() => {
							stopping = h.own(stopFollow(conn));
							clearStarted.resolve();
						});
						return;
					}
					if (concurrent === "stop then clear")
						stopping = h.own(stopFollow(conn));
					if (concurrent === "replace then clear")
						replacement = h.own(
							startFollow(
								conn,
								{},
								{
									clock: h.time.clock,
									spawn: () => process.proc,
								},
							),
						);
					clearing = h.own(clearAll());
					clearStarted.resolve();
				});
				return value;
			});
		});
		const started = await startFollow(
			conn,
			{},
			{ clock: h.time.clock, spawn: () => process.proc },
		);
		if (!started.ok) throw new Error(started.error);
		try {
			await bounded(
				process.emit(
					Array.from({ length: 2001 }, (_, index) =>
						journalLine({
							__CURSOR: `s=${index + 2}`,
							_BOOT_ID: bootId,
							__REALTIME_TIMESTAMP: String(index * 1000 + 2000),
							MESSAGE: `catchup ${index}`,
						}),
					).join(""),
				),
			);
			await bounded(clearStarted.promise);
			if (clearing) expect((await bounded(clearing)).ok).toBe(true);
			else expect(concurrent).toBe("stop");
			expect(
				messages.map((message) => ({ ended: message.ended, gap: message.gap })),
			).toEqual(
				concurrent === "stop" ? [] : [{ ended: "cleared", gap: undefined }],
			);
			if (replacement)
				expect(await bounded(replacement)).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
			if (stopping) expect((await bounded(stopping)).success).toBe(true);
			expect(h.time.timers.size).toBe(0);
			expect(await stopFollow(conn)).toEqual({
				success: false,
				checkpointCursor: null,
			});
		} finally {
			process.finish();
			if (clearing) await bounded(clearing);
		}
	});
}

test("client abort during a paused clear produces one incomplete footer and releases sharing", async () => {
	h = historyFixture(true);
	const controller = new AbortController();
	const created = await createExport({}, { filter: {} });
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const body = response.body?.getReader();
	if (!body) throw new Error("missing export");
	await bounded(body.read());
	const clearing = h.own(clearAll());
	const footer = body.read();
	controller.abort();
	expect((await bounded(clearing)).ok).toBe(true);
	expect(new TextDecoder().decode((await bounded(footer)).value)).toBe(
		"# incomplete: cleared\n",
	);
	expect(await bounded(body.read())).toEqual({ done: true, value: undefined });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("client abort body cancellation and clear finish one real export exactly once", async () => {
	h = historyFixture(true);
	const releases: number[] = [];
	const observed = spyOn(sharing, "reserveLogSharing").mockImplementation(
		(now) => {
			const lease = reserve(now);
			if (!lease) return lease;
			const index = releases.push(0) - 1;
			const release = lease.release;
			lease.release = () => {
				releases[index] = (releases[index] ?? 0) + 1;
				release();
			};
			return lease;
		},
	);
	const entered = Promise.withResolvers<void>();
	const releaseMetadata = h.ownedLatch();
	h.context.mockImplementationOnce(async () => {
		entered.resolve();
		await releaseMetadata.hold();
		throw new TypeError("metadata consumer failed");
	});
	const controller = new AbortController();
	const created = await createExport({}, { filter: {} });
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const body = response.body?.getReader();
	if (!body) throw new Error("missing body");
	const reading = h.own(
		body.read().then(
			(value) => value,
			(error: unknown) => error,
		),
	);
	await bounded(entered.promise);
	const clearing = h.own(clearAll());
	controller.abort();
	const cancelling = h.own(body.cancel());
	try {
		releaseMetadata.release();
		expect((await bounded(clearing)).ok).toBe(true);
		await bounded(Promise.allSettled([reading, cancelling]));
		expect(releases[0]).toBe(1);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
		expect(await createExport({}, { filter: {} })).toEqual({
			ok: false,
			error: "BUSY",
		});
	} finally {
		releaseMetadata.release();
		await bounded(Promise.allSettled([reading, cancelling, clearing]));
		observed.mockRestore();
	}
});

test("an export with an active first page joins cancellation before clear completes", async () => {
	h = historyFixture(false);
	const page = await import("../modules/device-logs/scan-page.ts");
	const real = page.scanPage;
	const boundary = h.ownedLatch();
	let scans = 0;
	const scanned = spyOn(page, "scanPage").mockImplementation(
		async (...args) => {
			const result = await real(...args);
			if (++scans === 1) {
				await boundary.hold();
				if (!result.ok) throw new Error(result.error);
				return {
					...result,
					hasMore: null,
					termination: "budget",
					continuation: null,
				};
			}
			return result;
		},
	);
	const created = await createExport({}, { filter: {} });
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	const content = h.own(response.text());
	await bounded(boundary.entered);
	const clearing = h.own(clearAll());
	try {
		await turn();
		boundary.release();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(await bounded(content)).toEndWith("# incomplete: cleared\n");
		expect(scans).toBe(1);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		boundary.release();
		await bounded(Promise.allSettled([clearing, content]));
		scanned.mockRestore();
	}
});
