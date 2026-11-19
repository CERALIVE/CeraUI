import { deleteOlderJournal } from "../../src/modules/device-logs/older-journal.ts";

const first = process.argv[2];
const { warnings, unverifiedArchivesKeptCount } = await deleteOlderJournal(
	first === undefined ? undefined : Number(first),
);
console.log(JSON.stringify({ ...warnings, unverifiedArchivesKeptCount }));
