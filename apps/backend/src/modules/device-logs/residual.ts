import type { LogFilter, LogQueryInput } from "@ceraui/rpc/schemas";
import { SOURCE_UNITS } from "./catalog.ts";
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
	return (
		record.marker !== "suppressed" ||
		sources.length === 0 ||
		sources.some((source) =>
			SOURCE_UNITS[source].some((unit) => record.message.includes(unit)),
		)
	);
}
