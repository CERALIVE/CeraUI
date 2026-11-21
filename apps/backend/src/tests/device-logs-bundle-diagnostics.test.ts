import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deviceEventSchema } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import { BUNDLE_TIME_MS } from "../modules/device-logs/bundle-body.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import * as settings from "../modules/device-logs/settings.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// sd_journal_get_cursor's exact shape; its xor hash holds exactly fifteen
// decimal digits, as about one real cursor in 1700 does.
const nativeCursor = (boot: string) =>
	`s=3f1c9b0e8a7d4c2f9e6b5a4d3c2b1a09;i=1b2f4;b=${boot};m=2c41a8f3;t=6447a1c3e5f20;x=c720381946205537`;
// The same digit run in a boot ID (about one ID in 390).
const uncleanBoot = "ea318275064912837fa3c9d0b1e2f4ac";
const REFUSED = "Support bundle preparation refused";

let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let warn: ReturnType<typeof spyOn<typeof logging.logger, "warn">>;
let source: Awaited<ReturnType<typeof data.collectBundleData>>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
	warn = spyOn(logging.logger, "warn").mockImplementation(() => logging.logger);
	source = {
		exportedBy: {
			bootId,
			ceraui: "2026.11.3 (ad26a5bb)",
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
	warn.mockRestore();
	clock.mockRestore();
	fixture.restore();
});

const refusals = (): unknown[][] =>
	warn.mock.calls
		.map((call): unknown[] => [...call])
		.filter(([message]) => message === REFUSED);

