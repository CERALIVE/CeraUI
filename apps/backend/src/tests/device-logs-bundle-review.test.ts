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

const numericBootId = "abeefc820722459888558b432da848fa";

test("a known boot ID with a long digit run survives preview and download", async () => {
	const cursor = `s=abcd;i=1;b=${numericBootId};m=10;t=20;x=abcd`;
	const versions = { ...source.exportedBy, bootId: numericBootId };
	source = {
		...source,
		exportedBy: versions,
		boots: [{ bootId: numericBootId, versions }],
		journalBoots: [numericBootId],
		bootRecords: [{ bootId: numericBootId, startedAt: 1, versions }],
		events: [
			deviceEventSchema.parse({
				id: "event",
				seq: 1,
				bootId: numericBootId,
				at: 1,
				code: "device_started",
				family: "system",
				severity: "info",
				params: {},
			}),
		],
	};
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_BOOT_ID: numericBootId,
				__CURSOR: cursor,
				MESSAGE: `modem identifier 490154203237518, boot text ${numericBootId}`,
			}),
		]),
	);
	const manifest = await previewBundle();
	expect(manifest.exportedBy.bootId).toBe(numericBootId);
	expect(manifest.boots).toEqual([{ bootId: numericBootId, versions }]);
	const ticket = await createBundle({});
	if (!ticket.ok) throw new Error(ticket.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${ticket.url}`),
	);
	expect(response.status).toBe(200);
	const text = await new Response(
		response.body?.pipeThrough(new DecompressionStream("gzip")),
	).text();
	expect(text).toContain(`"cursor":"${cursor}"`);
	expect(text).toContain(`"boot":{"bootId":"${numericBootId}"`);
	expect(text).toContain(
		`"event":{"id":"event","seq":1,"bootId":"${numericBootId}"`,
	);
	expect(text).toContain("modem identifier [ID]");
	expect(text).toContain("boot text [BOOT_ID]");
	expect(text).not.toContain("490154203237518");
	expect(text.trimEnd().split("\n").at(-1)).toBe(
		'{"section":"end","complete":true}',
	);
});

test.each([
	[
		"an unknown boot shaped value",
		{ exported: { bootId, ceraui: numericBootId }, secrets: [] },
	],
	[
		"a known boot ID in version text",
		{ exported: { bootId, ceraui: `version=${bootId}` }, secrets: [] },
	],
	[
		"a held secret inside a known boot ID",
		{
			exported: { bootId: numericBootId, ceraui: "ui" },
			secrets: [{ kind: "key", value: "820722459888558" }],
		},
	],
] as const)(
	"refuses %s in structured values",
	async (_scenario, { exported, secrets }) => {
		source = {
			...source,
			exportedBy: { ...source.exportedBy, ...exported },
			journalBoots: [exported.bootId],
			secrets,
		};
		await expect(previewBundle()).rejects.toThrow("READ_FAILED");
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	},
);

const retainedBootId = "abeefc490154203237518b432da848fa";

const collisions: ReadonlyArray<
	readonly [
		string,
		{
			readonly version?: string;
			readonly serial?: string;
			readonly cursor?: string;
			readonly scanBootId?: string;
		},
	]
> = [
	["version text", { version: `build/${retainedBootId}` }],
	["an event parameter", { serial: `modem/${retainedBootId}` }],
	["a nonboot cursor component", { cursor: `s=${retainedBootId};b=${bootId}` }],
	[
		"a nonboot component of a native cursor",
		{ cursor: `s=${retainedBootId};i=1;b=${bootId};m=2;t=3;x=4` },
	],
	["a different boot in the cursor", { cursor: `b=${retainedBootId}` }],
	[
		"an IMEI next to the boot component",
		{
			cursor: `b=${numericBootId};i=490154203237518`,
			scanBootId: numericBootId,
		},
	],
	[
		"an IMEI appended to the boot component",
		{ cursor: `b=${numericBootId}/490154203237518`, scanBootId: numericBootId },
	],
];

test.each(collisions)(
	"refuses a numeric identifier in %s",
	async (_name, row) => {
		source = {
			...source,
			bootRecords: [{ bootId: retainedBootId, startedAt: 1, versions: null }],
		};
		if (row.version)
			source = {
				...source,
				exportedBy: { ...source.exportedBy, ceraui: row.version },
			};
		if (row.serial)
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
						params: { serial: row.serial },
					}),
				],
			};
		if (row.cursor) {
			const scanBootId = row.scanBootId ?? bootId;
			source = {
				...source,
				exportedBy: { ...source.exportedBy, bootId: scanBootId },
				boots: [{ bootId: scanBootId, versions: null }],
				journalBoots: [scanBootId],
			};
			fixture.scan.mockImplementation(
				journal([record(1, { _BOOT_ID: scanBootId, __CURSOR: row.cursor })]),
			);
		}
		await expect(previewBundle()).rejects.toMatchObject({
			code: "READ_FAILED",
		});
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
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
