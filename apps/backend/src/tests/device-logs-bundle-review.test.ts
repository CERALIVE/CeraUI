import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deviceEventSchema } from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
} from "../modules/device-logs/export.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let source: Awaited<ReturnType<typeof data.collectBundleData>>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
	source = {
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
	};
	collect = spyOn(data, "collectBundleData").mockImplementation(
		async () => source,
	);
});
afterEach(async () => {
	await abortLogExports();
	collect.mockRestore();
	clock.mockRestore();
	fixture.restore();
});

test.each(["preview", "create"] as const)(
	"a processed redaction count equal to a secret refuses %s",
	async (operation) => {
		source = { ...source, secrets: [{ kind: "key", value: "1234" }] };
		fixture.scan.mockImplementation(
			journal([record(1, { MESSAGE: "1234 ".repeat(1234) })]),
		);
		switch (operation) {
			case "preview":
				await expect(previewBundle()).rejects.toMatchObject({
					code: "READ_FAILED",
					message: "READ_FAILED",
				});
				break;
			case "create":
				expect(await createBundle({})).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
				break;
			default: {
				const impossible: never = operation;
				throw new Error(String(impossible));
			}
		}
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	},
);

test("clear remains pending until its aborted native scan has joined", async () => {
	const entered = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async ({ signal }) => {
		if (!signal) throw new Error("missing native scan signal");
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
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(await createExport({}, { filter: {} })).toEqual({
			ok: false,
			error: "BUSY",
		});
	} finally {
		release.resolve();
		await clearing;
		expect(await building).toEqual({ ok: false, error: "READ_FAILED" });
	}
	expect(settled).toBe(true);
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("abort with a throwing close retires each owned timer exactly once", async () => {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	const scheduled = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	const controller = new AbortController();
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const timer = scheduled.mock.results[0];
	if (timer?.type !== "return") throw new Error("missing download timer");
	const close = spyOn(
		ReadableStreamDefaultController.prototype,
		"close",
	).mockImplementation(() => {
		throw new Error("PRIVATE");
	});
	try {
		controller.abort();
		expect(
			cleared.mock.calls.filter(([handle]) => handle === timer.value),
		).toHaveLength(1);
		await expect(response.arrayBuffer()).rejects.toThrow("READ_FAILED");
		await abortLogBundles();
		expect(
			cleared.mock.calls.filter(([handle]) => handle === timer.value),
		).toHaveLength(1);
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		close.mockRestore();
		scheduled.mockRestore();
		cleared.mockRestore();
	}
});

test.each([
	"8.8.8.8",
	"aa:bb:cc:dd:ee:ff",
	"490154203237518",
	"8934071100276980483",
	"10.0000,20.0000",
	"Bearer private",
	"v4.public.private",
	"eyJabc.def.ghi",
])("a pattern-shaped retained event key fails closed: %s", async (key) => {
	source = {
		...source,
		events: [
			deviceEventSchema.parse({
				id: "event",
				seq: 1,
				bootId,
				at: 1,
				code: "future_event",
				family: "network",
				severity: "info",
				params: { [key]: "safe" },
			}),
		],
	};
	await expect(previewBundle()).rejects.toMatchObject({ code: "READ_FAILED" });
	expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
});
