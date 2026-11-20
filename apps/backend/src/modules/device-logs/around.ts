import {
	type LogAroundInput,
	type LogAroundOutput,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { bindQuery, encodePosition } from "./continuation.ts";
import { compileFilter } from "./filter.ts";
import { scanMockJournal } from "./mock-journal.ts";
import { type RawJournalRecord, toLogEntry } from "./parse.ts";
import { scanJournal } from "./reader.ts";
import { realtimeSeekOptions, scanPage } from "./scan-page.ts";

const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export async function locatePagesAround(
	input: LogAroundInput,
	scope: { readonly signal: AbortSignal; readonly epoch: number },
): Promise<LogAroundOutput> {
	const found: { record: RawJournalRecord | null } = { record: null };
	if (input.eventId !== undefined) {
		const since = Math.max(0, input.at - 5000);
		const until = Math.min(MAX_TIMESTAMP, input.at + 5000);
		const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
		const scanForEvent = (options: string[]) =>
			scan({
				options,
				matches: compileFilter({ sources: ["app"] }, { bootId: input.bootId })
					.matches,
				signal: scope.signal,
				acceptConcurrentCleanExit: true,
				onRecord(record) {
					if (
						record.source !== "app" ||
						record.eventId !== input.eventId ||
						record.ts < since ||
						record.ts > until
					)
						return "continue";
					found.record = record;
					return "stop";
				},
			});
		await scanForEvent(realtimeSeekOptions(since, until));
		// Native time pruning can hide entries after a clock step.
		if (found.record === null && !scope.signal.aborted)
			await scanForEvent(["-r"]);
	}
	const anchor = found.record;
	const olderQuery = logQueryInputSchema.parse({
		boot: input.bootId,
		direction: "older",
		limit: 50,
		...(anchor
			? {}
			: {
					...(input.at === 0 ? {} : { since: Math.max(0, input.at - 60000) }),
					until: input.at,
				}),
	});
	const newerSince = Math.min(MAX_TIMESTAMP, input.at + 1);
	const newerQuery = logQueryInputSchema.parse({
		boot: input.bootId,
		direction: "newer",
		limit: 50,
		...(anchor
			? {}
			: {
					since: newerSince,
					...(newerSince < MAX_TIMESTAMP
						? { until: Math.min(MAX_TIMESTAMP, input.at + 60000) }
						: {}),
				}),
	});
	const pageScope = {
		...scope,
		bootId: input.bootId,
		acceptConcurrentCleanExit: true as const,
	};
	// Internal anchor tokens use exactly the same binding as ordinary continuation.
	const positionAt = (query: typeof olderQuery, cursor: string) =>
		encodePosition(cursor, bindQuery(query, input.bootId, scope.epoch));
	const readPage = async (query: typeof olderQuery) => {
		if (anchor)
			return scanPage(
				{ ...query, continuation: positionAt(query, anchor.cursor) },
				pageScope,
			);
		// A reverse seek at the maximum cannot skip any records at the boot edge.
		if (query.direction === "older" && query.until === MAX_TIMESTAMP)
			return scanPage(query, pageScope);
		const hinted = await scanPage(query, pageScope, [
			query.since ?? 0,
			query.until ?? MAX_TIMESTAMP,
		]);
		if (!hinted.ok || hinted.termination === "lookahead") return hinted;
		// A native cutoff may hide in-range rows across a clock step.
		const full = await scanPage(query, pageScope);
		if (!full.ok || full.termination !== "budget") return full;
		const last = hinted.entries.at(-1);
		// Keep verified nearby rows when the unpruned scan cannot prove the page.
		return last === undefined
			? full
			: {
					...hinted,
					hasMore: null,
					termination: "budget" as const,
					continuation: positionAt(query, last.cursor),
				};
	};
	const older = await readPage(olderQuery);
	if (!older.ok) return older;
	// No admitted timestamp can follow the maximum; an equal-ended range is invalid.
	const newer =
		!anchor && input.at === MAX_TIMESTAMP
			? {
					...older,
					entries: [],
					hasMore: false,
					termination: "end" as const,
					continuation: null,
				}
			: await readPage(newerQuery);
	if (!newer.ok) return newer;
	return {
		ok: true,
		anchor: anchor ? toLogEntry(anchor) : null,
		approximate: anchor === null,
		older,
		newer,
		olderQuery,
		newerQuery,
	};
}
