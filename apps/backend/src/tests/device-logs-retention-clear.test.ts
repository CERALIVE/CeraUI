import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	type LogFollowMessage,
	logDeleteOlderFilesOutputSchema,
	logFollowMessageSchema,
	logStorageOutputSchema,
} from "@ceraui/rpc/schemas";
import { getRecentLogLines, logger } from "../helpers/logger.ts";
import type { ManagedProcess } from "../helpers/spawn-policy.ts";
import * as boots from "../modules/device-logs/boots.ts";
import * as ceiling from "../modules/device-logs/ceiling.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import {
	startFollow,
	stopAllFollows,
	stopFollow,
} from "../modules/device-logs/follow.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { abortLogQueries } from "../modules/device-logs/query-admission.ts";
import * as reader from "../modules/device-logs/reader.ts";
import {
	clearAll,
	deleteLegacyDebug,
	deleteOlderFiles,
	maintain,
	setRetention,
} from "../modules/device-logs/retention.ts";
import * as files from "../modules/device-logs/retention-files.ts";
import * as versions from "../modules/system/version-context.ts";
import { fakeJournal, manualClock } from "./helpers/device-journal.ts";
import { bootId, record } from "./helpers/device-query.ts";
import { retentionFixture } from "./helpers/device-retention.ts";

const nativeScan = reader.scanJournal;
let f: ReturnType<typeof retentionFixture>;
let context: ReturnType<typeof spyOn<typeof versions, "collectVersionContext">>;
let list: ReturnType<typeof spyOn<typeof boots, "listBoots">>;
let scan: ReturnType<typeof spyOn<typeof reader, "scanJournal">> | undefined;

async function bounded<T>(event: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			event,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("event deadline")), 1000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

beforeEach(() => {
	f = retentionFixture();
	f.mock.mockReturnValue(true);
	f.stop.mockRestore();
	f.abort.mockRestore();
	f.scan.mockRestore();
	scan = undefined;
	list = spyOn(boots, "listBoots").mockResolvedValue([
		{
			bootId,
			index: 0,
			firstTs: 1,
			lastTs: 1,
			current: true,
			shutdown: "current",
			evidence: [],
			logsAvailable: true,
			versions: null,
		},
	]);
	context = spyOn(versions, "collectVersionContext").mockResolvedValue({
		bootId,
		osImage: null,
		slot: null,
		board: null,
		boardModel: null,
		ceraui: "test",
		engine: null,
		senderVersion: null,
		kernel: null,
		bun: Bun.version,
	});
	logger.info("evidence before clear");
});
afterEach(async () => {
	await bounded(stopAllFollows("cleared"));
	await bounded(abortLogExports());
	await bounded(abortLogQueries());
	scan?.mockRestore();
	context.mockRestore();
	list.mockRestore();
	await f.restore();
});

async function ticket() {
	const result = await createExport({}, { filter: {} });
	if (!result.ok) throw new Error(result.error);
	return result;
}
async function pausedExport() {
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	const body = response.body?.getReader();
	if (!body) throw new Error("missing export body");
	const header = await bounded(body.read());
	expect(new TextDecoder().decode(header.value)).toContain("# exported-by\n");
	return body;
}

test("clear releases a paused real export before another client read and preserves its incomplete footer", async () => {
	const body = await pausedExport();
	expect((await clearAll()).ok).toBe(true);
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
	const footer = await bounded(body.read());
	expect(new TextDecoder().decode(footer.value)).toBe(
		"# incomplete: cleared\n",
	);
	expect(await bounded(body.read())).toEqual({ done: true, value: undefined });
});

test("clear invalidates an unconsumed real export ticket and releases its sharing reservation", async () => {
	const created = await ticket();
	expect((await clearAll()).ok).toBe(true);
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
	const stale = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	expect(stale.status).toBe(403);
	expect(await stale.text()).toBe("");
});

test("clear joins an export suspended in header collection before discarding the journal ring", async () => {
	const current = await context();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	context.mockImplementationOnce(async () => {
		entered.resolve();
		await release.promise;
		return current;
	});
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	const body = response.body?.getReader();
	if (!body) throw new Error("missing export body");
	const pending = body.read();
	const before = getRecentLogLines();
	try {
		await bounded(entered.promise);
		const clearing = clearAll();
		await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
		expect(getRecentLogLines()).toEqual(before);
		release.resolve();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(new TextDecoder().decode((await bounded(pending)).value)).toBe(
			"# incomplete: cleared\n",
		);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		release.resolve();
		await bounded(abortLogExports());
	}
});

