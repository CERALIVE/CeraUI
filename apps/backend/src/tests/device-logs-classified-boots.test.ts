import { afterEach, expect, spyOn, test } from "bun:test";
import type { DeviceEvent, LogBootInfo } from "@ceraui/rpc/schemas";
import * as mocks from "../mocks/mock-service.ts";
import * as boots from "../modules/device-logs/boots.ts";
import { listBoots } from "../modules/device-logs/classified-boots.ts";
import * as reader from "../modules/device-logs/reader.ts";
import * as store from "../modules/events/store.ts";
import { journal, record } from "./helpers/device-query.ts";

afterEach(() => {
	spyOn(boots, "listBoots").mockRestore();
	spyOn(reader, "scanJournal").mockRestore();
	spyOn(store, "readEvents").mockRestore();
	spyOn(mocks, "shouldUseMocks").mockRestore();
});

function row(current = false): LogBootInfo {
	return {
		bootId: crypto.randomUUID().replaceAll("-", ""),
		index: current ? 0 : -1,
		firstTs: 0,
		lastTs: 100,
		current,
		logsAvailable: true,
		shutdown: current ? "current" : "unknown",
		evidence: [],
		versions: null,
	};
}
function fixture(rows: LogBootInfo[]) {
	spyOn(boots, "listBoots").mockResolvedValue(rows);
	spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	spyOn(store, "readEvents").mockReturnValue([]);
	return spyOn(reader, "scanJournal").mockImplementation(
		journal([record(1, { MESSAGE_ID: "d93fb3c9c24d451a97cea615ce59c00b" })]),
	);
}
function request(bootId: string, code: string): DeviceEvent {
	return {
		id: "request",
		seq: 1,
		bootId,
		at: 0,
		code,
		family: "device",
		severity: "info",
		params: {},
	};
}

test("classified list preserves rows and caches a finished boot with its following boot", async () => {
	const current = row(true);
	const finished = row();
	const scan = fixture([current, finished]);
	const first = await listBoots();
	const second = await listBoots();
	expect(first).toEqual([
		current,
		{ ...finished, shutdown: "clean", evidence: ["journal_stopped"] },
	]);
	expect(second).toEqual(first);
	expect(
		scan.mock.calls.map(([input]) => [input.options, input.matches]),
	).toEqual([
		[["-r"], [`_BOOT_ID=${finished.bootId}`]],
		[[], [`_BOOT_ID=${current.bootId}`]],
	]);
});

test("latest finished boot is reread until a following boot appears, then cached", async () => {
	const finished = row();
	const scan = fixture([finished]);
	expect((await listBoots())[0]?.shutdown).toBe("clean");
	scan.mockImplementation(journal([]));
	expect((await listBoots())[0]?.shutdown).toBe("unknown");
	const current = row(true);
	spyOn(boots, "listBoots").mockResolvedValue([current, finished]);
	expect((await listBoots())[1]?.shutdown).toBe("unknown");
	scan.mockImplementation(journal([record(1)]));
	expect((await listBoots())[1]?.evidence).toEqual(["no_entries"]);
	expect(scan).toHaveBeenCalledTimes(4);
});

test("stored-only boots have no journal evidence and cannot supply a following boot head", async () => {
	const available = row();
	const removed = { ...row(), index: -2, logsAvailable: false };
	const scan = fixture([available, removed]);
	expect(await listBoots()).toEqual([
		{ ...available, shutdown: "clean", evidence: ["journal_stopped"] },
		{ ...removed, shutdown: "unknown", evidence: ["no_entries"] },
	]);
	expect(scan).toHaveBeenCalledTimes(1);
});

test("each finished boot uses the immediate following journal boot, never timestamp order", async () => {
	const current = row(true);
	const middle = { ...row(), firstTs: 99999, index: -1 };
	const oldest = { ...row(), firstTs: 999999, index: -2 };
	const scan = fixture([current, middle, oldest]);
	scan.mockImplementation(async (input) =>
		journal(
			input.matches[0] === `_BOOT_ID=${middle.bootId}` &&
				input.options.length === 0
				? [
						record(1, {
							_SYSTEMD_UNIT: "systemd-journald.service",
							MESSAGE: "journal corrupted",
						}),
					]
				: [],
		)(input),
	);
	expect(
		(await listBoots()).map(({ shutdown, evidence }) => ({
			shutdown,
			evidence,
		})),
	).toEqual([
		{ shutdown: "current", evidence: [] },
		{ shutdown: "unknown", evidence: ["no_entries"] },
		{ shutdown: "unclean", evidence: ["next_boot_unclean_journal"] },
	]);
});

test("only the classified boot's shutdown request adds request evidence", async () => {
	const current = row(true);
	const finished = row();
	const scan = fixture([current, finished]);
	scan.mockImplementation(
		journal(Array.from({ length: 20 }, (_, n) => record(n))),
	);
	spyOn(store, "readEvents").mockReturnValue([
		request(current.bootId, "shutdown_requested"),
		request(finished.bootId, "service_stopping"),
	]);
	expect((await listBoots())[1]?.evidence).toEqual(["no_shutdown_markers"]);
	const other = row();
	spyOn(boots, "listBoots").mockResolvedValue([current, other]);
	spyOn(store, "readEvents").mockReturnValue([
		request(other.bootId, "shutdown_requested"),
	]);
	expect((await listBoots())[1]?.evidence).toEqual([
		"no_shutdown_markers",
		"shutdown_requested_event",
	]);
});

test("journal failures propagate and do not poison the boot cache", async () => {
	const current = row(true);
	const finished = row();
	const scan = fixture([current, finished]);
	const fault = new reader.JournalReadError("JOURNAL_UNAVAILABLE");
	scan.mockRejectedValueOnce(fault);
	await expect(listBoots()).rejects.toBe(fault);
	expect((await listBoots())[1]?.shutdown).toBe("clean");
	expect(scan).toHaveBeenCalledTimes(3);
});

test("simultaneous listings share a finished boot scan and cannot mutate cached evidence", async () => {
	const current = row(true);
	const finished = row();
	const scan = fixture([current, finished]);
	const [first, second] = await Promise.all([listBoots(), listBoots()]);
	first[1]?.evidence.push("caller mutation");
	expect(second[1]?.evidence).toEqual(["journal_stopped"]);
	expect((await listBoots())[1]?.evidence).toEqual(["journal_stopped"]);
	expect(scan).toHaveBeenCalledTimes(2);
});

test("a cached classification survives journal cleanup with current availability metadata", async () => {
	const current = row(true);
	const finished = row();
	const scan = fixture([current, finished]);
	await listBoots();
	spyOn(boots, "listBoots").mockResolvedValue([
		current,
		{ ...finished, logsAvailable: false },
	]);
	expect((await listBoots())[1]).toEqual({
		...finished,
		logsAvailable: false,
		shutdown: "clean",
		evidence: ["journal_stopped"],
	});
	expect(scan).toHaveBeenCalledTimes(2);
});
