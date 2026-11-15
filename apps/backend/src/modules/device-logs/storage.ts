import type { LogStorage } from "@ceraui/rpc/schemas";
import { getRecentLogLines } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { eventsBytes } from "../events/store.ts";
import { parseDiskUsage, readJournalCeiling } from "./ceiling.ts";
import { scanMockJournal } from "./mock-journal.ts";
import { scanJournal } from "./reader.ts";
import { journalDirectoryBytes, legacyDebugBytes } from "./retention-files.ts";
import { getLogSettings, getLogState } from "./settings.ts";

export async function readJournalUsage(): Promise<number | null> {
	if (shouldUseMocks())
		return getRecentLogLines().reduce(
			(sum, line) => sum + Buffer.byteLength(line),
			0,
		);
	try {
		return parseDiskUsage(await run("journalctl", ["--disk-usage"]));
	} catch {
		return null;
	}
}

export async function readOldestEntry(): Promise<{
	readonly ts: number | null;
	readonly known: boolean;
}> {
	const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
	let ts: number | null = null;
	try {
		const result = await scan({
			options: [],
			matches: [],
			onRecord(record) {
				ts = record.ts;
				return "stop";
			},
		});
		const known =
			result.skippedRecords === 0 && (ts !== null || result.status === "eof");
		return { ts: known ? ts : null, known };
	} catch {
		return { ts: null, known: false };
	}
}

export async function getStorage(): Promise<LogStorage> {
	const mock = shouldUseMocks();
	const journalBytes = await readJournalUsage();
	const oldest = await readOldestEntry();
	const scan = mock ? scanMockJournal : scanJournal;
	const recentVolume: LogStorage["recentVolume"] = [];
	let recentSample = 0;
	try {
		const result = await scan({
			options: ["-r"],
			matches: [],
			limits: { records: 4096 },
			onRecord(record) {
				recentSample++;
				let source = recentVolume.find((row) => row.source === record.source);
				if (!source) {
					source = { source: record.source, entries: 0, bytes: 0 };
					recentVolume.push(source);
				}
				source.entries++;
				source.bytes += Buffer.byteLength(record.message);
				return "continue";
			},
		});
		recentSample += result.skippedRecords;
	} catch {
		recentVolume.length = 0;
		recentSample = 0;
	}
	const state = getLogState();
	return {
		journalBytes,
		journalDirBytes: mock ? journalBytes : await journalDirectoryBytes(),
		legacyDebugBytes: await legacyDebugBytes(),
		oldestEntryTs: oldest.ts,
		recentVolume,
		recentSample,
		eventsBytes: eventsBytes(),
		ceiling: mock ? { maxSizeMb: 256, maxAgeDays: 30 } : readJournalCeiling(),
		retention: getLogSettings(),
		lastMaintenance: state.lastMaintenance,
		lastClearedAt: state.lastClearedAt,
	};
}
