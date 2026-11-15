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

/** Long-lived output has a per-record bound, never a growing stdout/stderr buffer. */
export async function readFollowOutput(
	proc: ManagedProcess,
	onRecord: (record: RawJournalRecord) => "continue" | "stop",
): Promise<void> {
	if (!proc.stdout || !proc.stderr) throw new JournalReadError("READ_FAILED");
	const stdout = proc.stdout.getReader();
	const stderr = proc.stderr.getReader();
	let pending = new Uint8Array(0);
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
		await Promise.all([
			(async () => {
				for (;;) {
					const chunk = await stdout.read();
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
	} finally {
		await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
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
	let grace: number | undefined;
	let retiring = false;
	const retire = () => {
		if (retiring) return;
		retiring = true;
		handle.abort();
		if (handle.proc.exitCode === null && handle.proc.signalCode === null)
			grace = options.clock.setTimeout(() => {
				if (handle.proc.exitCode === null && handle.proc.signalCode === null)
					handle.proc.kill("SIGKILL");
			}, 100);
	};
	options.signal.addEventListener("abort", retire);
	if (options.signal.aborted) retire();
	try {
		await Promise.all([
			readFollowOutput(handle.proc, options.onRecord),
			handle.proc.exited,
		]);
	} finally {
		retire();
		try {
			await handle.proc.exited;
		} finally {
			options.signal.removeEventListener("abort", retire);
			if (grace !== undefined) options.clock.clearTimeout(grace);
		}
	}
}
