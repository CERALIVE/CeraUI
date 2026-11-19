import type {
	JournalChild,
	JournalClock,
	ScanJournalOptions,
} from "../../modules/device-logs/reader.ts";

export { bootId, journalLine, journalObject } from "./device-journal-record.ts";

export function fakeJournal(
	chunks: readonly (string | Uint8Array)[],
	{ code = 0, held = false, ignoreTerm = false, stderr = "" } = {},
) {
	const exit = Promise.withResolvers<number>();
	const signals: Array<string | number | undefined> = [];
	let out: ReadableStreamDefaultController<Uint8Array>;
	let err: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let signalCode: number | NodeJS.Signals | null = null;
	let outputClosed = false;
	let errorClosed = false;
	const encoder = new TextEncoder();
	const child: JournalChild = {
		stdout: new ReadableStream({
			start(controller) {
				out = controller;
				for (const chunk of chunks)
					controller.enqueue(
						typeof chunk === "string" ? encoder.encode(chunk) : chunk,
					);
			},
			cancel() {
				outputClosed = true;
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				err = controller;
				if (stderr) controller.enqueue(encoder.encode(stderr));
			},
			cancel() {
				errorClosed = true;
			},
		}),
		exited: exit.promise,
		get signalCode() {
			return signalCode;
		},
		kill(signal) {
			signals.push(signal);
			if (signal === "SIGTERM" && ignoreTerm) return;
			finish(signal === "SIGKILL" ? 137 : 143, signal);
		},
	};
	function finish(
		result = code,
		signal: number | NodeJS.Signals | null = null,
	) {
		if (closed) return;
		closed = true;
		signalCode = signal;
		endOutput();
		if (!errorClosed) {
			errorClosed = true;
			err.close();
		}
		exit.resolve(result);
	}
	function endOutput() {
		if (!outputClosed) {
			outputClosed = true;
			out.close();
		}
	}
	if (!held) finish();
	return { child, signals, finish, endOutput };
}

export function manualClock() {
	let now = 0;
	let id = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const clock: JournalClock = {
		now: () => now,
		setTimeout(callback, delay) {
			const key = ++id;
			timers.set(key, { at: now + delay, callback });
			return key;
		},
		clearTimeout(key) {
			timers.delete(key);
		},
	};
	return {
		clock,
		timers,
		advance(ms: number) {
			now += ms;
			for (const [key, timer] of timers)
				if (timer.at <= now) {
					timers.delete(key);
					timer.callback();
				}
		},
	};
}

export const scanInput = {
	options: [],
	matches: [],
	onRecord: () => "continue",
} satisfies ScanJournalOptions;