async function download(): Promise<string> {
	const ticket = await createBundle({});
	if (!ticket.ok) throw new Error(ticket.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${ticket.url}`),
	);
	expect(response.status).toBe(200);
	return new Response(
		response.body?.pipeThrough(new DecompressionStream("gzip")),
	).text();
}

function event(code: string, params: Record<string, unknown>, seq = 1) {
	return deviceEventSchema.parse({
		id: `aaaaaaaa-${seq}`,
		seq,
		bootId,
		at: seq,
		code,
		family: code === "modem_added" ? "cellular" : "device",
		severity: "info",
		params,
	});
}

test("a native journald cursor whose hex hash holds fifteen decimal digits survives preview and download", async () => {
	const cursor = nativeCursor(bootId);
	fixture.scan.mockImplementation(journal([record(1, { __CURSOR: cursor })]));
	const manifest = await previewBundle();
	expect(manifest.sections.at(-1)).toEqual({
		id: "journal",
		entries: 1,
		redactions: 0,
		bootsCovered: 1,
		complete: true,
	});
	const text = await download();
	expect(text).toContain(`"cursor":"${cursor}"`);
	expect(text.trimEnd().split("\n").at(-1)).toBe(
		'{"section":"end","complete":true}',
	);
	expect(refusals()).toEqual([]);
});

test.each([
	[
		"a held secret inside a native cursor",
		[{ kind: "router_password", value: "1946" }],
		bootId,
		"collision",
	],
	["a native cursor naming another boot", [], "b".repeat(32), "pattern"],
] as const)(
	"%s still refuses, with a sanitized stage",
	async (_name, secrets, cursorBoot, stage) => {
		source = { ...source, secrets: [...secrets] };
		fixture.scan.mockImplementation(
			journal([record(1, { __CURSOR: nativeCursor(cursorBoot) })]),
		);
		await expect(previewBundle()).rejects.toMatchObject({
			code: "READ_FAILED",
			message: "READ_FAILED",
			reason: stage,
		});
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	},
);

test("an unclean previous boot whose ID holds fifteen decimal digits still previews and downloads", async () => {
	const previous = { ...source.exportedBy, bootId: uncleanBoot };
	source = {
		...source,
		boots: [
			{ bootId, versions: null },
			{ bootId: uncleanBoot, versions: previous },
		],
		journalBoots: [bootId, uncleanBoot],
		bootRecords: [
			{ bootId: uncleanBoot, startedAt: 1, versions: previous },
			{ bootId, startedAt: 2, versions: source.exportedBy },
		],
		events: [
			event("device_started", {
				osImage: null,
				slot: null,
				board: null,
				boardModel: null,
				ceraui: "2026.11.3 (ad26a5bb)",
				engine: null,
				senderVersion: null,
				kernel: null,
				bun: null,
				previousBootId: uncleanBoot,
				previousShutdown: "unclean",
			}),
			event(
				"previous_boot_unclean",
				{ bootId: uncleanBoot, evidence: ["no_shutdown_markers"] },
				2,
			),
		],
	};
	const manifest = await previewBundle();
	expect(manifest.boots.map((boot) => boot.bootId)).toEqual([
		bootId,
		uncleanBoot,
	]);
	const text = await download();
	expect(text).toContain(`"previousBootId":"${uncleanBoot}"`);
	expect(text).toContain(
		`"params":{"bootId":"${uncleanBoot}","evidence":["no_shutdown_markers"]}`,
	);
	expect(refusals()).toEqual([]);
});

test("an event boot field naming a boot the device never recorded keeps its pattern check", async () => {
	source = {
		...source,
		events: [
			event("previous_boot_unclean", {
				bootId: uncleanBoot,
				evidence: ["no_shutdown_markers"],
			}),
		],
	};
	await expect(previewBundle()).rejects.toMatchObject({
		code: "READ_FAILED",
		reason: "pattern",
	});
});

const stages = [
	[
		"a stream ID that is also part of the file and unit names",
		"collision",
		"live",
		() => {
			source = { ...source, secrets: [{ kind: "stream", value: "live" }] };
		},
	],
	[
		"a short numeric credential inside a timestamp",
		"collision",
		"1700",
		() => {
			source = {
				...source,
				secrets: [{ kind: "apn_password", value: "1700" }],
			};
		},
	],
	[
		"an IMEI inside a retained modem name",
		"pattern",
		"867400050512345",
		() => {
			source = {
				...source,
				events: [
					event("modem_added", {
						modemKey: "usb-1-1.2",
						name: "Quectel EM12-G 867400050512345",
					}),
				],
			};
		},
	],
	[
		"held secrets over the 64 KiB dictionary budget",
		"budget",
		"k".repeat(4095),
		() => {
			source = {
				...source,
				secrets: Array.from({ length: 17 }, (_, index) => ({
					kind: "relay",
					value: `${index}`.padEnd(4096, "k"),
				})),
			};
		},
	],
	[
		"a boot list the journal refused",
		"journal_read",
		"insufficient permissions",
		() => {
			collect.mockRejectedValue(
				new JournalReadError(
					"READ_FAILED",
					"No journal files were opened due to insufficient permissions.",
				),
			);
		},
	],
	[
		"an unexpected collection fault",
		"internal",
		"PLANTED-PRIVATE",
		() => {
			collect.mockRejectedValue(new Error("PLANTED-PRIVATE"));
		},
	],
] as const;

test.each(stages)(
	"%s refuses with the %s stage, logged without any cause or input text",
	async (_name, stage, privateText, arrange) => {
		arrange();
		await expect(previewBundle()).rejects.toMatchObject({
			code: "READ_FAILED",
			message: "READ_FAILED",
			reason: stage,
		});
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
		expect(refusals()).toEqual([
			[REFUSED, { module: "device-logs", operation: "preview", stage }],
			[REFUSED, { module: "device-logs", operation: "create", stage }],
		]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
	},
);

test("an unexpired download ticket answers preview BUSY and logs the busy stage", async () => {
	expect((await createBundle({})).ok).toBe(true);
	await expect(previewBundle()).rejects.toMatchObject({
		code: "BUSY",
		message: "BUSY",
		reason: "busy",
	});
	expect(refusals()).toEqual([
		[REFUSED, { module: "device-logs", operation: "preview", stage: "busy" }],
	]);
});

test("a clear that aborts a running preview reports the abort stage and frees sharing", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const pending = previewBundle();
	await entered.promise;
	const clearing = abortLogBundles();
	release.resolve();
	await clearing;
	await expect(pending).rejects.toMatchObject({
		code: "READ_FAILED",
		reason: "abort",
	});
	fixture.scan.mockImplementation(journal([]));
	expect((await previewBundle()).exportedBy.bootId).toBe(bootId);
	expect(refusals()).toEqual([
		[REFUSED, { module: "device-logs", operation: "preview", stage: "abort" }],
	]);
});

test("a history clear that outlasts the sixty-second budget reports the deadline stage", async () => {
	const gate = Promise.withResolvers<void>();
	const clearing = spyOn(settings, "historyClearing").mockReturnValue(
		gate.promise,
	);
	const timers = spyOn(globalThis, "setTimeout");
	try {
		const pending = previewBundle();
		const budget = timers.mock.calls.find(
			([, delay]) => delay === BUNDLE_TIME_MS,
		);
		if (typeof budget?.[0] !== "function")
			throw new Error("missing bundle time budget");
		budget[0]();
		await expect(pending).rejects.toMatchObject({
			code: "READ_FAILED",
			reason: "deadline",
		});
		expect(collect).not.toHaveBeenCalled();
	} finally {
		gate.resolve();
		clearing.mockRestore();
		timers.mockRestore();
	}
});

test("a journal page the reader refuses cuts the journal short but never fails the preview", async () => {
	fixture.scan.mockRejectedValue(
		new JournalReadError(
			"READ_FAILED",
			"No journal files were opened due to insufficient permissions.",
		),
	);
	const manifest = await previewBundle();
	expect(manifest.sections.at(-1)).toEqual({
		id: "journal",
		entries: 0,
		redactions: 0,
		bootsCovered: 0,
		complete: false,
	});
	expect(refusals()).toEqual([]);
});
