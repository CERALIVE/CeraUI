import { deleteOlderJournal } from "../../src/modules/device-logs/older-journal.ts";

const first = process.argv[2];
console.log(JSON.stringify(await deleteOlderJournal(first === undefined ? undefined : Number(first))));
