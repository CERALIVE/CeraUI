import { spyOn } from "bun:test";
import {
	type LogFollowMessage,
	logFollowMessageSchema,
} from "@ceraui/rpc/schemas";
import * as logging from "../../helpers/logger.ts";
import * as boots from "../../modules/device-logs/boots.ts";
import * as ceiling from "../../modules/device-logs/ceiling.ts";
import * as follow from "../../modules/device-logs/follow.ts";
import * as reader from "../../modules/device-logs/reader.ts";
import * as files from "../../modules/device-logs/retention-files.ts";
import * as versions from "../../modules/system/version-context.ts";
import { fakeJournal, journalLine, manualClock } from "./device-journal.ts";
import { bootId } from "./device-query.ts";
import { retentionFixture } from "./device-retention.ts";
import { historyJournal } from "./history-journal.ts";

const realScan = reader.scanJournal;
const realBytes = files.legacyDebugBytes;
export function historyInputs(mock: boolean) {
	const f = retentionFixture();
	f.mock.mockReturnValue(mock);
	f.stop.mockRestore();
	f.abort.mockRestore();
	f.scan.mockRestore();
	const time = manualClock();
	const records: string[] = [];
	const watches = new Set<ReturnType<typeof historyJournal>>();
	let seq = 0;
	const unsubscribe = logging.onLogLine((line) => {
		const data = JSON.parse(line);
		const raw = journalLine({
			__CURSOR: `s=${++seq}`,
			__REALTIME_TIMESTAMP: String(Date.parse(data.ts) * 1000),
			_BOOT_ID: bootId,
			_SYSTEMD_UNIT: "ceralive.service",
			MESSAGE: line,
		});
		records.push(raw);
		return Promise.all(
			[...watches]
				.filter((watch) => watch.alive)
				.map((watch) => watch.emit(raw)),
		);
	});
	const limit = spyOn(ceiling, "readJournalCeiling").mockReturnValue({
		maxSizeMb: 256,
		maxAgeDays: 30,
	});
	const directory = spyOn(files, "journalDirectoryBytes").mockResolvedValue(0);
	const list = spyOn(boots, "listBoots").mockResolvedValue([
		{
			bootId,
			index: 0,
			firstTs: 0,
			lastTs: Date.now(),
			current: true,
			shutdown: "current",
			evidence: [],
			logsAvailable: true,
			versions: null,
		},
	]);
	const context = spyOn(versions, "collectVersionContext").mockResolvedValue({
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
	const scan = spyOn(reader, "scanJournal").mockImplementation((input) => {
		if (input.spawn) return realScan(input);
		let rows = [...records];
		if (input.options.includes("-r")) rows.reverse();
		const cursor = input.options.find((option) =>
			option.startsWith("--cursor="),
		);
		if (cursor) {
			const index = rows.findIndex(
				(line) => JSON.parse(line).__CURSOR === cursor.slice(9),
			);
			rows = index < 0 ? [] : rows.slice(index);
		}
		return realScan({ ...input, spawn: () => fakeJournal(rows).child });
	});
	const journal: {
		rotate?: () => Promise<void>;
		vacuum?: () => Promise<void>;
	} = {};
	f.run.mockImplementation(async (cmd, args) => {
		if (cmd !== "journalctl") throw new Error("unexpected command");
		if (args[0] === "--rotate") await journal.rotate?.();
		if (args[0]?.startsWith("--vacuum")) {
			await journal.vacuum?.();
			if (args[0] === "--vacuum-time=1s") records.length = 0;
		}
		return args.includes("--disk-usage") ? "take up 1M" : "[]";
	});
	f.read.mockResolvedValue("0 0");
	const spawn = (argv: readonly string[]) => {
		const cursor = argv.find((arg) => arg.startsWith("--cursor="))?.slice(9);
		const index = records.findIndex(
			(raw) => JSON.parse(raw).__CURSOR === cursor,
		);
		const child = historyJournal({
			lines: index < 0 ? [] : records.slice(index),
		});
		const kill = child.proc.kill;
		child.proc.kill = (signal) => {
			watches.delete(child);
			kill(signal);
		};
		watches.add(child);
		return child.proc;
	};
	const socket = (messages: LogFollowMessage[] = []) => ({
		data: { senderId: crypto.randomUUID() },
		send(frame: string) {
			messages.push(
				logFollowMessageSchema.parse(JSON.parse(frame)["logs.follow"]),
			);
			return Buffer.byteLength(frame);
		},
	});
	const start = async (conn = socket()) => {
		const result = await follow.startFollow(
			conn,
			{},
			{
				clock: time.clock,
				spawn,
			},
		);
		if (!result.ok) throw new Error(result.error);
		return { conn, result };
	};
	logging.logger.info("before-clear");
	return {
		f,
		mock,
		time,
		records,
		scan,
		context,
		list,
		limit,
		directory,
		watches,
		journal,
		spawn,
		socket,
		start,
		holdReadout(hold: () => Promise<void>) {
			const bytes = spyOn(files, "legacyDebugBytes").mockImplementationOnce(
				async () => {
					await hold();
					return realBytes();
				},
			);
			return () => bytes.mockRestore();
		},
		async dispose() {
			scan.mockRestore();
			context.mockRestore();
			list.mockRestore();
			limit.mockRestore();
			directory.mockRestore();
			unsubscribe();
			await f.restore();
		},
	};
}
