import { spyOn } from "bun:test";
import { clearTimeout, setTimeout } from "node:timers";

export type GroupProcessSnapshot = {
	readonly testName: string;
	readonly phase: string;
	readonly pendingDelaysMs: readonly number[];
	readonly pid: number | null;
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	readonly stdoutEof: boolean;
	readonly stderrEof: boolean;
	readonly ownerId: string | null;
	readonly ownerActive: boolean;
	readonly isDisruptiveActionPending: boolean;
};

export type SnapshotClock = (run: () => void) => () => void;

export function watchGroupProcess<T>(
	work: Promise<T>,
	read: () => GroupProcessSnapshot,
	schedule: SnapshotClock = (run) => {
		const timer = setTimeout(run, 12000);
		timer.unref();
		return () => clearTimeout(timer);
	},
): Promise<T> {
	const cancel = schedule(() => console.error(JSON.stringify(read())));
	void work.then(cancel, cancel);
	return work;
}

export function observePipeEof(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	let eof = false;
	const cancel = spyOn(reader, "cancel");
	void reader.closed.then(
		() => {
			eof = cancel.mock.calls.length === 0;
		},
		() => undefined,
	);
	const getReader = spyOn(stream, "getReader").mockReturnValue(reader);
	return {
		eof: () => eof,
		restore: () => {
			cancel.mockRestore();
			getReader.mockRestore();
		},
	};
}
