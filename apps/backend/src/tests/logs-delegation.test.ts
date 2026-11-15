import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logStorageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as boots from "../modules/device-logs/classified-boots.ts";
import * as exporting from "../modules/device-logs/export.ts";
import * as following from "../modules/device-logs/follow.ts";
import * as querying from "../modules/device-logs/query.ts";
import * as retention from "../modules/device-logs/retention.ts";
import { appRouter } from "../rpc/router.ts";
import type { RPCContext } from "../rpc/types.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

const bootId = "66d8d1808694489b8c3a3fb4795cab24";
const filter = {
	sources: ["engine"],
	levels: ["warning"],
	text: "literal",
} as const;
const input = {
	sources: [...filter.sources],
	levels: [...filter.levels],
	text: filter.text,
};
const settings = { maxAgeDays: 2, maxSizeMb: 32, detail: "info" } as const;
const storage = logStorageSchema.parse({
	journalBytes: 42,
	journalDirBytes: 43,
	legacyDebugBytes: 44,
	ceiling: { maxAgeDays: 30, maxSizeMb: 256 },
	retention: settings,
	oldestEntryTs: 1,
	recentVolume: [],
	recentSample: 0,
	eventsBytes: 45,
	lastMaintenance: null,
	lastClearedAt: null,
});
const invalid = { ok: false, error: "READ_FAILED", unexpected: true } as const;
const queryInput = {
	...input,
	boot: bootId,
	since: 1,
	until: 3,
	direction: "newer",
	limit: 2,
	continuation: "opaque",
} as const;
const aroundInput = { bootId, at: 2, eventId: "event-42" };
const followInput = { ...input, afterCursor: "s=42" };
const exportInput = { filter: input, boot: bootId, since: 1, until: 3 };
const cases = [
	{
		name: "query",
		spy: () => spyOn(querying, "queryLogs"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.query, queryInput, { context }),
		args: (context: RPCContext) => [context.ws, queryInput],
		invalid: () => spyOn(querying, "queryLogs").mockResolvedValue(invalid),
	},
	{
		name: "around",
		spy: () => spyOn(querying, "locateAround"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.around, aroundInput, { context }),
		args: (context: RPCContext) => [context.ws, aroundInput],
		invalid: () => spyOn(querying, "locateAround").mockResolvedValue(invalid),
	},
	{
		name: "boots",
		spy: () => spyOn(boots, "listBoots"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.boots, undefined, { context }),
		args: () => [],
		invalid: () =>
			spyOn(boots, "listBoots").mockResolvedValue([
				{
					bootId,
					index: -1,
					firstTs: -1,
					lastTs: 2,
					current: false,
					shutdown: "unknown",
					evidence: [],
					logsAvailable: true,
					versions: null,
				},
			]),
	},
	{
		name: "followStart",
		spy: () => spyOn(following, "startFollow"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.followStart, followInput, { context }),
		args: (context: RPCContext) => [context.ws, followInput],
		invalid: () => spyOn(following, "startFollow").mockResolvedValue(invalid),
	},
	{
		name: "followStop",
		spy: () => spyOn(following, "stopFollow"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.followStop, undefined, { context }),
		args: (context: RPCContext) => [context.ws],
		invalid: () => {
			const response = {
				success: true,
				checkpointCursor: null,
				unexpected: true,
			};
			return spyOn(following, "stopFollow").mockResolvedValue(response);
		},
	},
	{
		name: "getStorage",
		spy: () => spyOn(retention, "getStorage"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.getStorage, undefined, { context }),
		args: () => [],
		invalid: () =>
			spyOn(retention, "getStorage").mockResolvedValue({
				...storage,
				journalBytes: -1,
			}),
	},
	{
		name: "setRetention",
		spy: () => spyOn(retention, "setRetention"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.setRetention, settings, { context }),
		args: () => [settings],
		invalid: () => spyOn(retention, "setRetention").mockResolvedValue(invalid),
	},
	{
		name: "deleteOlderFiles",
		spy: () => spyOn(retention, "deleteOlderFiles"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.deleteOlderFiles, undefined, { context }),
		args: () => [],
		invalid: () =>
			spyOn(retention, "deleteOlderFiles").mockResolvedValue(invalid),
	},
	{
		name: "deleteLegacyDebug",
		spy: () => spyOn(retention, "deleteLegacyDebug"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.deleteLegacyDebug, undefined, { context }),
		args: () => [],
		invalid: () =>
			spyOn(retention, "deleteLegacyDebug").mockResolvedValue(invalid),
	},
	{
		name: "clearAll",
		spy: () => spyOn(retention, "clearAll"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.clearAll, undefined, { context }),
		args: () => [],
		invalid: () => spyOn(retention, "clearAll").mockResolvedValue(invalid),
	},
	{
		name: "createExport",
		spy: () => spyOn(exporting, "createExport"),
		invoke: (context: RPCContext) =>
			call(appRouter.logs.createExport, exportInput, { context }),
		args: (context: RPCContext) => [context.ws, exportInput],
		invalid: () => spyOn(exporting, "createExport").mockResolvedValue(invalid),
	},
];
let sockets: Awaited<ReturnType<typeof logsSockets>>;
beforeEach(async () => {
	sockets = await logsSockets();
});
afterEach(() => sockets.close());

test.each(cases)(
	"$name forwards the admitted input and socket once, including a throwing owner",
	async (row) => {
		const failure = new Error("owner rejected");
		const owner = row.spy().mockImplementation(async () => {
			throw failure;
		});
		try {
			await expect(row.invoke(sockets.context)).rejects.toBe(failure);
			const calls: readonly unknown[] = owner.mock.calls;
			expect(calls).toEqual([row.args(sockets.context)]);
			if (
				[
					"query",
					"around",
					"followStart",
					"followStop",
					"createExport",
				].includes(row.name)
			) {
				const firstCall: readonly unknown[] | undefined = owner.mock.calls[0];
				expect(firstCall?.[0]).toBe(sockets.ws);
			}
		} finally {
			owner.mockRestore();
		}
	},
);
test.each(cases)(
	"$name validates the owner's reply before exposing it",
	async (row) => {
		const owner = row.invalid();
		try {
			await expect(row.invoke(sockets.context)).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
			});
		} finally {
			owner.mockRestore();
		}
	},
);
