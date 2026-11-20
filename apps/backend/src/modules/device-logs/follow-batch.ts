import type { LogFollowMessage } from "@ceraui/rpc/schemas";
import { type RawJournalRecord, toLogEntry } from "./parse.ts";

export type FollowBatch = Pick<
	LogFollowMessage,
	"entries" | "checkpointCursor" | "dropped" | "gap"
> & { readonly bytes: number };

export function emptyFollowBatch(checkpointCursor: string | null): FollowBatch {
	return { entries: [], checkpointCursor, dropped: 0, bytes: 0 };
}

/** Examined positions advance even when residuals reject or pressure drops a line. */
export function appendFollowRecord(
	batch: FollowBatch,
	record: RawJournalRecord,
	keep: boolean,
): FollowBatch {
	const next = { ...batch, checkpointCursor: record.cursor };
	if (!keep) return next;
	const entry = toLogEntry(record);
	const bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
	if (batch.entries.length >= 200 || batch.bytes + bytes > 256 * 1024)
		return { ...next, dropped: batch.dropped + 1 };
	return {
		...next,
		entries: [...batch.entries, entry],
		bytes: batch.bytes + bytes,
		...(record.marker === "suppressed" ? { gap: "suppressed" as const } : {}),
	};
}

export function followFlushDelay(batch: FollowBatch): number {
	return batch.entries.length >= 200 || batch.bytes >= 64 * 1024 ? 0 : 250;
}
