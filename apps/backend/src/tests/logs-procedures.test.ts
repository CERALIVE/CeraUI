import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import * as logging from "../helpers/logger.ts";
import * as runner from "../helpers/run.ts";
import * as mocks from "../mocks/mock-service.ts";
import { currentBootId } from "../modules/device-logs/boot-id.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import { stopAllFollows } from "../modules/device-logs/follow.ts";
import { setLogSettingsDirForTest } from "../modules/device-logs/settings.ts";
import { appendBoot } from "../modules/events/store.ts";
import { handleORPCMessage } from "../rpc/adapter.ts";
import { appRouter } from "../rpc/router.ts";
import type { RPCContext } from "../rpc/types.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

let sockets: Awaited<ReturnType<typeof logsSockets>>;
let dir: string;
const originalEventsDir = process.env.CERALIVE_EVENTS_DIR;
const retention = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "info",
} as const;
const guestCalls = [
	{
		name: "query",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.query, {}, { context }),
	},
	{
		name: "around",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.around, { bootId: bootId(), at: 0 }, { context }),
	},
	{
		name: "boots",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.boots, undefined, { context }),
	},
	{
		name: "followStart",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.followStart, {}, { context }),
	},
	{
		name: "followStop",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.followStop, undefined, { context }),
	},
	{
		name: "getStorage",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.getStorage, undefined, { context }),
	},
	{
		name: "setRetention",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.setRetention, retention, { context }),
	},
	{
		name: "deleteLegacyDebug",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.deleteLegacyDebug, undefined, { context }),
	},
	{
		name: "clearAll",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.clearAll, undefined, { context }),
	},
	{
		name: "createExport",
		invoke: (context: RPCContext) =>
			call(appRouter.logs.createExport, { filter: {} }, { context }),
	},
];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "logs-rpc-"));
	process.env.CERALIVE_EVENTS_DIR = dir;
	setLogSettingsDirForTest(dir);
	spyOn(mocks, "shouldUseMocks").mockReturnValue(true);
	logging.clearRecentLogLines();
	sockets = await logsSockets();
});
afterEach(async () => {
	await stopAllFollows("cleared");
	await abortLogExports();
	sockets.close();
	spyOn(mocks, "shouldUseMocks").mockRestore();
	setLogSettingsDirForTest(null);
	logging.clearRecentLogLines();
	rmSync(dir, { recursive: true, force: true });
	if (originalEventsDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
	else process.env.CERALIVE_EVENTS_DIR = originalEventsDir;
});
function bootId(): string {
	const id = currentBootId();
	if (!id) throw new Error("test host boot identity unavailable");
	return id;
}
async function seed(): Promise<void> {
	await new Promise<void>((resolve) =>
		logging.logger.write(
			{ level: "error", message: "rpc-marker", module: "test" },
			() => resolve(),
		),
	);
}

test.each(guestCalls)(
	"$name rejects a guest before any scan or mutation",
	async (row) => {
		const spawn = spyOn(Bun, "spawn");
		try {
			// The router is the public admission boundary, including schema parsing.
			await expect(row.invoke(sockets.guestContext)).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	},
);

test("query and around read the mock ring with defaults and extreme timestamps", async () => {
	await new Promise<void>((resolve) =>
		logging.logger.write(
			{
				level: "error",
				message: "event",
				module: "events",
				event_id: "rpc-marker",
			},
			() => resolve(),
		),
	);
	const run = spyOn(runner, "run");
	const spawn = spyOn(Bun, "spawn");
	try {
		const result = await call(
			appRouter.logs.query,
			{},
			{ context: sockets.context },
		);
		expect(result).toMatchObject({
			ok: true,
			termination: "end",
			hasMore: false,
			bootId: bootId(),
		});
		if (!result.ok) throw new Error(result.error);
		expect(result.entries.map((entry) => entry.message)).toEqual([
			'[events] event {"event_id":"rpc-marker"}',
		]);
		const entry = result.entries[0];
		if (!entry) throw new Error("missing marker");
		const exact = await call(
			appRouter.logs.around,
			{ bootId: bootId(), at: entry.ts, eventId: "rpc-marker" },
			{ context: sockets.context },
		);
		expect(exact).toMatchObject({
			ok: true,
			approximate: false,
			anchor: { cursor: entry.cursor },
		});
		for (const at of [0, Number.MAX_SAFE_INTEGER]) {
			const around = await call(
				appRouter.logs.around,
				{ bootId: bootId(), at },
				{ context: sockets.context },
			);
			expect(around).toMatchObject({
				ok: true,
				approximate: true,
				anchor: null,
			});
		}
		expect(run).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		run.mockRestore();
		spawn.mockRestore();
	}
});

test("boots includes historical classification instead of the discovery placeholder", async () => {
	appendBoot({
		bootId: "123456788694489b8c3a3fb4795cab24",
		startedAt: 1,
		versions: null,
	});
	expect(
		await call(appRouter.logs.boots, undefined, { context: sockets.context }),
	).toEqual([
		{
			bootId: bootId(),
			index: 0,
			firstTs: 0,
			lastTs: 0,
			current: true,
			shutdown: "current",
			evidence: [],
			logsAvailable: true,
			versions: null,
		},
		{
			bootId: "123456788694489b8c3a3fb4795cab24",
			index: -1,
			firstTs: 1,
			lastTs: 1,
			current: false,
			shutdown: "unknown",
			evidence: ["no_entries"],
			logsAvailable: false,
			versions: null,
		},
	]);
});

test("storage retention cleanup and export delegates work without systemd", async () => {
	await seed();
	const run = spyOn(runner, "run");
	const spawn = spyOn(Bun, "spawn");
	try {
		const storage = await call(appRouter.logs.getStorage, undefined, {
			context: sockets.context,
		});
		expect(storage).toMatchObject({
			ceiling: { maxSizeMb: 256, maxAgeDays: 30 },
			recentSample: 1,
		});
		expect(
			await call(appRouter.logs.setRetention, retention, {
				context: sockets.context,
			}),
		).toMatchObject({ ok: true, storage: { retention } });
		expect(
			await call(appRouter.logs.deleteLegacyDebug, undefined, {
				context: sockets.context,
			}),
		).toMatchObject({ ok: true, storage: { legacyDebugBytes: 0 } });
		const ticket = await call(
			appRouter.logs.createExport,
			{ filter: { text: "rpc-marker" }, boot: "current" },
			{ context: sockets.context },
		);
		expect(ticket).toMatchObject({
			ok: true,
			url: expect.stringMatching(/^\/api\/logs\/export\?ticket=[0-9a-f]{64}$/),
			expiresAt: expect.any(Number),
		});
		expect(
			await call(appRouter.logs.clearAll, undefined, {
				context: sockets.context,
			}),
		).toMatchObject({
			ok: true,
			storage: { lastClearedAt: expect.any(Number) },
		});
		expect(run).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		run.mockRestore();
		spawn.mockRestore();
	}
});

const invalid = [
	{ limit: -1 },
	{ limit: 1.5 },
	{ limit: 1e100 },
	{ limit: Number.MAX_SAFE_INTEGER },
	{ since: -1 },
	{ until: 0.5 },
	{ since: 1e100 },
	{ since: 2, until: 1 },
	{ levels: [] },
	{ levels: ["fatal"] },
	{ sources: ["--file=/etc/shadow"] },
	{ text: "" },
	{ text: "\0" },
	{ text: "é".repeat(129) },
	{ continuation: "" },
	{ continuation: "--file=/etc/shadow" },
	{ boot: "" },
	null,
	[],
	"malformed",
];
test.each(invalid)(
	"query rejects malformed input at admission: %j",
	async (input) => {
		let response: unknown;
		const send = spyOn(sockets.ws, "send").mockImplementation((frame) => {
			response = JSON.parse(String(frame));
			return 1;
		});
		try {
			await handleORPCMessage(sockets.ws, {
				id: "invalid-query",
				path: ["logs", "query"],
				input,
			});
			expect(response).toMatchObject({
				id: "invalid-query",
				error: { code: "VALIDATION_ERROR", message: "Input validation failed" },
			});
		} finally {
			send.mockRestore();
		}
	},
);
test.each([-1, 0.5, 1e100])(
	"around rejects invalid timestamp %s",
	async (at) => {
		await expect(
			call(
				appRouter.logs.around,
				{ bootId: bootId(), at },
				{ context: sockets.context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	},
);
test.each(["", "a b", "--file=/etc/shadow", "s".repeat(1025)])(
	"follow rejects invalid cursor %j",
	async (afterCursor) => {
		await expect(
			call(
				appRouter.logs.followStart,
				{ afterCursor },
				{ context: sockets.context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	},
);
test.each([-1, 0, 0.5, 1e100])(
	"retention rejects invalid age %s",
	async (maxAgeDays) => {
		await expect(
			call(
				appRouter.logs.setRetention,
				{ ...retention, maxAgeDays },
				{ context: sockets.context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	},
);
test("safe maximum retention is refused by the image ceiling without a range exception", async () => {
	expect(
		await call(
			appRouter.logs.setRetention,
			{ ...retention, maxAgeDays: Number.MAX_SAFE_INTEGER },
			{ context: sockets.context },
		),
	).toEqual({ ok: false, error: "INVALID_RETENTION" });
});
test.each([
	{ filter: {}, since: -1 },
	{ filter: {}, since: 1, until: 0 },
	{ filter: { text: "" } },
	{ filter: {}, boot: "bad" },
])(
	"export rejects invalid filters before ticket creation: %j",
	async (input) => {
		await expect(
			call(appRouter.logs.createExport, input, { context: sockets.context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	},
);
