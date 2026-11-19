import { spyOn } from "bun:test";
import { logBootInfoSchema } from "@ceraui/rpc/schemas";
import * as mocks from "../../mocks/mock-service.ts";
import * as boots from "../../modules/device-logs/boots.ts";
import * as adapter from "../../modules/device-logs/mock-journal.ts";
import {
	parseRecord,
	type RawJournalRecord,
} from "../../modules/device-logs/parse.ts";
import * as reader from "../../modules/device-logs/reader.ts";
import * as settings from "../../modules/device-logs/settings.ts";
import { bootId, journalObject } from "./device-journal-record.ts";

export { bootId };
export const socket = () => ({ send: (_message: string) => undefined });
export const eventMessage = JSON.stringify({
	ts: "2026-01-01T00:00:00Z",
	level: "info",
	msg: "event",
	module: "events",
	meta: { event_id: "event-id" },
});
export function record(
	n: number,
	fields: Record<string, unknown> = {},
): RawJournalRecord {
	const parsed = parseRecord(
		journalObject({
			__CURSOR: `s=${n}`,
			__REALTIME_TIMESTAMP: String(n * 1000),
			_SYSTEMD_UNIT: "ceralive.service",
			MESSAGE: `entry ${n}`,
			...fields,
		}),
	);
	if (!parsed) throw new Error("invalid query fixture");
	return parsed;
}
export function queryFixture() {
	const mockScan = spyOn(adapter, "scanMockJournal").mockImplementation(() => {
		throw new Error("unexpected mock scan in a native query");
	});
	const mock = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	const list = spyOn(boots, "listBoots").mockResolvedValue([
		logBootInfoSchema.parse({
			bootId,
			index: 0,
			firstTs: 0,
			lastTs: 100,
			current: false,
			shutdown: "unknown",
			evidence: [],
			logsAvailable: true,
			versions: null,
		}),
	]);
	const epoch = spyOn(settings, "getLogState").mockReturnValue({
		historyEpoch: 7,
		lastClearedAt: null,
		lastMaintenance: null,
	});
	const scan = spyOn(reader, "scanJournal");
	return {
		mock,
		list,
		epoch,
		scan,
		restore() {
			mockScan.mockRestore();
			mock.mockRestore();
			list.mockRestore();
			epoch.mockRestore();
			scan.mockRestore();
		},
	};
}
export function journal(records: RawJournalRecord[], budget = Infinity) {
	return async (
		input: reader.ScanJournalOptions,
	): Promise<reader.JournalScanResult> => {
		let rows = [...records];
		if (input.options.includes("-r")) rows.reverse();
		const cursor = input.options
			.find((o) => o.startsWith("--cursor="))
			?.slice(9);
		if (cursor !== undefined) {
			const index = rows.findIndex((r) => r.cursor === cursor);
			rows = index < 0 ? [] : rows.slice(index);
		}
		let count = 0;
		for (const row of rows) {
			if (count++ >= budget)
				return { status: "budget", exitCode: 143, skippedRecords: 0 };
			if (input.onRecord(row) === "stop")
				return { status: "stopped", exitCode: 143, skippedRecords: 0 };
		}
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	};
}
