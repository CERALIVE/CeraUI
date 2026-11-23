import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import { scanSupportBundle } from "./helpers/support-bundle-scan.ts";

const bootId = "ea318275064912837fa3c9d0b1e2f4ac";
const unknownBoot = "ef490154203237518fa3c9d0b1e2f4ac";
const cursor = `s=${"a".repeat(32)};i=1;b=${bootId};m=0;t=1a;x=c720381946205537`;
const context = {
	bootId,
	ceraui: "2026.11.5",
	osImage: null,
	slot: null,
	board: null,
	boardModel: null,
	engine: null,
	senderVersion: null,
	kernel: null,
	bun: null,
};
const exportedBy = { section: "versions", exportedBy: context };
const versions = { section: "versions", bootId, versions: null };
const settings = {
	section: "settings",
	logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
	state: { historyEpoch: 0, lastClearedAt: null, lastMaintenance: null },
	updateChannel: "stable",
	autostart: null,
	hardwareKind: "generic",
	data: null,
};
const end = { section: "end", complete: true };
const journal = (entry: Record<string, unknown>) => ({
	section: "journal",
	entry: {
		bootId,
		cursor,
		ts: 1,
		level: "info",
		source: "app",
		unit: "example.service",
		message: "",
		marker: null,
		truncated: false,
		...entry,
	},
});
const incomplete = { section: "journal", incomplete: "size_limit" };
const stopped = { ...end, complete: false };
const event = (code: string, params: Record<string, unknown>) => ({
	section: "events",
	event: {
		id: "event-1",
		seq: 1,
		at: 1,
		bootId,
		code,
		family: "network",
		severity: "warning",
		params,
	},
});

