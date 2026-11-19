import { z } from "zod";
import {
	getLogRingOffset,
	getRecentLogLines,
	LOG_RING_CAPACITY,
	onLogLine,
} from "../../helpers/logger.ts";
import { currentBootId } from "./boot-id.ts";
import { parseRecord, type RawJournalRecord } from "./parse.ts";
import {
	JournalReadError,
	type ScanJournalOptions,
	scanJournal,
} from "./reader.ts";

const loggerRecord = z.object({ ts: z.string(), level: z.string() });
const ringIncarnation = crypto.randomUUID();
const PRIORITIES: Readonly<Record<string, string>> = {
	error: "3",
	warn: "4",
	info: "6",
	debug: "7",
};
function fields(line: string, seq: number, bootId: string | undefined) {
	const data = loggerRecord.parse(JSON.parse(line));
	return {
		__CURSOR: `mock=${seq}`,
		__REALTIME_TIMESTAMP: String(Date.parse(data.ts) * 1000),
		_BOOT_ID: bootId,
		_SYSTEMD_UNIT: "ceralive.service",
		PRIORITY: PRIORITIES[data.level] ?? "7",
		MESSAGE: line,
	};
}
type MockFields = ReturnType<typeof fields>;

/** The compiler's repeated fields are OR; different fields are AND; "+" joins groups. */
function matches(record: MockFields, tokens: string[]): boolean {
	const groups: Map<string, string[]>[] = [new Map()];
	for (const token of tokens) {
		if (token === "+") {
			groups.push(new Map());
			continue;
		}
		const split = token.indexOf("=");
		const key = token.slice(0, split);
		const values = groups.at(-1);
		if (!values) continue;
		values.set(key, [...(values.get(key) ?? []), token.slice(split + 1)]);
	}
	return groups.some((group) =>
		[...group].every(([key, values]) =>
			Object.entries(record).some(
				([field, value]) => field === key && values.includes(String(value)),
			),
		),
	);
}
function snapshot(options: string[], bootId: string | undefined): MockFields[] {
	const offset = getLogRingOffset();
	const records = getRecentLogLines().map((line, index) =>
		fields(line, offset + index, bootId),
	);
	if (options.includes("-r")) records.reverse();
	const position = options.find(
		(option) =>
			option.startsWith("--cursor=") || option.startsWith("--after-cursor="),
	);
	if (!position) return records;
	const cursor = position.slice(position.indexOf("=") + 1);
	const index = records.findIndex((record) => record.__CURSOR === cursor);
	return index < 0
		? []
		: records.slice(index + (position.startsWith("--after-cursor=") ? 1 : 0));
}

export function scanMockJournal(input: Omit<ScanJournalOptions, "spawn">) {
	const exit = Promise.withResolvers<number>();
	const records = snapshot(input.options, currentBootId()).filter((record) =>
		matches(record, input.matches),
	);
	let index = 0;
	let closed = false;
	let signalCode: NodeJS.Signals | null = null;
	const stdout = new ReadableStream<Uint8Array>({
		pull(controller) {
			const record = records[index++];
			if (record)
				controller.enqueue(
					new TextEncoder().encode(`${JSON.stringify(record)}\n`),
				);
			else {
				closed = true;
				controller.close();
				exit.resolve(0);
			}
		},
		cancel() {
			closed = true;
		},
	});
	return scanJournal({
		...input,
		spawn: () => ({
			stdout,
			stderr: new ReadableStream({ start: (controller) => controller.close() }),
			exited: exit.promise,
			get signalCode() {
				return signalCode;
			},
			kill() {
				if (!closed) {
					closed = true;
					signalCode = "SIGTERM";
					exit.resolve(143);
				}
			},
		}),
	});
}

export interface MockFollowHandle {
	readonly exited: Promise<number>;
	abort(): void;
}

export function mockJournalRetentionBoundary(): string {
	return `${ringIncarnation}:${getLogRingOffset()}`;
}
export function followMockJournal(
	input: Pick<
		ScanJournalOptions,
		"options" | "matches" | "signal" | "onRecord"
	>,
): MockFollowHandle {
	const exit = Promise.withResolvers<number>();
	const bootId = currentBootId();
	let done = false;
	let draining = true;
	let unsubscribe: (() => void) | undefined;
	const queue: RawJournalRecord[] = [];
	const abort = () => {
		if (done) return;
		done = true;
		unsubscribe?.();
		queue.length = 0;
		input.signal?.removeEventListener("abort", abort);
		exit.resolve(0);
	};
	const drain = () => {
		if (draining) return;
		draining = true;
		try {
			while (!done && queue.length) {
				const record = queue.shift();
				if (record && input.onRecord(record) === "stop") abort();
			}
		} finally {
			draining = false;
		}
	};
	const deliver = (raw: MockFields) => {
		if (done || !matches(raw, input.matches)) return;
		const record = parseRecord(raw);
		if (!record) return;
		if (queue.length >= LOG_RING_CAPACITY)
			throw new JournalReadError("READ_FAILED");
		queue.push(record);
		drain();
	};
	const fail = (error: unknown) => {
		exit.reject(error);
		abort();
	};
	if (!input.signal?.aborted) {
		unsubscribe = onLogLine((line, seq) => {
			try {
				deliver(fields(line, seq, bootId));
			} catch (error) {
				fail(error);
			}
		});
		input.signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const raw of snapshot(input.options, bootId)) deliver(raw);
			draining = false;
			drain();
		} catch (error) {
			fail(error);
		}
	} else abort();
	return { exited: exit.promise, abort };
}

export const mockJournal = {
	scan: scanMockJournal,
	follow: followMockJournal,
} as const;
