import {
	LOG_FOLLOW_BOOT_START_PREFIX,
	type LogQueryOutput,
} from "@ceraui/rpc/schemas";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	bindQuery,
	decodePosition,
	encodePosition,
	type ParsedQuery,
} from "./continuation.ts";
import { compileFilter } from "./filter.ts";
import { resolveFollowPosition } from "./follow-position.ts";
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
			? { cursor: null, gap: undefined }
			: decodePosition(query.continuation, binding);
	if ("error" in position) return { ok: false, error: position.error };
	const scan = shouldUseMocks() ? scanMockJournal : scanJournal;
	const { gap, cursor: start } = position;
	const bootStart =
		gap?.start && start?.startsWith(LOG_FOLLOW_BOOT_START_PREFIX);
	const { matches } = compileFilter(query, { bootId: scope.bootId });
	if (
		gap !== undefined &&
		scope.bootId !== null &&
		(await resolveFollowPosition(
			scan,
			{ ...scope, bootId: scope.bootId, matches },
			gap.through,
		)) !== gap.through
	)
		return { ok: false, error: "CURSOR_UNAVAILABLE" };
	// Follow can resume from a checkpoint that the native query filter excludes.
	if (
		gap?.start &&
		!bootStart &&
		start !== null &&
		scope.bootId !== null &&
		(await resolveFollowPosition(
			scan,
			{ ...scope, bootId: scope.bootId },
			start,
		)) !== start
	)
		return { ok: false, error: "CURSOR_UNAVAILABLE" };
	const options = query.direction === "older" ? ["-r"] : [];
	if (start !== null && !bootStart) options.push(`--cursor=${start}`);
	let reachedGapEnd = false;
	let window: PageWindow = {
		entries: [],
		examined: null,
		awaitingAnchor: gap?.start ? null : start,
		invalid: false,
		lookahead: false,
	};
	const result = await scan({
		options,
		matches,
		signal: scope.signal,
		onRecord(record) {
			if (gap?.start && record.cursor === start && start !== gap.through)
				return "continue";
			if (gap?.start && start === gap.through) {
				reachedGapEnd = true;
				return "stop";
			}
			window = advancePage(window, record, query);
			reachedGapEnd = !window.lookahead && record.cursor === gap?.through;
			return window.invalid || window.lookahead || reachedGapEnd
				? "stop"
				: "continue";
		},
	});
	if (
		window.invalid ||
		(result.status === "eof" &&
			(window.awaitingAnchor !== null || (gap !== undefined && !reachedGapEnd)))
	)
		return { ok: false, error: "CURSOR_UNAVAILABLE" };
	if (scope.signal.aborted) throw new JournalReadError("READ_FAILED");
	const termination = window.lookahead
		? "lookahead"
		: result.status === "eof" || reachedGapEnd
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
					? encodePosition(
							cursor,
							binding,
							gap === undefined ? undefined : { through: gap.through },
						)
					: (query.continuation ?? null),
		historyEpoch: scope.epoch,
		bootId: scope.bootId,
	};
}
