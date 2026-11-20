import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { LOG_LEVELS } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import { compileFilter } from "../modules/device-logs/filter.ts";
import {
	followMockJournal,
	scanMockJournal,
} from "../modules/device-logs/mock-journal.ts";
import type { RawJournalRecord } from "../modules/device-logs/parse.ts";
import { scanInput } from "./helpers/device-journal.ts";

const stops: Array<() => void> = [];
beforeEach(() => logging.clearRecentLogLines());
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	logging.clearRecentLogLines();
});
const emit = (message: string, level = "debug") =>
	new Promise<void>((resolve, reject) =>
		logging.logger.write({ message, level, module: "fixture" }, (error) =>
			error ? reject(error) : resolve(),
		),
	);
async function collect(options: string[] = [], matches: string[] = []) {
	const entries: RawJournalRecord[] = [];
	const result = await scanMockJournal({
		...scanInput,
		options,
		matches,
		onRecord(record) {
			entries.push(record);
			return "continue";
		},
	});
	return { entries, result };
}

test("ring scans use the current journal boot and stable sequence without spawning", async () => {
	const offset = logging.getLogRingOffset();
	const bootId = currentBootId();
	if (!bootId) throw new Error("test host has no journal boot identity");
	await emit("first");
	await emit("second", "info");
	const spawn = spyOn(Bun, "spawn");
	try {
		const { entries, result } = await collect();
		expect(result).toMatchObject({ status: "eof", exitCode: 0 });
		expect(
			entries.map((r) => [r.cursor, r.bootId, r.source, r.message, r.level]),
		).toEqual([
			[`mock=${offset}`, bootId, "app", "[fixture] first", "debug"],
			[`mock=${offset + 1}`, bootId, "app", "[fixture] second", "info"],
		]);
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
	}
});

test("reverse, inclusive and exclusive cursor positioning preserve journal order", async () => {
	const start = logging.getLogRingOffset();
	for (const name of ["one", "two", "three"]) await emit(name);
	expect(
		(await collect(["-r", `--cursor=mock=${start + 1}`])).entries.map(
			(r) => r.message,
		),
	).toEqual(["[fixture] two", "[fixture] one"]);
	expect(
		(await collect([`--after-cursor=mock=${start + 1}`])).entries.map(
			(r) => r.message,
		),
	).toEqual(["[fixture] three"]);
	expect((await collect(["--cursor=mock=999999999"])).entries).toEqual([]);
	logging.clearRecentLogLines();
	await emit("after clear");
	expect((await collect([`--cursor=mock=${start}`])).entries).toEqual([]);
	expect((await collect()).entries[0]?.cursor).toBe(`mock=${start + 3}`);
});

test("real compiled OR groups and priorities apply before delivery", async () => {
	await emit("debug");
	await emit("error", "error");
	for (const sources of [[], ["app"], ["kernel", "app"]] as const) {
		const { matches } = compileFilter(
			{ sources: [...sources], levels: ["error"] },
			{ bootId: currentBootId() ?? null },
		);
		expect((await collect([], matches)).entries.map((r) => r.level)).toEqual([
			"error",
		]);
	}
	for (const matches of [
		["_SYSTEMD_UNIT=ssh.service"],
		["_BOOT_ID=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
		["UNKNOWN=value"],
	])
		expect((await collect([], matches)).entries).toEqual([]);
	expect(
		(
			await collect(
				[],
				compileFilter({ levels: [...LOG_LEVELS] }, { bootId: null }).matches,
			)
		).entries,
	).toHaveLength(2);
});

test("mock scans share byte, record, abort and callback-stop semantics", async () => {
	await emit("one");
	await emit("two");
	expect(
		(
			await scanMockJournal({
				...scanInput,
				limits: { records: 1 },
			})
		).status,
	).toBe("budget");
	expect(
		(
			await scanMockJournal({
				...scanInput,
				limits: { stdoutBytes: 1 },
			})
		).status,
	).toBe("budget");
	expect(
		(
			await scanMockJournal({
				...scanInput,
				onRecord: () => "stop",
			})
		).status,
	).toBe("stopped");
	const controller = new AbortController();
	controller.abort();
	expect(
		(
			await scanMockJournal({
				...scanInput,
				signal: controller.signal,
			})
		).status,
	).toBe("stopped");
});

test("follow returns inclusive backlog then live entries and abort unsubscribes", async () => {
	const offset = logging.getLogRingOffset();
	await emit("one");
	await emit("two");
	const controller = new AbortController();
	const entries: string[] = [];
	const handle = followMockJournal({
		...scanInput,
		options: [`--cursor=mock=${offset}`],
		signal: controller.signal,
		onRecord(record) {
			entries.push(record.message);
			return "continue";
		},
	});
	stops.push(handle.abort);
	await emit("three");
	controller.abort();
	await handle.exited;
	await emit("ignored");
	expect(entries).toEqual([
		"[fixture] one",
		"[fixture] two",
		"[fixture] three",
	]);
});

test("an excluded checkpoint still yields the first matching backlog and later live record", async () => {
	const offset = logging.getLogRingOffset();
	await emit("checkpoint");
	await emit("backlog", "error");
	const entries: string[] = [];
	const { matches } = compileFilter(
		{ levels: ["error"], sources: ["app"] },
		{ bootId: null },
	);
	const handle = followMockJournal({
		...scanInput,
		options: [`--cursor=mock=${offset}`],
		matches,
		onRecord(record) {
			entries.push(record.message);
			return "continue";
		},
	});
	stops.push(handle.abort);
	await emit("live", "error");
	handle.abort();
	await handle.exited;
	expect(entries).toEqual(["[fixture] backlog", "[fixture] live"]);
});

test("empty follow subscribes without a timer and consumer stop is final", async () => {
	let seen = 0;
	const handle = followMockJournal({
		...scanInput,
		onRecord() {
			seen++;
			return "stop";
		},
	});
	stops.push(handle.abort);
	await emit("first");
	expect(await handle.exited).toBe(0);
	await emit("second");
	expect(seen).toBe(1);
	handle.abort();
});

test("follow callback errors end the subscription rather than escape into the logger", async () => {
	const failure = new Error("consumer");
	const handle = followMockJournal({
		...scanInput,
		onRecord() {
			throw failure;
		},
	});
	stops.push(handle.abort);
	const rejected = handle.exited.catch((error: unknown) => error);
	await emit("first");
	expect(await rejected).toBe(failure);
	await emit("second");
});
