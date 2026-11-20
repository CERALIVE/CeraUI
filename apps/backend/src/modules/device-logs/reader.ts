import { scanBudget } from "./bounds.ts";
import { parseRecord, type RawJournalRecord } from "./parse.ts";
import { classifyTermination, journalRetirement } from "./termination.ts";

export const JOURNAL_LIMITS = {
	deadlineMs: 2000,
	records: 4096,
	stdoutBytes: 8 * 1024 * 1024,
	recordBytes: 1024 * 1024,
	stderrBytes: 64 * 1024,
} as const;
export const JOURNAL_OUTPUT_FIELDS =
	"MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_BOOT_ID,_TRANSPORT,MESSAGE_ID,UNIT,_PID";
type ReadCode = "JOURNAL_UNAVAILABLE" | "RECORD_TOO_LARGE" | "READ_FAILED";
export class JournalReadError extends Error {
	constructor(
		public readonly code: ReadCode,
		public stderr = "",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "JournalReadError";
	}
}
export interface JournalChild {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly signalCode: number | NodeJS.Signals | null;
	readonly pid?: number;
	readonly exitCode?: number | null;
	readonly killed?: boolean;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}
export interface JournalClock {
	now(): number;
	setTimeout(callback: () => void, delay: number): number;
	clearTimeout(timer: number): void;
}
export interface ScanJournalOptions {
	readonly options: string[];
	readonly matches: string[];
	readonly signal?: AbortSignal;
	readonly acceptConcurrentCleanExit?: true;
	readonly limits?: Partial<Record<keyof typeof JOURNAL_LIMITS, number>>;
	readonly onRecord: (record: RawJournalRecord) => "continue" | "stop";
	readonly spawn?: (argv: string[]) => JournalChild;
	readonly clock?: JournalClock;
}
export interface JournalScanResult {
	readonly status: "eof" | "stopped" | "budget";
	readonly exitCode: number | null;
	readonly skippedRecords: number;
}
const clock: JournalClock = {
	now: () => performance.now(),
	setTimeout: (callback, delay) => Number(setTimeout(callback, delay)),
	clearTimeout: (timer) => clearTimeout(timer),
};