test.each([false, true])(
	"clear joins a real export scan with a throwing TERM signal=%s",
	async (throwing) => {
		const body = await pausedExport();
		const held = fakeJournal([], { held: true });
		const entered = Promise.withResolvers<void>();
		const kill = held.child.kill;
		held.child.kill = (signal) => {
			kill(signal);
			if (throwing) throw new Error("TERM signal failed");
		};
		scan = spyOn(reader, "scanJournal").mockImplementationOnce((input) => {
			entered.resolve();
			return nativeScan({ ...input, spawn: () => held.child });
		});
		const pending = body.read();
		try {
			await bounded(entered.promise);
			expect((await bounded(clearAll())).ok).toBe(true);
			expect((await createExport({}, { filter: {} })).ok).toBe(true);
			expect(held.signals).toEqual(["SIGTERM"]);
			expect(new TextDecoder().decode((await bounded(pending)).value)).toBe(
				"# incomplete: cleared\n",
			);
			expect(await bounded(body.read())).toEqual({
				done: true,
				value: undefined,
			});
		} finally {
			held.finish();
		}
	},
);

test("clear waits for both real query owners to reap their readers and frees query admission", async () => {
	const release = Promise.withResolvers<void>();
	const entered = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	const killed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const held = [
		fakeJournal([], { held: true }),
		fakeJournal([], { held: true }),
	];
	scan = spyOn(reader, "scanJournal");
	for (const [index, process] of held.entries()) {
		scan.mockImplementationOnce((input) => {
			entered[index]?.resolve();
			return nativeScan({
				...input,
				spawn: () => ({
					stdout: process.child.stdout,
					stderr: process.child.stderr,
					get signalCode() {
						return process.child.signalCode;
					},
					exited: process.child.exited.then(async (code) => {
						await release.promise;
						return code;
					}),
					kill(signal) {
						process.child.kill(signal);
						killed[index]?.resolve();
					},
				}),
			});
		});
	}
	const queries = [queryLogs({}, {}), queryLogs({}, {})];
	const before = getRecentLogLines();
	let finished = false;
	try {
		await bounded(Promise.all(entered.map((event) => event.promise)));
		const clearing = clearAll().then((result) => {
			finished = true;
			return result;
		});
		await bounded(Promise.all(killed.map((event) => event.promise)));
		await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
		expect(finished).toBe(false);
		expect(getRecentLogLines()).toEqual(before);
		release.resolve();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(await bounded(Promise.all(queries))).toEqual([
			{ ok: false, error: "READ_FAILED" },
			{ ok: false, error: "READ_FAILED" },
		]);
		expect((await queryLogs({}, {})).ok).toBe(true);
		expect(held.map((process) => process.signals)).toEqual([
			["SIGTERM"],
			["SIGTERM"],
		]);
	} finally {
		release.resolve();
		for (const process of held) process.finish();
		await bounded(Promise.allSettled(queries));
	}
});

