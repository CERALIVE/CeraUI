import { afterEach, expect, spyOn, test } from "bun:test";
import * as logging from "../helpers/logger.ts";
import * as run from "../helpers/run.ts";
import * as mocks from "../mocks/mock-service.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import { listBoots } from "../modules/device-logs/boots.ts";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import * as store from "../modules/events/store.ts";
import { socket } from "./helpers/device-query.ts";

afterEach(() => {
	spyOn(mocks, "shouldUseMocks").mockRestore();
	spyOn(store, "readBoots").mockRestore();
	logging.clearRecentLogLines();
});
test("mock queries, event location and boot discovery share the ring without any process", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spyOn(store, "readBoots").mockReturnValue([]);
	logging.clearRecentLogLines();
	const at = Date.now();
	await new Promise<void>((resolve) =>
		logging.logger.write(
			{ level: "info", message: "event-id", module: "fixture" },
			() => resolve(),
		),
	);
	const command = spyOn(run, "run");
	const spawn = spyOn(Bun, "spawn");
	try {
		const result = await queryLogs(socket(), { boot: "current" });
		expect(result).toMatchObject({
			ok: true,
			hasMore: false,
			bootId: currentBootId(),
		});
		if (!result.ok) throw new Error(result.error);
		expect(result.entries.map((r) => r.message)).toEqual([
			"[fixture] event-id",
		]);
		const boots = await listBoots();
		expect(boots).toHaveLength(1);
		expect(boots[0]).toMatchObject({
			bootId: currentBootId(),
			current: true,
			logsAvailable: true,
			shutdown: "current",
		});
		const around = await locateAround(socket(), {
			bootId: currentBootId() ?? "",
			at,
			eventId: "event-id",
		});
		expect(around).toMatchObject({
			ok: true,
			approximate: false,
			anchor: { message: "[fixture] event-id" },
		});
		expect(command).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		command.mockRestore();
		spawn.mockRestore();
	}
});
