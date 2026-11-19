import type { LogFilter, LogQueryInput } from "@ceraui/rpc/schemas";
import { JOURNAL_SOURCE_UNITS } from "./catalog.ts";
import type { RawJournalRecord } from "./parse.ts";

/** Shared by paging and follow; journal traversal order is independent of time. */
export function matchesResidual(
	record: RawJournalRecord,
	filter: LogFilter & Pick<LogQueryInput, "since" | "until">,
): boolean {
	if (filter.since !== undefined && record.ts < filter.since) return false;
	if (filter.until !== undefined && record.ts > filter.until) return false;
	if (
		filter.text !== undefined &&
		!record.message.toLowerCase().includes(filter.text.toLowerCase())
	)
		return false;
	const sources = filter.sources ?? [];
	if (sources.length === 0) return true;
	// A shared ceralive.service match is only a candidate for either source.
	if (record.marker !== "suppressed")
		return record.source !== null && sources.includes(record.source);
	return sources.some((source) =>
		JOURNAL_SOURCE_UNITS[source].some((unit) => record.message.includes(unit)),
	);
}
