import {
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	modemMutationEntrySchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { parseAuthorityJson } from "../system/update-orchestrator/strict-authority-json.ts";
import { noteMutationJournalReadFault } from "./mutation-journal-revision.ts";

export function parseMutationJournalEntry(
	raw: string,
	slotHint: string,
): ModemMutationEntry | undefined {
	try {
		const parsed = modemMutationEntrySchema.safeParse(parseAuthorityJson(raw));
		if (parsed.success) return parsed.data;
		noteMutationJournalReadFault();
		logger.warn("modem mutation journal entry did not validate", {
			module: "modems",
			slot: slotHint,
			version: MODEM_MUTATION_JOURNAL_VERSION,
		});
	} catch {
		noteMutationJournalReadFault();
		logger.warn("modem mutation journal entry is unparseable", {
			module: "modems",
			slot: slotHint,
		});
	}
	return undefined;
}
