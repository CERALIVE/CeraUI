import type { LogQueryOutput } from "@ceraui/rpc/schemas";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	bindQuery,
	decodePosition,
	encodePosition,
	type ParsedQuery,
} from "./continuation.ts";
import { compileFilter } from "./filter.ts";
import { scanMockJournal } from "./mock-journal.ts";
import { advancePage, type PageWindow } from "./page-window.ts";
import { JournalReadError, scanJournal } from "./reader.ts";

export async function scanPage(
	query: ParsedQuery,
	scope: {
		readonly bootId: string | null;
		readonly epoch: number;
		readonly signal: AbortSignal;
	},
): Promise<LogQueryOutput> {
	const binding = bindQuery(query, scope.bootId, scope.epoch);
	const position =
		query.continuation === undefined
			? { cursor: null }
			: decodePosition(query.continuation, binding);
	if ("error" in position) return { ok: false, error: position.error };
	const options = query.direction === "older" ? ["-r"] : [];
	if (position.cursor !== null) options.push(`--cursor=${position.cursor}`);
	let window: PageWindow = {
		entries: [],
		examined: null,
		awaitingAnchor: position.cursor,
		invalid: false,
		lookahead: false,
	};
	const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
	const result = await scan({
		options,
		matches: compileFilter(query, { bootId: scope.bootId }).matches,
		signal: scope.signal,
		onRecord(record) {
			window = advancePage(window, record, query);
			return window.invalid || window.lookahead ? "stop" : "continue";
		},
	});
	if (
		window.invalid ||
		(result.status === "eof" && window.awaitingAnchor !== null)
	)
		return { ok: false, error: "CURSOR_UNAVAILABLE" };
	if (scope.signal.aborted) throw new JournalReadError("READ_FAILED");
	const termination = window.lookahead
		? "lookahead"
		: result.status === "eof"
			? "end"
			: "budget";
	const cursor = window.lookahead
		? window.entries.at(-1)?.cursor
		: window.examined;
	return {
		ok: true,
		entries: window.entries,
		hasMore:
			termination === "lookahead" ? true : termination === "end" ? false : null,
		termination,
		continuation:
			termination === "end"
				? null
				: cursor
					? encodePosition(cursor, binding)
					: (query.continuation ?? null),
		historyEpoch: scope.epoch,
		bootId: scope.bootId,
	};
}