/** Options and matches are internal compiler output, never client argv. */
export async function scanJournal(
	input: ScanJournalOptions,
): Promise<JournalScanResult> {
	if (input.signal?.aborted)
		return { status: "stopped", exitCode: null, skippedRecords: 0 };
	const limits = { ...JOURNAL_LIMITS, ...input.limits };
	const time = input.clock ?? clock;
	const budget = scanBudget(limits, time);
	let child: JournalChild;
	try {
		const argv = [
			"journalctl",
			"-o",
			"json",
			"--all",
			`--output-fields=${JOURNAL_OUTPUT_FIELDS}`,
			...input.options,
			"--",
			...input.matches,
		];
		child = input.spawn
			? input.spawn(argv)
			: Bun.spawn(argv, {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				});
	} catch (error) {
		throw new JournalReadError(
			error instanceof Error && "code" in error && error.code === "ENOENT"
				? "JOURNAL_UNAVAILABLE"
				: "READ_FAILED",
		);
	}
	const stdout = child.stdout.getReader();
	const stderr = child.stderr.getReader();
	const retirement = journalRetirement(child, time);
	let exitCode: number | null = null;
	const exited = child.exited.then((code): number => {
		exitCode = code;
		return code;
	});
	const stop = Promise.withResolvers<"stopped" | "budget">();
	let interrupted: "stopped" | "budget" | undefined;
	const interrupt = (reason: "stopped" | "budget") => {
		interrupted ??= reason;
		stop.resolve(interrupted);
	};
	const onAbort = () => interrupt("stopped");
	const deadline = time.setTimeout(() => interrupt("budget"), budget.delay());
	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) onAbort();
	let skippedRecords = 0;
	let pending = new Uint8Array(0);
	let captured = new Uint8Array(0);
	let collecting = true;
	const decode = new TextDecoder("utf-8", { fatal: true });
	const line = (bytes: Uint8Array): boolean => {
		if (interrupted) return false;
		if (budget.exhausted()) {
			interrupt("budget");
			return false;
		}
		if (bytes.byteLength > limits.recordBytes)
			throw new JournalReadError("RECORD_TOO_LARGE");
		budget.take();
		let obj: unknown;
		try {
			obj = JSON.parse(decode.decode(bytes));
		} catch (error) {
			if (!(error instanceof SyntaxError || error instanceof TypeError))
				throw error;
			throw new JournalReadError("READ_FAILED");
		}
		const record = parseRecord(obj);
		if (!record) {
			skippedRecords++;
			return true;
		}
		if (input.onRecord(record) === "stop") {
			interrupt("stopped");
			return false;
		}
		return true;
	};
	const readStdout = async () => {
		while (collecting) {
			let chunk: Awaited<ReturnType<typeof stdout.read>>;
			try {
				chunk = await stdout.read();
			} catch {
				throw new JournalReadError("READ_FAILED");
			}
			if (!collecting) return;
			if (chunk.done) {
				if (pending.byteLength > 0) line(pending);
				return;
			}
			if (budget.overStdout(chunk.value.byteLength)) {
				interrupt("budget");
				return;
			}
			let from = 0;
			for (let i = 0; i < chunk.value.byteLength; i++) {
				if (chunk.value[i] !== 10) continue;
				if (pending.byteLength + i - from > limits.recordBytes)
					throw new JournalReadError("RECORD_TOO_LARGE");
				const bytes = new Uint8Array(pending.byteLength + i - from);
				bytes.set(pending);
				bytes.set(chunk.value.subarray(from, i), pending.byteLength);
				if (!line(bytes)) return;
				pending = new Uint8Array(0);
				from = i + 1;
			}
			const tail = chunk.value.subarray(from);
			if (pending.byteLength + tail.byteLength > limits.recordBytes)
				throw new JournalReadError("RECORD_TOO_LARGE");
			const next = new Uint8Array(pending.byteLength + tail.byteLength);
			next.set(pending);
			next.set(tail, pending.byteLength);
			pending = next;
		}
	};
	const readStderr = async () => {
		while (collecting) {
			let chunk: Awaited<ReturnType<typeof stderr.read>>;
			try {
				chunk = await stderr.read();
			} catch {
				throw new JournalReadError("READ_FAILED");
			}
			if (chunk.done || !collecting) return;
			const bytes = chunk.value.subarray(
				0,
				Math.max(0, limits.stderrBytes - captured.byteLength),
			);
			const next = new Uint8Array(captured.byteLength + bytes.byteLength);
			next.set(captured);
			next.set(bytes, captured.byteLength);
			captured = next;
		}
	};
	const output = Promise.all([readStdout(), readStderr(), exited]);
	let status: JournalScanResult["status"] | undefined;
	try {
		status = await Promise.race([
			stop.promise,
			output.then(() => "eof" as const),
		]);
	} catch (error) {
		if (error instanceof JournalReadError)
			error.stderr = new TextDecoder().decode(captured);
		throw error;
	} finally {
		time.clearTimeout(deadline);
		input.signal?.removeEventListener("abort", onAbort);
		collecting = false;
		if (exitCode === null) retirement.stop();
		try {
			// Let pipe continuations already queued by termination observe collecting=false.
			await Promise.resolve();
			void Promise.allSettled([stdout.cancel(), stderr.cancel()]);
			stdout.releaseLock();
			stderr.releaseLock();
			await exited;
		} finally {
			retirement.disarm();
		}
	}
	const signalCode = child.signalCode;
	const signals = retirement.signals;
	const cleanConcurrentExit =
		input.acceptConcurrentCleanExit === true &&
		exitCode === 0 &&
		signalCode === null;
	const termination = classifyTermination(exitCode, signalCode, {
		status,
		...signals,
		// Physical EOF still requires both pipes; a concurrent exit owns no signal.
		diedBeforeOurSignal: signals.diedBeforeOurSignal && !cleanConcurrentExit,
	});
	if (retirement.failure || termination === "READ_FAILED")
		throw new JournalReadError(
			"READ_FAILED",
			new TextDecoder().decode(captured),
			{ cause: retirement.failure },
		);
	return { status: termination, exitCode, skippedRecords };
}
