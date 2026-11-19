import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import {
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { bounded } from "./helpers/history-clear.ts";

let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	collect = spyOn(data, "collectBundleData").mockResolvedValue({
		exportedBy: {
			bootId,
			ceraui: "ui",
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		},
		boots: [{ bootId, versions: null }],
		journalBoots: [bootId],
		settings: {
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable",
			autostart: null,
			hardwareKind: "generic",
			data: null,
		},
		events: [],
		bootRecords: [],
		secrets: [],
	});
});
afterEach(async () => {
	await abortLogExports();
	collect.mockRestore();
	fixture.restore();
});

test("clear settles after the aborted preparation has completed", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async ({ signal }) => {
		if (!signal) throw new Error("missing scan signal");
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		entered.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const building = createBundle({});
	await entered.promise;
	let settled = false;
	const clearing = abortLogExports().then(() => {
		settled = true;
	});
	try {
		await aborted.promise;
		release.resolve();
		expect(await building).toEqual({ ok: false, error: "READ_FAILED" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(true);
	} finally {
		release.resolve();
		await building;
		if (settled) await clearing;
	}
});

test("a download delivers its declared records and then closes each read", async () => {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	if (!response.body) throw new Error("missing bundle body");
	const reader = response.body.getReader();
	let reading = Promise.resolve();
	try {
		// Exporter, stored boot, settings and end are four complete gzip members.
		for (let member = 0; member < 5; member++) {
			let outcome = "pending";
			reading = reader.read().then(
				(value) => {
					outcome = value.done ? "closed" : "member";
				},
				(error: unknown) => {
					outcome = error instanceof Error ? error.message : String(error);
				},
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(outcome).toBe(member === 4 ? "closed" : "member");
		}
	} finally {
		await reader.cancel();
		await reading;
	}
});

async function journalDownload(signal?: AbortSignal) {
	const created = await createBundle({}, signal);
	if (!created.ok) throw new Error(created.error);
	const { body } = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	if (!body) throw new Error("missing bundle body");
	const text = await new Response(
		body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	const lines = text.trimEnd().split("\n");
	return {
		cursors: lines
			.filter((line) => line.startsWith('{"section":"journal","entry":'))
			.map((line) => logEntrySchema.parse(JSON.parse(line).entry).cursor),
		tail: lines.slice(-2).map((line): unknown => JSON.parse(line)),
	};
}

const previous = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
test.each(["held slot", "short budget pages"] as const)(
	"the running boot has time to finish despite previous boot %s",
	async (scenario) => {
		const startedAt = 1_700_000_000_000;
		let now = startedAt;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const snapshot = await collect();
		collect.mockImplementation(async () => {
			if (scenario === "held slot") now += 59_900;
			return { ...snapshot, journalBoots: [bootId, previous] };
		});
		const current = journal([record(100), record(101), record(102)], 2);
		const history = journal(
			Array.from({ length: 90 }, (_, i) =>
				record(i + 1, { _BOOT_ID: previous }),
			),
			2,
		);
		fixture.scan.mockImplementation(async (input) => {
			if (!input.matches.includes(`_BOOT_ID=${previous}`))
				return current(input);
			if (scenario === "held slot") {
				if (!input.signal) throw new Error("missing previous scan signal");
				const stopped = Promise.withResolvers<void>();
				input.signal.addEventListener("abort", () => stopped.resolve(), {
					once: true,
				});
				await stopped.promise;
			} else {
				now += 1000;
			}
			return history(input);
		});
		const controller = new AbortController();
		const pending = journalDownload(controller.signal);
		try {
			const result = await bounded(pending);
			expect(result.cursors.slice(-3)).toEqual(["s=102", "s=101", "s=100"]);
			expect(result.tail).toEqual([
				{ section: "journal", incomplete: "time_limit" },
				{ section: "end", complete: false },
			]);
		} finally {
			controller.abort("time_limit");
			await pending;
			clock.mockRestore();
		}
	},
);

test.each([false, true])(
	"a budget page without progress is incomplete instead of retrying (continuation=%j)",
	async (withContinuation) => {
		const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const first = journal([record(1), record(2)], 1);
		fixture.scan.mockImplementation(async (input) => {
			if (fixture.scan.mock.calls.length > (withContinuation ? 2 : 1))
				clock.mockReturnValue(1_700_000_060_000);
			if (withContinuation) return first(input);
			return { status: "budget", exitCode: 143, skippedRecords: 1 };
		});
		try {
			expect(await journalDownload()).toEqual({
				cursors: withContinuation ? ["s=2"] : [],
				tail: [
					{ section: "journal", incomplete: "READ_FAILED" },
					{ section: "end", complete: false },
				],
			});
		} finally {
			clock.mockRestore();
		}
	},
);
