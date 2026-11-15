import { afterEach, expect, setSystemTime, test } from "bun:test";
import * as logging from "../helpers/logger.ts";
import { compileFilter } from "../modules/device-logs/filter.ts";
import { scanMockJournal } from "../modules/device-logs/mock-journal.ts";
import { scanInput } from "./helpers/device-journal.ts";

afterEach(() => {
	setSystemTime();
	logging.clearRecentLogLines();
});
const emit = (level: string) =>
	new Promise<void>((resolve, reject) =>
		logging.logger.write({ message: level, level }, (error) =>
			error ? reject(error) : resolve(),
		),
	);
async function read(matches: string[]) {
	const messages: string[] = [];
	await scanMockJournal({
		...scanInput,
		matches,
		onRecord(record) {
			messages.push(record.message);
			return "continue";
		},
	});
	return messages;
}

test("uncatalogued Winston http level uses the same debug priority as the journal", async () => {
	logging.clearRecentLogLines();
	await emit("http");
	const { matches } = compileFilter({ levels: ["debug"] }, { bootId: null });
	expect(await read(matches)).toEqual(["http"]);
});

test("repeated native severity terms retain every selected mock level", async () => {
	logging.clearRecentLogLines();
	for (const level of ["error", "warn", "info", "debug"]) await emit(level);
	const { matches } = compileFilter(
		{ levels: ["error", "warning"] },
		{ bootId: null },
	);
	expect(await read(matches)).toEqual(["error", "warn"]);
});

test("field names matter when timestamp zero equals an error priority value", async () => {
	logging.clearRecentLogLines();
	setSystemTime(new Date(0));
	await emit("info");
	const { matches } = compileFilter({ levels: ["error"] }, { bootId: null });
	expect(await read(matches)).toEqual([]);
});

test("a stopped mock scan returns the reaped synthetic child exit code", async () => {
	logging.clearRecentLogLines();
	for (let i = 0; i < 5; i++) await emit("debug");
	expect(
		await scanMockJournal({
			...scanInput,
			limits: { records: 1 },
		}),
	).toMatchObject({ status: "budget", exitCode: 143 });
});
