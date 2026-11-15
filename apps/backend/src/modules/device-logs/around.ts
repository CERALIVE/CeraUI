import {
	type LogAroundInput,
	type LogAroundOutput,
	type LogQueryInput,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { bindQuery, encodePosition } from "./continuation.ts";
import { compileFilter } from "./filter.ts";
import { scanMockJournal } from "./mock-journal.ts";
import { type RawJournalRecord, toLogEntry } from "./parse.ts";
import { scanJournal } from "./reader.ts";
import { matchesResidual } from "./residual.ts";
import { scanPage } from "./scan-page.ts";

const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export async function locatePagesAround(
	input: LogAroundInput,
	scope: { readonly signal: AbortSignal; readonly epoch: number },
): Promise<LogAroundOutput> {
	const found: { record: RawJournalRecord | null } = { record: null };
	if (input.eventId !== undefined) {
		const filter = {
			sources: ["app"],
			text: input.eventId,
			since: Math.max(0, input.at - 5000),
			until: Math.min(MAX_TIMESTAMP, input.at + 5000),
		} satisfies LogQueryInput;
		const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
		await scan({
			options: [
				`--since=@${Math.floor(Math.max(0, input.at - 5000) / 1000)}`,
				`--until=@${Math.ceil(filter.until / 1000)}`,
			],
			matches: compileFilter(filter, { bootId: input.bootId }).matches,
			signal: scope.signal,
			onRecord(record) {
				if (!matchesResidual(record, filter)) return "continue";
				found.record = record;
				return "stop";
			},
		});
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
	const pageScope = { ...scope, bootId: input.bootId };
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
