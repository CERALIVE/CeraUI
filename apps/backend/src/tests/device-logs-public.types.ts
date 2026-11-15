import type { LogEntry } from "@ceraui/rpc/schemas";
import type {
	parseRecord,
	RawJournalRecord,
	toLogEntry,
} from "../modules/device-logs/parse.ts";

type Equal<L, R> =
	(<T>() => T extends L ? 1 : 2) extends <T>() => T extends R ? 1 : 2
		? (<T>() => T extends R ? 1 : 2) extends <T>() => T extends L ? 1 : 2
			? true
			: false
		: false;
type Assert<T extends true> = T;

type ExpectedRaw = LogEntry & {
	readonly messageId: string | null;
	readonly unitField: string | null;
	readonly pid: number | null;
};

// These assertions are checked by the strict test project, not erased-test execution.
export type DeviceJournalPublicContracts = [
	Assert<Equal<RawJournalRecord, ExpectedRaw>>,
	Assert<Equal<typeof parseRecord, (input: unknown) => ExpectedRaw | null>>,
	Assert<Equal<typeof toLogEntry, (record: ExpectedRaw) => LogEntry>>,
];
