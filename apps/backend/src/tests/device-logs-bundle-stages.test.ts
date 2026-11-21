import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { deviceEventSchema } from "@ceraui/rpc/schemas";
import * as logging from "../helpers/logger.ts";
import {
	abortLogBundles,
	createBundle,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { abortLogExports } from "../modules/device-logs/export.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import * as settings from "../modules/device-logs/settings.ts";
import { bootId, journal, queryFixture } from "./helpers/device-query.ts";

const REFUSED = "Support bundle preparation refused";

let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let warn: ReturnType<typeof spyOn<typeof logging.logger, "warn">>;
let source: Awaited<ReturnType<typeof data.collectBundleData>>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	jest.useFakeTimers({ now: 1_700_000_000_000 });
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
	jest.useRealTimers();
	await abortLogExports();
	collect.mockRestore();
	warn.mockRestore();
	fixture.restore();
});

const refusals = (): unknown[][] =>
	warn.mock.calls
		.map((call): unknown[] => [...call])
		.filter(([message]) => message === REFUSED);

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
					deviceEventSchema.parse({
						id: "aaaaaaaa-1",
						seq: 1,
						bootId,
						at: 1,
						code: "modem_added",
						family: "cellular",
						severity: "info",
						params: {
							modemKey: "usb-1-1.2",
							name: "Quectel EM12-G 867400050512345",
						},
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
	try {
		const pending = previewBundle();
		jest.advanceTimersByTime(59_999);
		expect(collect).not.toHaveBeenCalled();
		jest.advanceTimersByTime(1);
		await expect(pending).rejects.toMatchObject({
			code: "READ_FAILED",
			reason: "deadline",
		});
		expect(collect).not.toHaveBeenCalled();
	} finally {
		gate.resolve();
		clearing.mockRestore();
	}
});

test("a journal page the reader refuses cuts the journal short but never fails the preview", async () => {
	fixture.scan.mockRejectedValue(
		new JournalReadError(
			"READ_FAILED",
			"No journal files were opened due to insufficient permissions.",
		),
	);
	expect((await previewBundle()).sections.at(-1)).toEqual({
		id: "journal",
		entries: 0,
		redactions: 0,
		bootsCovered: 0,
		complete: false,
	});
	expect(refusals()).toEqual([]);
});
