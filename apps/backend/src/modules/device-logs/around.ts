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
import { scanPage } from "./scan-page.ts";

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
		// Round outwards for native microseconds; exact membership uses floored milliseconds.
		await scanForEvent([
			`--since=@${Math.floor(since / 1000)}`,
			`--until=@${Math.floor(until / 1000) + 1}`,
		]);
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
	const fromAnchor = (query: typeof olderQuery) =>
		anchor
			? {
					...query,
					continuation: encodePosition(
						anchor.cursor,
						bindQuery(query, input.bootId, scope.epoch),
					),
				}
			: query;
	const older = await scanPage(fromAnchor(olderQuery), pageScope);
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
			: await scanPage(fromAnchor(newerQuery), pageScope);
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
