import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { scanMockJournal } from "./mock-journal.ts";
import type { RawJournalRecord } from "./parse.ts";
import { JournalReadError, scanJournal } from "./reader.ts";

export async function readShutdownWindow(
	bootId: string,
	end: "tail" | "head",
): Promise<RawJournalRecord[]> {
	const limit = end === "tail" ? 100 : 50;
	const records: RawJournalRecord[] = [];
	const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
	const result = await scan({
		options: end === "tail" ? ["-r"] : [],
		matches: [`_BOOT_ID=${bootId}`],
		onRecord(record) {
			records.push(record);
			return records.length === limit ? "stop" : "continue";
		},
	});
	if (
		result.status === "budget" ||
		(result.status === "stopped" && records.length < limit)
	)
		throw new JournalReadError("READ_FAILED");
	return records;
}
