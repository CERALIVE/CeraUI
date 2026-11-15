import { afterEach, expect, test } from "bun:test";
import { getRecentLogLines } from "../helpers/logger.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	await h?.dispose();
});

test("native clear vacuums journal history without wiping the separate mock ring", async () => {
	h = historyFixture(false);
	expect((await bounded(clearAll())).ok).toBe(true);
	expect(getRecentLogLines().map((line) => JSON.parse(line).msg)).toEqual([
		"before-clear",
		"device logs cleared",
	]);
	const page = await queryLogs({}, {});
	if (!page.ok) throw new Error(page.error);
	expect(page.entries.map((entry) => entry.message)).toEqual([
		"[device-logs] device logs cleared",
	]);
});
