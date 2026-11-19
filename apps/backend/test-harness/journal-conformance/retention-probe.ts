import { vacuumOlderJournal } from "../../src/modules/device-logs/older-journal.ts";

await vacuumOlderJournal(() => {
	throw new Error("native older-file cleanup did not settle");
});
