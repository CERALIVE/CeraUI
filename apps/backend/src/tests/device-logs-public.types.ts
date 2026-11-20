import type { LogEntry } from "@ceraui/rpc/schemas";
import type {
	followMockJournal,
	MockFollowHandle,
	mockJournal,
	scanMockJournal,
} from "../modules/device-logs/mock-journal.ts";
import type {
	parseRecord,
	RawJournalRecord,
	toLogEntry,
} from "../modules/device-logs/parse.ts";
import type {
	JOURNAL_LIMITS,
	JOURNAL_OUTPUT_FIELDS,
	JournalChild,
	JournalClock,
	JournalReadError,
	JournalScanResult,
	ScanJournalOptions,
	scanJournal,
} from "../modules/device-logs/reader.ts";

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
	readonly eventId?: string;
};
interface ExpectedChild {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly signalCode: number | NodeJS.Signals | null;
	readonly pid?: number;
	readonly exitCode?: number | null;
	readonly killed?: boolean;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}
interface ExpectedClock {
	now(): number;
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(timer: number): void;
}
interface ExpectedLimits {
	readonly deadlineMs: 2000;
	readonly records: 4096;
	readonly stdoutBytes: number;
	readonly recordBytes: number;
	readonly stderrBytes: number;
}
interface ExpectedResult {
	readonly status: "eof" | "stopped" | "budget";
	readonly exitCode: number | null;
	readonly skippedRecords: number;
}
interface ExpectedOptions {
	readonly options: string[];
	readonly matches: string[];
	readonly signal?: AbortSignal;
	readonly acceptConcurrentCleanExit?: true;
	readonly limits?: Partial<Record<keyof ExpectedLimits, number>>;
	readonly onRecord: (record: ExpectedRaw) => "continue" | "stop";
	readonly spawn?: (argv: string[]) => ExpectedChild;
	readonly clock?: ExpectedClock;
}
interface ExpectedFollow {
	readonly exited: Promise<number>;
	abort(): void;
}
type ExpectedMockScan = (
	input: Omit<ExpectedOptions, "spawn">,
) => Promise<ExpectedResult>;
type ExpectedMockFollow = (
	input: Pick<ExpectedOptions, "options" | "matches" | "signal" | "onRecord">,
) => ExpectedFollow;

// These assertions are checked by the strict test project, not erased-test execution.
export type DeviceJournalPublicContracts = [
	Assert<Equal<RawJournalRecord, ExpectedRaw>>,
	Assert<Equal<typeof parseRecord, (input: unknown) => ExpectedRaw | null>>,
	Assert<Equal<typeof toLogEntry, (record: ExpectedRaw) => LogEntry>>,
	Assert<Equal<JournalChild, ExpectedChild>>,
	Assert<Equal<JournalClock, ExpectedClock>>,
	Assert<Equal<ScanJournalOptions, ExpectedOptions>>,
	Assert<Equal<JournalScanResult, ExpectedResult>>,
	Assert<
		Equal<
			typeof scanJournal,
			(input: ExpectedOptions) => Promise<ExpectedResult>
		>
	>,
	Assert<Equal<typeof JOURNAL_LIMITS, ExpectedLimits>>,
	Assert<
		Equal<
			typeof JOURNAL_OUTPUT_FIELDS,
			"MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_BOOT_ID,_TRANSPORT,MESSAGE_ID,UNIT,_PID"
		>
	>,
	Assert<
		Equal<
			ConstructorParameters<typeof JournalReadError>,
			[
				code: "JOURNAL_UNAVAILABLE" | "RECORD_TOO_LARGE" | "READ_FAILED",
				stderr?: string | undefined,
				options?: ErrorOptions | undefined,
			]
		>
	>,
	Assert<
		Equal<
			Pick<JournalReadError, "code" | "stderr">,
			{
				readonly code:
					| "JOURNAL_UNAVAILABLE"
					| "RECORD_TOO_LARGE"
					| "READ_FAILED";
				stderr: string;
			}
		>
	>,
	Assert<Equal<MockFollowHandle, ExpectedFollow>>,
	Assert<Equal<typeof scanMockJournal, ExpectedMockScan>>,
	Assert<Equal<typeof followMockJournal, ExpectedMockFollow>>,
	Assert<
		Equal<
			"spawn" extends keyof Parameters<typeof scanMockJournal>[0]
				? true
				: false,
			false
		>
	>,
	Assert<
		Equal<
			typeof mockJournal,
			{
				readonly scan: ExpectedMockScan;
				readonly follow: ExpectedMockFollow;
			}
		>
	>,
];