test.each([
	["missing timestamp", [settings, journal({ ts: undefined }), end], 2],
	["string timestamp", [settings, journal({ ts: "1" }), end], 2],
	["missing boot ID", [settings, journal({ bootId: undefined }), end], 1],
	["null cursor", [settings, journal({ cursor: null }), end], 1],
	["unknown entry field", [settings, journal({ unexpected: true }), end], 2],
	[
		"entry and incomplete marker",
		[settings, { ...journal({}), incomplete: "size_limit" }, end],
		2,
	],
	[
		"entry after incomplete marker",
		[settings, incomplete, journal({}), stopped],
		2,
	],
	["entry before settings", [journal({}), settings, end], 4],
	[
		"entry in another section",
		[settings, { ...journal({}), section: "events" }, end],
		2,
	],
	[
		"foreign or unknown section",
		[settings, { ...journal({}), section: "foreign" }, end],
		2,
	],
	["no journal payload", [settings, { section: "journal" }, end], 0],
] as const)("denies cursor authority for %s", (_name, rows, numericId) => {
	const result = scanSupportBundle(
		[exportedBy, versions, ...rows]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	expect(result.exemptNumeric).toBe(_name === "entry before settings" ? 0 : 2);
	expect(result.counts.numericId).toBe(numericId);
	expect(result.counts.invalidRecord).toBeGreaterThan(0);
});

test("flags a cursor without decimal runs copied into valid non-journal free text", () => {
	const foreignCursor = cursor
		.replace(bootId, "f".repeat(32))
		.replace(/x=.+$/, "x=aa");
	const result = scanSupportBundle(
		[
			exportedBy,
			versions,
			settings,
			event("link_down", { detail: `copied ${foreignCursor}` }),
			end,
		]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	expect(result.counts).toMatchObject({
		numericId: 0,
		boot: 1,
		invalidRecord: 0,
	});
});

test("permits a well-formed journal entry before the terminal incomplete marker", () => {
	const result = scanSupportBundle(
		[exportedBy, versions, settings, journal({}), incomplete, stopped]
			.map((row) => JSON.stringify(row))
			.join("\n"),
	);
	expect(result.exemptNumeric).toBe(5);
	expect(result.counts).toMatchObject({
		numericId: 0,
		boot: 0,
		invalidRecord: 0,
	});
});

test.each([
	"4001::7%wan-8.8.8.8",
	"::ffff:192.168.1.2%wan-8.8.8.8",
	"https://[::FFFF:C0A8:102%25wan-8.8.8.8]:9000",
])(
	"finds public IPv4 in a zone exactly where the shipped redactor masks it: %s",
	(message) => {
		const masked = buildRedactor([]).text(message);
		expect(masked).toEqual({
			text: message.replace("8.8.8.8", "[IP]"),
			redactions: 1,
		});
		const scan = (text: string) =>
			scanSupportBundle(
				[exportedBy, versions, settings, journal({ message: text }), end]
					.map((row) => JSON.stringify(row))
					.join("\n"),
			).counts;
		expect(scan(message)).toMatchObject({ ipv4: 1, ipv6: 0, invalidRecord: 0 });
		expect(scan(masked.text)).toMatchObject({
			ipv4: 0,
			ipv6: 0,
			invalidRecord: 0,
		});
	},
);

test("scans all decoded gzip records and reports only counts, never values", async () => {
	const records = [
		exportedBy,
		versions,
		settings,
		event("device_started", {
			previousBootId: bootId,
			"490154203237518": true,
			apiKey: "planted-key",
		}),
		journal({
			message: [
				"490154203237518 8934071100276980483",
				"Bearer fake-token eyJabc.def.ghi v4.public.abc_DEF-123",
				"password=unheld-value",
				"-----BEGIN OPENSSH PRIVATE KEY-----",
				"8.8.8.8 [2001:db8::3]:9000 aa:bb:cc:dd:ee:ff",
				"10.0000, -20.12345",
				"ssid=example hostname=example serial=example",
				`boot_id=${unknownBoot}`,
			].join("\n"),
		}),
		end,
	];
	const gzip = Buffer.concat(
		records.map((record) => gzipSync(`${JSON.stringify(record)}\n`)),
	);
	const ndjson = await new Response(
		new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();

	expect(scanSupportBundle(ndjson, ["c720381946205537"])).toEqual({
		records: 6,
		exemptNumeric: 7,
		counts: {
			numericId: 2,
			iccid: 1,
			heldValue: 1,
			credentialField: 2,
			bearer: 1,
			jwt: 1,
			paseto: 1,
			apiKey: 0,
			sshKey: 1,
			ipv4: 1,
			ipv6: 1,
			mac: 1,
			gps: 1,
			ssid: 1,
			hostname: 1,
			serial: 1,
			subscriber: 0,
			boot: 1,
			duplicateMember: 0,
			invalidRecord: 0,
		},
	});
});

test.each([
	["zero-padded", cursor.replace("i=1", "i=01"), bootId, 1],
	["wrong boot", cursor.replace(`b=${bootId}`, `b=${unknownBoot}`), bootId, 1],
	["uppercase", cursor.replace("x=c", "x=C"), bootId, 1],
	["not backed by version metadata", cursor, unknownBoot, 2],
])("does not exempt a %s cursor", (_reason, value, entryBoot, cursorHits) => {
	const result = scanSupportBundle(
		[
			exportedBy,
			versions,
			settings,
			journal({ bootId: entryBoot, cursor: value }),
			end,
		]
			.map((record) => JSON.stringify(record))
			.join("\n"),
	);
	expect(result.counts).toMatchObject({
		numericId: cursorHits,
		boot: entryBoot === unknownBoot ? 2 : 1,
	});
});

const previous = "b".repeat(32);
const previousVersions = { ...versions, bootId: previous };
const previousEntry = journal({
	bootId: previous,
	cursor: cursor.replace(`b=${bootId}`, `b=${previous}`),
});
const running = "d".repeat(32);
const exporter = { ...exportedBy, exportedBy: { ...context, bootId: running } };
const runningVersions = { ...versions, bootId: running };

test.each([
	[
		"missing per-boot record",
		[exporter, runningVersions, settings, previousEntry],
	],
	[
		"missing exporter context",
		[runningVersions, previousVersions, settings, previousEntry],
	],
	[
		"missing versions payload",
		[
			exporter,
			runningVersions,
			{ section: "versions", bootId: previous },
			settings,
			previousEntry,
		],
	],
	[
		"invalid nested context",
		[
			exporter,
			runningVersions,
			{ ...previousVersions, versions: { bootId: previous } },
			settings,
			previousEntry,
		],
	],
	[
		"numeric version string",
		[
			exporter,
			runningVersions,
			{
				...previousVersions,
				versions: { ...context, bootId: previous, ceraui: 2026 },
			},
			settings,
			previousEntry,
		],
	],
	[
		"mismatched nested boot",
		[
			exporter,
			runningVersions,
			{ ...previousVersions, versions: exporter.exportedBy },
			settings,
			previousEntry,
		],
	],
	[
		"hybrid exporter and boot row",
		[
			exporter,
			runningVersions,
			{ ...previousVersions, exportedBy: {} },
			settings,
			previousEntry,
		],
	],
	[
		"duplicate per-boot record",
		[
			exporter,
			runningVersions,
			previousVersions,
			previousVersions,
			settings,
			previousEntry,
		],
	],
	[
		"duplicate exporter context",
		[
			exporter,
			exporter,
			runningVersions,
			previousVersions,
			settings,
			previousEntry,
		],
	],
	[
		"previous boot before current boot",
		[exporter, previousVersions, runningVersions, settings, previousEntry],
	],
	[
		"boot metadata after settings",
		[exporter, runningVersions, settings, previousVersions, previousEntry],
	],
	[
		"boot metadata after journal",
		[exporter, runningVersions, settings, previousEntry, previousVersions],
	],
	[
		"late duplicate",
		[
			exporter,
			runningVersions,
			previousVersions,
			settings,
			previousEntry,
			previousVersions,
		],
	],
] as const)("flags a cursor with %s", (_reason, records) => {
	const result = scanSupportBundle(
		[...records, end].map((record) => JSON.stringify(record)).join("\n"),
	);
	expect(result.counts.numericId).toBe(1);
	expect(result.exemptNumeric).toBe(0);
	expect(result.counts.boot).toBeGreaterThanOrEqual(1);
});

test("accepts the previous boot only when its ordered per-boot context backs the cursor", () => {
	const result = scanSupportBundle(
		[
			exportedBy,
			versions,
			{ ...previousVersions, versions: { ...context, bootId: previous } },
			settings,
			previousEntry,
			end,
		]
			.map((record) => JSON.stringify(record))
			.join("\n"),
	);
	expect(result.counts).toMatchObject({ boot: 0, numericId: 0 });
	expect(result.exemptNumeric).toBe(3);
});

test.each([
	[
		"conflicting boot ID",
		`{"section":"versions","bootId":"${running}","bootId":"${previous}","versions":null}`,
		5,
	],
	[
		"escaped duplicate key",
		String.raw`{"section":"versions","bootId":"${previous}","boot\u0049d":"${previous}","versions":null}`,
		5,
	],
	[
		"hidden malformed context",
		`{"section":"versions","bootId":"${previous}","versions":{},"versions":null}`,
		5,
	],
	[
		"overwritten section",
		`{"section":"events","section":"versions","bootId":"${previous}","versions":null}`,
		5,
	],
	[
		"duplicate nested field",
		`{"section":"versions","bootId":"${previous}","versions":{"ceraui":null,${JSON.stringify({ ...context, bootId: previous }).slice(1)}}`,
		6,
	],
])("flags a cursor backed by a row with %s", (_reason, row, boot) => {
	const result = scanSupportBundle(
		[
			JSON.stringify(exporter),
			JSON.stringify(runningVersions),
			row,
			...[settings, previousEntry, end].map((record) => JSON.stringify(record)),
		].join("\n"),
	);
	expect(result.exemptNumeric).toBe(0);
	expect(result.counts).toMatchObject({
		numericId: 1,
		boot,
		duplicateMember: 1,
	});
});

test("does not confuse keys in separate nested objects or quoted text with duplicates", () => {
	const result = scanSupportBundle(
		[
			JSON.stringify(exporter),
			JSON.stringify(runningVersions),
			String.raw`{ "section" : "versions", "boot\u0049d": "${previous}", "versions": null }`,
			JSON.stringify(settings),
			JSON.stringify({
				section: "events",
				event: {
					...event("link_down", { note: '{"flag":1,"flag":2}', id: "other" })
						.event,
					bootId: running,
				},
			}),
			JSON.stringify(previousEntry),
			JSON.stringify(end),
		].join("\n"),
	);
	expect(result.exemptNumeric).toBe(1);
	expect(result.counts).toMatchObject({
		numericId: 0,
		boot: 0,
		duplicateMember: 0,
		invalidRecord: 0,
	});
});

test("limits boot exceptions to authorized paths and leaves local addresses and masks alone", () => {
	const records = [
		exportedBy,
		{ section: "versions", bootId, versions: context },
		settings,
		event("previous_boot_unclean", { bootId }),
		event("link_down", {
			previousBootId: bootId,
			extra: [cursor, "imei=1234", `sk_live_${"x".repeat(24)}`],
			sample: 490154203237518,
		}),
		{ section: "events", boot: { bootId, versions: context, startedAt: 1 } },
		journal({
			message:
				"192.168.1.10 100.127.255.255 ::1 [fe80::1%eth0] fd00::1 ::ffff:192.168.1.10 aa:bb:cc:**:**:** password=[REDACTED:ssh]",
		}),
		{ ...end, "entry.cursor": "490154203237518" },
	];
	const result = scanSupportBundle(
		records.map((record) => JSON.stringify(record)).join("\n"),
	);
	expect(result).toMatchObject({
		records: 8,
		exemptNumeric: 11,
		counts: {
			numericId: 4,
			boot: 2,
			ipv4: 0,
			ipv6: 0,
			mac: 0,
			credentialField: 0,
			apiKey: 1,
			subscriber: 1,
		},
	});
});

test.each([
	["server:2001:db8::1", 1],
	["2000::", 1],
	["3FFF:0:0:0:0:0:0:a", 1],
	["2600:1::abcd", 1],
	["2001:db8::192.168.1.10", 1],
	["2001:db8::8.8.8.8", 1],
	["2001:db8::1%eth0", 1],
	["https://[2001:db8::1%25wwan0]:8080/p", 1],
	["peer 2001:db8::1.", 1],
	["::ffff:8.8.8.8", 1],
	["[64:ff9b::1.1.1.1]:9000", 1],
	["::FFFF:808:808", 1],
	["0064:ff9b:0:0:0:0:0101:0101", 1],
	["[fe80::1%eth0]:9000", 0],
	["fe80::1%wan-8.8.8.8", 0],
	["fd00::8.8.8.8", 0],
	["::1", 0],
	["4000::1", 0],
	["4001:2::8.8.4.4.,", 0],
	["::ffff:10.0.0.1", 0],
	["::ffff:6440:1", 0],
	["64:ff9b::192.168.0.1", 0],
	["::ffff:808", 0],
] as const)(
	"classifies IPv6 like the support bundle redactor: %s",
	(message, ipv6) => {
		const result = scanSupportBundle(
			[exportedBy, versions, settings, journal({ message }), end]
				.map((record) => JSON.stringify(record))
				.join("\n"),
		);
		expect(result.counts).toMatchObject({
			ipv6,
			ipv4: 0,
			mac: 0,
			invalidRecord: 0,
		});
	},
);

test("scans the original spelling of JSON numbers", () => {
	expect(
		scanSupportBundle(
			'{"section":"settings","sample":8934071100276980483}\n{"section":"end","complete":true}\n',
		).counts.iccid,
	).toBe(1);
});

test.each([
	['{"section":"end","complete":true}\nnot-json', 2],
	['{"section":"settings"}', 2],
])(
	"refuses malformed or unterminated NDJSON without echoing it",
	(ndjson, line) => {
		expect(() => scanSupportBundle(ndjson)).toThrow(
			`Invalid support bundle at line ${line}`,
		);
	},
);
