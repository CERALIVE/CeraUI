import type { LogEntry } from "@ceraui/rpc/schemas";
import type { ParsedQuery } from "./continuation.ts";
import { type RawJournalRecord, toLogEntry } from "./parse.ts";
import { matchesResidual } from "./residual.ts";

export interface PageWindow {
	readonly entries: LogEntry[];
	readonly examined: string | null;
	readonly awaitingAnchor: string | null;
	readonly invalid: boolean;
	readonly lookahead: boolean;
}

/** Pure transition: an inclusive position must be observed before residuals. */
export function advancePage(
	state: PageWindow,
	record: RawJournalRecord,
	query: ParsedQuery,
	project: (record: RawJournalRecord) => LogEntry = toLogEntry,
): PageWindow {
	const next = { ...state, examined: record.cursor };
	if (state.awaitingAnchor !== null)
		return {
			...next,
			awaitingAnchor: null,
			invalid: record.cursor !== state.awaitingAnchor,
		};
	if (!matchesResidual(record, query)) return next;
	if (state.entries.length === query.limit) return { ...next, lookahead: true };
	return { ...next, entries: [...state.entries, project(record)] };
}
