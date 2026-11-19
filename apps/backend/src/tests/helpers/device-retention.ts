import { spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as timersApi from "node:timers";
import * as logging from "../../helpers/logger.ts";
import * as runner from "../../helpers/run.ts";
import * as mocks from "../../mocks/mock-service.ts";
import * as boot from "../../modules/device-logs/boot-id.ts";
import * as follow from "../../modules/device-logs/follow.ts";
import * as archives from "../../modules/device-logs/journal-archive-snapshot.ts";
import * as queries from "../../modules/device-logs/query-admission.ts";
import * as reader from "../../modules/device-logs/reader.ts";
import * as settings from "../../modules/device-logs/settings.ts";
import * as runtime from "../../modules/system/update-orchestrator/runtime.ts";
import { record } from "./device-query.ts";

export function retentionFixture() {
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("unexpected native process");
	});
	const dir = mkdtempSync(join(tmpdir(), "device-retention-"));
	const cwd = process.cwd();
	process.chdir(dir);
	settings.setLogSettingsDirForTest(dir);
	logging.clearRecentLogLines();
	const mock = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	const identity = spyOn(boot, "currentBootId").mockReturnValue(
		record(1).bootId,
	);
	const archiveScope = spyOn(archives, "journalArchiveScope").mockReturnValue({
		machine: "b".repeat(32),
		directories: [dir],
	});
	const phase = spyOn(runtime, "getOrchestratorState").mockReturnValue({
		...runtime.getOrchestratorState(),
		phase: "idle",
	});
	const stop = spyOn(follow, "stopAllFollows").mockResolvedValue();
	const abort = spyOn(queries, "abortLogQueries").mockResolvedValue();
	const read = spyOn(fs, "readFile");
	const nativeScan = reader.scanJournal;
	const scan = spyOn(reader, "scanJournal").mockImplementation(
		async (input) => {
			if (input.spawn) return nativeScan(input);
			const rows = input.options.includes("-r")
				? [
						{
							...record(2),
							ts: Date.now(),
							source: "engine" as const,
							message: "\u00e9",
						},
						{ ...record(1), ts: Date.now(), message: "abc" },
					]
				: [{ ...record(1), ts: Date.now() }];
			for (const row of rows) if (input.onRecord(row) === "stop") break;
			return { status: "eof", exitCode: 0, skippedRecords: 0 };
		},
	);
	const run = spyOn(runner, "run").mockImplementation(async (cmd, args) => {
		if (cmd !== "journalctl") throw new Error("unexpected command");
		if (args.includes("--disk-usage")) return "take up 32M";
		if (args.includes("--list-boots")) return "[]";
		return "";
	});
	const detail = spyOn(logging, "setJournalDetail");
	const schedule = spyOn(timersApi, "setInterval");
	return {
		dir,
		mock,
		phase,
		stop,
		abort,
		scan,
		archiveScope,
		run,
		detail,
		schedule,
		read,
		async restore() {
			for (const result of schedule.mock.results)
				if (result.type === "return") timersApi.clearInterval(result.value);
			schedule.mockRestore();
			for (const spy of [
				spawn,
				mock,
				identity,
				archiveScope,
				phase,
				stop,
				abort,
				scan,
				run,
				detail,
				read,
			])
				spy.mockRestore();
			settings.setLogSettingsDirForTest(null);
			process.chdir(cwd);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
