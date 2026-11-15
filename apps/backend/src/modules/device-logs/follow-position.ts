import { JournalReadError, type scanJournal } from "./reader.ts";

/** Probe the boot alone: the resume record need not match the viewer's filter. */
export async function resolveFollowPosition(
	scan: typeof scanJournal,
	scope: { readonly bootId: string; readonly signal: AbortSignal },
	cursor?: string,
): Promise<string | null> {
	let found: string | null = null;
	const result = await scan({
		options: cursor === undefined ? ["-r"] : [`--cursor=${cursor}`],
		matches: [`_BOOT_ID=${scope.bootId}`],
		signal: scope.signal,
		onRecord: (record) => {
			found = record.cursor;
			return "stop";
		},
	});
	if (
		scope.signal.aborted ||
		(found === null &&
			(result.status !== "eof" ||
				(cursor === undefined && result.skippedRecords > 0)))
	)
		throw new JournalReadError("READ_FAILED");
	return found;
}