test("clear joins a real native follower before starting journal cleanup", async () => {
	f.mock.mockReturnValue(false);
	const time = manualClock();
	const held = fakeJournal([], { held: true });
	const killed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let exitCode: number | null = null;
	const child: ManagedProcess = {
		stdout: held.child.stdout,
		stderr: held.child.stderr,
		get exitCode() {
			return exitCode;
		},
		get signalCode() {
			return held.child.signalCode;
		},
		exited: held.child.exited.then(async (code) => {
			await release.promise;
			exitCode = code;
			return code;
		}),
		kill(signal) {
			expect(signal).toBe("SIGTERM");
			held.child.kill("SIGTERM");
			killed.resolve();
		},
	};
	const limit = spyOn(ceiling, "readJournalCeiling").mockReturnValue({
		maxSizeMb: 256,
		maxAgeDays: 30,
	});
	const directory = spyOn(files, "journalDirectoryBytes").mockResolvedValue(0);
	scan = spyOn(reader, "scanJournal").mockImplementationOnce(async (input) => {
		input.onRecord(record(1));
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	const messages: LogFollowMessage[] = [];
	const conn = {
		data: { senderId: "native-retention-clear" },
		send(frame: string) {
			messages.push(
				logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
			);
			return Buffer.byteLength(frame);
		},
	};
	try {
		expect(
			(await startFollow(conn, {}, { spawn: () => child, clock: time.clock }))
				.ok,
		).toBe(true);
		const clearing = clearAll();
		await bounded(killed.promise);
		await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
		expect(f.run.mock.calls).toEqual([]);
		release.resolve();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(held.signals).toEqual(["SIGTERM"]);
		expect(messages.map((message) => message.ended)).toEqual(["cleared"]);
		expect(time.timers.size).toBe(0);
		expect(await stopFollow(conn)).toEqual({
			success: false,
			checkpointCursor: null,
		});
	} finally {
		release.resolve();
		held.finish();
		await bounded(stopAllFollows("cleared"));
		limit.mockRestore();
		directory.mockRestore();
	}
});

test.each([false, true])(
	"clear retires a real ring follower and its pending timer with a throwing subscriber=%s",
	async (throwing) => {
		const time = manualClock();
		const messages: LogFollowMessage[] = [];
		const conn = {
			data: { senderId: "retention-clear" },
			send(frame: string) {
				messages.push(
					logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
				);
				if (throwing) throw new Error("subscriber failed");
				return Buffer.byteLength(frame);
			},
		};
		expect((await startFollow(conn, {}, { clock: time.clock })).ok).toBe(true);
		logger.info("pending follower record");
		expect(time.timers.size).toBe(1);
		expect((await bounded(clearAll())).ok).toBe(true);
		expect(messages.map((message) => message.ended)).toEqual(["cleared"]);
		expect(time.timers.size).toBe(0);
		expect(await stopFollow(conn)).toEqual({
			success: false,
			checkpointCursor: null,
		});
		logger.info("after follower removal");
		expect(messages.length).toBe(1);
		expect((await startFollow(conn, {}, { clock: time.clock })).ok).toBe(true);
	},
);

test("update refusal preserves a paused real export and its sharing reservation", async () => {
	const body = await pausedExport();
	f.phase.mockReturnValue({ ...f.phase(), phase: "committing" });
	expect(await clearAll()).toEqual({ ok: false, error: "UPDATE_IN_PROGRESS" });
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	let text = "";
	for (;;) {
		const chunk = await bounded(body.read());
		if (chunk.done) break;
		text += new TextDecoder().decode(chunk.value);
	}
	expect(text).toEndWith("# complete: 1 entries\n");
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

for (const { name, invoke, schema } of [
	{
		name: "setRetention",
		invoke: () =>
			setRetention({ maxAgeDays: null, maxSizeMb: null, detail: "info" }),
		schema: logStorageOutputSchema,
	},
	{
		name: "deleteOlderFiles",
		invoke: deleteOlderFiles,
		schema: logDeleteOlderFilesOutputSchema,
	},
	{
		name: "deleteLegacyDebug",
		invoke: deleteLegacyDebug,
		schema: logStorageOutputSchema,
	},
	{
		name: "clearAll",
		invoke: clearAll,
		schema: logDeleteOlderFilesOutputSchema,
	},
]) {
	test(`the successful ${name} reply carries resolved wire storage`, async () => {
		const result = await invoke();
		expect(result.ok).toBe(true);
		expect(schema.safeParse(result).success).toBe(true);
	});
}

test("native older-file cleanup returns resolved wire storage", async () => {
	f.mock.mockReturnValue(false);
	f.read.mockResolvedValue("0 0");
	const current = (await list())[0];
	if (!current) throw new Error("missing current boot");
	list.mockResolvedValue([
		current,
		{
			...current,
			bootId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			index: -1,
			current: false,
			logsAvailable: false,
		},
	]);
	const limit = spyOn(ceiling, "readJournalCeiling").mockReturnValue({
		maxSizeMb: 256,
		maxAgeDays: 30,
	});
	const directory = spyOn(files, "journalDirectoryBytes").mockResolvedValue(0);
	try {
		const result = await deleteOlderFiles();
		expect(result).toMatchObject({ ok: true, bootsBefore: 1, bootsAfter: 1 });
		expect(logDeleteOlderFilesOutputSchema.safeParse(result).success).toBe(
			true,
		);
	} finally {
		limit.mockRestore();
		directory.mockRestore();
	}
});

test("inactive maintenance resolves to its public void result", async () => {
	expect(await maintain()).toBeUndefined();
});
