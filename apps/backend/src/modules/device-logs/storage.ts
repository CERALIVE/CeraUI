import type { LogStorage } from "@ceraui/rpc/schemas";
import { BOUNDED_SPAWN_TERM_GRACE_MS } from "../../helpers/bounded-spawn.ts";
import { getRecentLogLines } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { eventsBytes } from "../events/store.ts";
import { parseDiskUsage, readJournalCeiling } from "./ceiling.ts";
import { scanMockJournal } from "./mock-journal.ts";
import {
	JOURNAL_LIMITS,
	type ScanJournalOptions,
	scanJournal,
} from "./reader.ts";
import { journalDirectoryBytes, legacyDebugBytes } from "./retention-files.ts";
import { getLogSettings, getLogState } from "./settings.ts";

const READOUT_MS =
	JOURNAL_LIMITS.deadlineMs + BOUNDED_SPAWN_TERM_GRACE_MS + 1000;
let scanning = false;

export async function withinStorageDeadline<T, F>(
	work: Promise<T>,
	unavailable: F,
): Promise<T | F> {
	const deadline = Promise.withResolvers<F>();
	const timer = setTimeout(() => deadline.resolve(unavailable), READOUT_MS);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function scanReadout(input: ScanJournalOptions) {
	if (shouldUseMocks()) return scanMockJournal(input);
	if (scanning) return null;
	scanning = true;
	// The reply can leave first; ownership follows scanJournal through child exit.
	return withinStorageDeadline(
		scanJournal(input).finally(() => {
			scanning = false;
		}),
		null,
	);
}

export async function readJournalUsage(): Promise<number | null> {
	if (shouldUseMocks())
		return getRecentLogLines().reduce(
			(sum, line) => sum + Buffer.byteLength(line),
			0,
		);
	try {
		return parseDiskUsage(
			await run("journalctl", ["--disk-usage"], { timeout: 30_000 }),
		);
	} catch {
		return null;
	}
}

export async function readOldestEntry(): Promise<{
	readonly ts: number | null;
	readonly known: boolean;
}> {
	let ts: number | null = null;
	try {
		const result = await scanReadout({
			options: [],
			matches: [],
			onRecord(record) {
				ts = record.ts;
				return "stop";
			},
		});
		const known =
			result !== null &&
			result.skippedRecords === 0 &&
			(ts !== null || result.status === "eof");
		return { ts: known ? ts : null, known };
	} catch {
		return { ts: null, known: false };
	}
}

export async function getStorage(): Promise<LogStorage> {
	const mock = shouldUseMocks();
	const journalBytes = await readJournalUsage();
	const oldest = await readOldestEntry();
	const recentVolume: LogStorage["recentVolume"] = [];
	let recentSample = 0;
	let sampled = false;
	try {
		const result = await scanReadout({
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
		if (result !== null) {
			sampled = true;
			recentSample += result.skippedRecords;
		}
	} catch {
		// Unavailable, even if a partial sample arrived before the failure.
	}
	const state = getLogState();
	return {
		journalBytes,
		journalDirBytes: mock
			? journalBytes
			: await withinStorageDeadline(journalDirectoryBytes(), null),
		legacyDebugBytes: await withinStorageDeadline(legacyDebugBytes(), null),
		oldestEntryTs: oldest.ts,
		recentVolume: sampled ? recentVolume : [],
		recentSample: sampled ? recentSample : 0,
		eventsBytes: eventsBytes(),
		ceiling: mock ? { maxSizeMb: 256, maxAgeDays: 30 } : readJournalCeiling(),
		retention: getLogSettings(),
		lastMaintenance: state.lastMaintenance,
		lastClearedAt: state.lastClearedAt,
	};
}
