import { deleteOlderJournal } from "../../src/modules/device-logs/older-journal.ts";

console.log(JSON.stringify(await deleteOlderJournal()));
