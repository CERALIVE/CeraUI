import { createHash } from "node:crypto";
import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	modemMutationEntrySchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { parseAuthorityJson } from "../system/update-orchestrator/strict-authority-json.ts";
import { noteMutationJournalReadFault } from "./mutation-journal-revision.ts";

export function mutationSlotName(stableKey: string): string {
	return createHash("sha256").update(stableKey, "utf8").digest("hex");
}

/**
 * Parse the record stored in journal file `slotFile`. A record is valid only in
 * the slot its own key hashes to: a schema-valid record filed elsewhere names
 * another device's authority, so it is a read fault like a torn file, never that
 * device's record and never an absence.
 */
export function parseMutationJournalEntry(
	raw: string,
	slotFile: string,
): ModemMutationEntry | undefined {
	try {
		const parsed = modemMutationEntrySchema.safeParse(parseAuthorityJson(raw));
		const bound =
			parsed.success &&
			`${mutationSlotName(parsed.data.stableKey)}.json` === slotFile;
		if (bound) return parsed.data;
		noteMutationJournalReadFault();
		logger.warn(
			parsed.success
				? "modem mutation journal entry is filed under another key's slot"
				: "modem mutation journal entry did not validate",
			{
				module: "modems",
				slot: slotFile,
				version: MODEM_MUTATION_JOURNAL_VERSION,
			},
		);
	} catch {
		noteMutationJournalReadFault();
		logger.warn("modem mutation journal entry is unparseable", {
			module: "modems",
			slot: slotFile,
		});
	}
	return undefined;
}
