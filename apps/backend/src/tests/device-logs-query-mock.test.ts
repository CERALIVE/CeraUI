import { afterEach, expect, spyOn, test } from "bun:test";
import * as logging from "../helpers/logger.ts";
import * as run from "../helpers/run.ts";
import * as mocks from "../mocks/mock-service.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import { listBoots } from "../modules/device-logs/boots.ts";
import { locateAround, queryLogs } from "../modules/device-logs/query.ts";
import { emitEvent, resetEventEmitterForTest } from "../modules/events/emit.ts";
import * as store from "../modules/events/store.ts";
import { socket } from "./helpers/device-query.ts";

afterEach(() => {
	spyOn(mocks, "shouldUseMocks").mockRestore();
	spyOn(store, "readBoots").mockRestore();
	logging.clearRecentLogLines();
});

test.each([
	[
		"app",
		[
			["app", "srtla_send: quoted"],
			["app", "startup complete"],
		],
	],
	["bonding", [["bonding", "srtla_send: link ready"]]],
] as const)(
	"mock query for %s separates sender and app journal entries",
	async (source, expected) => {
		spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
		logging.clearRecentLogLines();
		logging.logger.info("startup complete");
		logging.logger.info("srtla_send: quoted");
		logging.logger.info("srtla_send: link ready", {
			processSource: "srtla_send",
		});
		const result = await queryLogs(socket(), {
			sources: [source],
			levels: ["info"],
		});
		if (!result.ok) throw new Error(result.error);
		expect(
			result.entries.map(({ source, message }) => [source, message]),
		).toEqual(expected.map((row) => [...row]));
	},
);

test("mock queries, event location and boot discovery share the ring without any process", async () => {
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	spyOn(store, "readBoots").mockReturnValue([]);
	logging.clearRecentLogLines();
	const at = Date.now();
	await new Promise<void>((resolve) =>
		logging.logger.write(
			{
				level: "info",
				message: "event",
				module: "events",
				event_id: "event-id",
			},
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
			'[events] event {"event_id":"event-id"}',
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
			anchor: { message: '[events] event {"event_id":"event-id"}' },
		});
		expect(command).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		command.mockRestore();
		spawn.mockRestore();
	}
});

test.each([false, true])(
	"mock event location ignores ID collisions when the producer record exists=%j",
	async (present) => {
		spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
		spyOn(store, "readBoots").mockReturnValue([]);
		logging.clearRecentLogLines();
		const bootId = currentBootId();
		if (!bootId) throw new Error("missing current boot");
		const id = `${bootId.slice(0, 8)}-1`;
		const at = Date.now();
		if (present) {
			const written = Promise.withResolvers<void>();
			resetEventEmitterForTest({
				bootId: () => bootId,
				tailSeq: () => 0,
				appendEvent: () => undefined,
				log(level, message, meta) {
					logging.logger.write({ level, message, ...meta }, (error) => {
						if (error) written.reject(error);
						else written.resolve();
					});
				},
			});
			try {
				emitEvent("service_stopping", { signal: "SIGTERM" });
				await written.promise;
			} finally {
				resetEventEmitterForTest();
			}
		}
		logging.logger.info(`free-text mention of ${id}`);
		logging.logger.info("event", { module: "events", event_id: `${id}0` });
		if (id !== id.toUpperCase())
			logging.logger.info("event", {
				module: "events",
				event_id: id.toUpperCase(),
			});
		logging.logger.info("event", { module: "fixture", event_id: id });
		logging.logger.info("event warning", { module: "events", event_id: id });
		const located = await locateAround(socket(), { bootId, at, eventId: id });
		if (!located.ok) throw new Error(located.error);
		expect(located.approximate).toBe(!present);
		expect(located.anchor?.message ?? null).toEqual(
			present
				? `[events] event {"event_id":"${id}","code":"service_stopping","params":{"signal":"SIGTERM"}}`
				: null,
		);
	},
);
