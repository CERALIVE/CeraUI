import type {
	ManagedProcess,
	WatcherHandle,
} from "../../helpers/spawn-policy.ts";
import { parseRecord, type RawJournalRecord } from "./parse.ts";
import {
	JOURNAL_LIMITS,
	type JournalClock,
	JournalReadError,
} from "./reader.ts";
import { journalRetirement } from "./termination.ts";

/** Long-lived output has a per-record bound, never a growing stdout/stderr buffer. */
export async function readFollowOutput(
	proc: ManagedProcess,
	onRecord: (record: RawJournalRecord) => "continue" | "stop",
	signal?: AbortSignal,
): Promise<void> {
	if (!proc.stdout || !proc.stderr) throw new JournalReadError("READ_FAILED");
	const stdout = proc.stdout.getReader();
	const stderr = proc.stderr.getReader();
	let pending = new Uint8Array(0);
	const stopped = Promise.withResolvers<void>();
	const stop = () => stopped.resolve();
	signal?.addEventListener("abort", stop, { once: true });
	const decode = new TextDecoder("utf-8", { fatal: true });
	const line = (bytes: Uint8Array) => {
		let value: unknown;
		try {
			value = JSON.parse(decode.decode(bytes));
		} catch (error) {
			if (!(error instanceof SyntaxError || error instanceof TypeError))
				throw error;
			throw new JournalReadError("READ_FAILED");
		}
		const record = parseRecord(value);
		return record === null || onRecord(record) !== "stop";
	};
	try {
		signal?.throwIfAborted();
		const output = Promise.all([
			(async () => {
				for (;;) {
					const chunk = await stdout.read();
					if (signal?.aborted) return;
					if (chunk.done) {
						if (pending.byteLength) line(pending);
						return;
					}
					let from = 0;
					for (
						let i = chunk.value.indexOf(10);
						i >= 0;
						i = chunk.value.indexOf(10, i + 1)
					) {
						if (pending.byteLength + i - from > JOURNAL_LIMITS.recordBytes)
							throw new JournalReadError("RECORD_TOO_LARGE");
						const bytes = new Uint8Array(pending.byteLength + i - from);
						bytes.set(pending);
						bytes.set(chunk.value.subarray(from, i), pending.byteLength);
						if (!line(bytes)) return;
						pending = new Uint8Array(0);
						from = i + 1;
					}
					const tail = chunk.value.subarray(from);
					if (pending.byteLength + tail.byteLength > JOURNAL_LIMITS.recordBytes)
						throw new JournalReadError("RECORD_TOO_LARGE");
					const next = new Uint8Array(pending.byteLength + tail.byteLength);
					next.set(pending);
					next.set(tail, pending.byteLength);
					pending = next;
				}
			})(),
			(async () => {
				while (!(await stderr.read()).done) {
					// Drain and discard; a chatty follower cannot retain stderr in memory.
				}
			})(),
		]);
		await Promise.race([output, stopped.promise]);
	} finally {
		signal?.removeEventListener("abort", stop);
		void Promise.allSettled([stdout.cancel(), stderr.cancel()]);
		stdout.releaseLock();
		stderr.releaseLock();
	}
}

/** A socket stop owns TERM, a short escalation, pipe drainage and reaping. */
export async function joinFollowProcess(
	handle: WatcherHandle,
	options: {
		readonly signal: AbortSignal;
		readonly clock: Pick<JournalClock, "setTimeout" | "clearTimeout">;
		readonly onRecord: (record: RawJournalRecord) => "continue" | "stop";
	},
): Promise<void> {
	const retirement = journalRetirement(handle.proc, options.clock);
	const pipes = new AbortController();
	const retire = () => {
		retirement.stop();
		pipes.abort();
	};
	const output = readFollowOutput(handle.proc, options.onRecord, pipes.signal);
	let drain: number | undefined;
	const exited = handle.proc.exited.then(() => {
		if (!pipes.signal.aborted)
			drain = options.clock.setTimeout(() => pipes.abort(), 100);
	});
	options.signal.addEventListener("abort", retire);
	if (options.signal.aborted) retire();
	try {
		await Promise.all([output, exited]);
	} finally {
		retire();
		try {
			await exited;
		} finally {
			options.signal.removeEventListener("abort", retire);
			retirement.disarm();
			if (drain !== undefined) options.clock.clearTimeout(drain);
		}
	}
	if (retirement.failure) throw retirement.failure;
}
