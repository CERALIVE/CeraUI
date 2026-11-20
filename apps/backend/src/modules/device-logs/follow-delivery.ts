import type { LogFilter } from "@ceraui/rpc/schemas";
import {
	appendFollowRecord,
	emptyFollowBatch,
	type FollowBatch,
	followFlushDelay,
} from "./follow-batch.ts";
import type { RawJournalRecord } from "./parse.ts";
import type { JournalClock } from "./reader.ts";
import { matchesResidual } from "./residual.ts";

/** One follower generation owns one pending batch and at most one flush timer. */
export function createFollowDelivery(options: {
	readonly cursor: string | null;
	readonly filter: LogFilter;
	readonly clock: Pick<JournalClock, "setTimeout" | "clearTimeout">;
	readonly signal: AbortSignal;
	readonly send: (batch: FollowBatch) => void;
	readonly abort: () => void;
}): {
	readonly onRecord: (record: RawJournalRecord) => "continue" | "stop";
	readonly cancel: () => void;
	readonly batch: FollowBatch;
	readonly restart: boolean;
} {
	let batch = emptyFollowBatch(options.cursor);
	let first = true;
	let examined = 0;
	let flushed = false;
	let restart = false;
	let timer: { readonly id: number; readonly delay: number } | undefined;
	const cancel = () => {
		if (timer !== undefined) options.clock.clearTimeout(timer.id);
		timer = undefined;
	};
	const flush = () => {
		cancel();
		options.send(batch);
		batch = emptyFollowBatch(batch.checkpointCursor);
		flushed = true;
	};
	const onRecord = (record: RawJournalRecord): "continue" | "stop" => {
		if (options.signal.aborted) return "stop";
		const anchor = first && record.cursor === options.cursor;
		first = false;
		if (anchor) return "continue";
		if (!flushed && ++examined > 2000) {
			restart = true;
			options.abort();
			return "stop";
		}
		batch = appendFollowRecord(
			batch,
			record,
			matchesResidual(record, options.filter),
		);
		if (batch.entries.length) {
			const delay = followFlushDelay(batch);
			if (timer === undefined || (delay === 0 && timer.delay !== 0)) {
				cancel();
				timer = { id: options.clock.setTimeout(flush, delay), delay };
			}
		}
		return "continue";
	};
	return {
		onRecord,
		cancel,
		get batch() {
			return batch;
		},
		get restart() {
			return restart;
		},
	};
}
