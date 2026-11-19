import { expect, spyOn, test } from "bun:test";
import { logRetentionSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as ceiling from "../modules/device-logs/ceiling.ts";
import { setRetention } from "../modules/device-logs/retention.ts";
import { getLogSettings } from "../modules/device-logs/settings.ts";
import { appRouter } from "../rpc/router.ts";
import { retentionFixture } from "./helpers/device-retention.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";
import { expectInvalidRetention } from "./helpers/retention-rpc.ts";

const defaults = {
	maxAgeDays: null,
	maxSizeMb: null,
	detail: "debug",
} as const;

test.each([
	{ ...defaults, maxAgeDays: 31 },
	{ ...defaults, maxAgeDays: Number.MAX_SAFE_INTEGER },
	{ ...defaults, maxSizeMb: 257 },
])(
	"refuses retention above the deployment ceiling without saving or spawning: %j",
	async (value) => {
		const fixture = retentionFixture();
		const deployed = spyOn(ceiling, "readJournalCeiling").mockReturnValue({
			maxSizeMb: 256,
			maxAgeDays: 30,
		});
		try {
			expect(await setRetention(value)).toEqual({
				ok: false,
				error: "INVALID_RETENTION",
			});
			expect(getLogSettings()).toEqual(defaults);
			expect(fixture.run.mock.calls).toEqual([]);
		} finally {
			deployed.mockRestore();
			await fixture.restore();
		}
	},
);

test.each([
	{ ...defaults, maxAgeDays: 0 },
	{ ...defaults, maxAgeDays: -1 },
	{ ...defaults, maxAgeDays: 1.1 },
	{ ...defaults, maxSizeMb: 15 },
	{ ...defaults, maxSizeMb: Number.MAX_VALUE },
	{ ...defaults, maxSizeMb: 16.1 },
	{},
	null,
	"",
	{ ...defaults, detail: "bad" },
])(
	"refuses malformed retention at RPC admission without saving or spawning: %j",
	async (value) => {
		const fixture = retentionFixture();
		try {
			await expectInvalidRetention(value);
			expect(getLogSettings()).toEqual(defaults);
			expect(fixture.run.mock.calls).toEqual([]);
		} finally {
			await fixture.restore();
		}
	},
);

test("retention RPC hands validated settings to the service and writer without reparsing", async () => {
	const sockets = await logsSockets();
	const fixture = retentionFixture();
	fixture.mock.mockReturnValue(true);
	const parse = spyOn(logRetentionSchema._zod, "run");
	try {
		const next = { maxAgeDays: null, maxSizeMb: null, detail: "info" } as const;
		expect(
			await call(appRouter.logs.setRetention, next, {
				context: sockets.context,
			}),
		).toMatchObject({
			ok: true,
			storage: { retention: next },
		});
		// The input and output cross the wire schema once each.
		expect(parse).toHaveBeenCalledTimes(2);
	} finally {
		parse.mockRestore();
		sockets.close();
		await fixture.restore();
	}
});
