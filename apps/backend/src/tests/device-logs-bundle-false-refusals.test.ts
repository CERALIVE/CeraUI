import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { deviceEventSchema } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import {
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

// sd_journal_get_cursor's exact shape; its xor hash holds exactly fifteen
// decimal digits, as 30 of 50,000 cursors sampled on one systemd 262 host did.
const nativeCursor = (boot: string, seqnum = "1b2f4") =>
	`s=3f1c9b0e8a7d4c2f9e6b5a4d3c2b1a09;i=${seqnum};b=${boot};m=2c41a8f3;t=6447a1c3e5f20;x=c720381946205537`;
// The same digit run in a boot ID (about one random ID in 390).
const uncleanBoot = "ea318275064912837fa3c9d0b1e2f4ac";

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

const refusals = () =>
	warn.mock.calls.filter(
		(call) => (call as unknown[])[0] === "Support bundle preparation refused",
	);

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
		family: "device",
		severity: "info",
		params,
	});
}

const uncleanPrevious = (events: ReturnType<typeof event>[]) => {
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
		events,
	};
};

test("a native journald cursor whose xor hash holds fifteen decimal digits survives preview and download", async () => {
	const cursor = nativeCursor(bootId);
	fixture.scan.mockImplementation(journal([record(1, { __CURSOR: cursor })]));
	expect((await previewBundle()).sections.at(-1)).toEqual({
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

test("an identifier in the message of an entry with a native cursor is still masked", async () => {
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				__CURSOR: nativeCursor(bootId),
				MESSAGE: "modem 867400050512345 registered",
			}),
		]),
	);
	expect((await previewBundle()).sections.at(-1)).toMatchObject({
		entries: 1,
		redactions: 1,
	});
	const text = await download();
	expect(text).toContain('"message":"modem [ID] registered"');
	expect(text).not.toContain("867400050512345");
});

test.each([
	[
		"a held secret inside a native cursor",
		nativeCursor(bootId),
		[{ kind: "router_password", value: "1946" }],
		"collision",
	],
	[
		"a native cursor naming another boot",
		nativeCursor("b".repeat(32)),
		[],
		"pattern",
	],
	[
		"a zero-padded cursor journald never emits",
		nativeCursor(bootId, "01b2f4"),
		[],
		"pattern",
	],
] as const)(
	"%s still refuses, with a sanitized stage",
	async (_name, cursor, secrets, stage) => {
		source = { ...source, secrets: [...secrets] };
		fixture.scan.mockImplementation(journal([record(1, { __CURSOR: cursor })]));
		await expect(previewBundle()).rejects.toMatchObject({
			code: "READ_FAILED",
			message: "READ_FAILED",
			reason: stage,
		});
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	},
);

test("an unclean previous boot whose ID holds fifteen decimal digits still previews and downloads", async () => {
	uncleanPrevious([
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
	]);
	expect((await previewBundle()).boots.map((boot) => boot.bootId)).toEqual([
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

test.each([
	[
		"a boot the device never recorded",
		() => {
			source = {
				...source,
				events: [
					event("previous_boot_unclean", {
						bootId: uncleanBoot,
						evidence: ["no_shutdown_markers"],
					}),
				],
			};
		},
	],
	[
		"a known boot in a parameter of another event",
		() => uncleanPrevious([event("future_event", { bootId: uncleanBoot })]),
	],
] as const)(
	"an event boot field naming %s keeps its pattern check",
	async (_name, arrange) => {
		arrange();
		await expect(previewBundle()).rejects.toMatchObject({
			code: "READ_FAILED",
			reason: "pattern",
		});
	},
);
