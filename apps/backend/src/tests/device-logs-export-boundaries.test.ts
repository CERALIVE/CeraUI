import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as config from "../modules/config.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import {
	handleIngestSlots,
	resetIngestSlots,
} from "../modules/remote-control/ingest-slots.ts";
import * as context from "../modules/system/version-context.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

let fixture: ReturnType<typeof queryFixture>;
let credentials: ReturnType<typeof spyOn<typeof config, "getConfig">>;
let versions: ReturnType<typeof spyOn<typeof context, "collectVersionContext">>;
beforeEach(() => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([]));
	credentials = spyOn(config, "getConfig").mockReturnValue({});
	versions = spyOn(context, "collectVersionContext").mockResolvedValue({
		bootId,
		osImage: null,
		slot: null,
		board: null,
		boardModel: null,
		ceraui: "fixture",
		engine: null,
		senderVersion: null,
		kernel: null,
		bun: null,
	});
});
afterEach(async () => {
	await abortLogExports();
	resetIngestSlots();
	versions.mockRestore();
	credentials.mockRestore();
	fixture.restore();
});

async function openExport(conn = {}) {
	const issued = await createExport(conn, { boot: "all", filter: {} });
	if (!issued.ok) throw new Error(issued.error);
	return handleLogExportRequest(new Request(`http://device${issued.url}`));
}

test("a nonselected key from the managed ingest store is masked", async () => {
	const key = "fixture-managed-ingest-key";
	expect(
		handleIngestSlots({
			slots: [
				{
					endpointId: "other-slot",
					host: "relay.example.test",
					port: 5000,
					protocol: "srtla",
					streamId: key,
					obsInstanceId: null,
				},
			],
		}),
	).toHaveLength(1);
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: `ingest ${key}` })]),
	);
	const text = await (await openExport()).text();
	expect(text).not.toContain(key);
	expect(text).toContain("ingest [REDACTED:ingest_key]");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a selected short ingest key blocks even when the managed cache is cold", async () => {
	credentials.mockReturnValue({
		selected_ingest_endpoint: "cold-slot",
		srt_streamid: "k9",
	});
	const reply = await createExport({}, { boot: "all", filter: {} });
	if (!reply.ok) throw new Error(reply.error);
	const text = await (
		await handleLogExportRequest(new Request(`http://device${reply.url}`))
	).text();
	expect(text).toBe("# incomplete: CREDENTIAL_TOO_SHORT (ingest_key)\n");
});

test("an arbitrary manual receiver's short stream ID cannot be assumed public", async () => {
	credentials.mockReturnValue({
		srtla_addr: "receiver.example.test",
		srt_streamid: "k9",
	});
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "custom key k9" })]),
	);
	expect(await (await openExport()).text()).toBe(
		"# incomplete: CREDENTIAL_TOO_SHORT (ingest_key)\n",
	);
});

test("the loopback E2E seed still exports its ordinary short stream ID", async () => {
	credentials.mockReturnValue({
		srtla_addr: "127.0.0.1",
		srtla_port: 5000,
		srt_streamid: "e2e",
	});
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "seed e2e" })]),
	);
	const text = await (await openExport()).text();
	expect(text).toContain("seed e2e");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("binary multiline messages redact across the journal byte cutoff", async () => {
	const key = "fixture-crosses-cutoff-long-secret-value";
	const prefix = "x".repeat(16 * 1024 - 30);
	credentials.mockReturnValue({ remote_key: key });
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				MESSAGE: [...Buffer.from(`first\n${prefix}${key}\nlast`)],
			}),
		]),
	);
	const text = await (await openExport()).text();
	expect(text).not.toContain(key.slice(0, 16));
	expect(text).toContain(`first\n    ${prefix}[REDACTED:remote_key]`);
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a journal unit does not leak the credential prefix left by service suffix stripping", async () => {
	credentials.mockReturnValue({ remote_key: "fixture-unit.service" });
	fixture.scan.mockImplementation(
		journal([record(1, { _SYSTEMD_UNIT: "fixture-unit.service" })]),
	);
	const text = await (await openExport()).text();
	expect(text).not.toContain("fixture-unit");
	expect(text).toContain("[REDACTED:remote_key]: entry 1");
});

test("an inventory change during journal reading prevents that page from being released", async () => {
	const key = "fixture-rotated-during-read";
	const page = journal([record(1, { MESSAGE: `configured ${key}` })]);
	fixture.scan.mockImplementation(async (scan) => {
		credentials.mockReturnValue({ remote_key: key });
		return page(scan);
	});
	const text = await (await openExport()).text();
	expect(text).not.toContain(key);
	expect(text).toEndWith("# incomplete: CREDENTIALS_CHANGED\n");
});

test("an in-progress export cannot be replaced and the next export reads fresh credentials", async () => {
	fixture.scan.mockImplementation(journal([record(1)]));
	const response = await openExport();
	expect(await createExport({}, { boot: "all", filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	expect(await response.text()).toEndWith("# complete: 1 entries\n");
	const key = "fixture-new-export-secret";
	credentials.mockReturnValue({ remote_key: key });
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: key })]));
	const text = await (await openExport()).text();
	expect(text).not.toContain(key);
	expect(text).toEndWith("# complete: 1 entries\n");
});

test.each([
	["line wrapping", "fixture-abcd", "fixture-\nabcd"],
	["zero-width insertion", "fixture-abcd", "fixture-\u200babcd"],
	["mixed Unicode normalization", "fixture-caféé", "fixture-caf\u0065\u0301é"],
	[
		"HTML named/numeric entities",
		"fixture-<key>&",
		"fixture-&lt;k&#x65;y&gt;&amp;",
	],
	["partial URL encoding", "fixture-x:é", "fixture-%78%3a%C3%a9"],
	["URL form spaces", "fixture key:val", "fixture+key%3Aval"],
	[
		"padded base64url",
		"a ~?>> x",
		`${Buffer.from("a ~?>> x").toString("base64url")}=`,
	],
])(
	"does not emit a held credential rendered as %s",
	async (_label, key, encoded) => {
		credentials.mockReturnValue({ remote_key: key });
		fixture.scan.mockImplementation(
			journal([record(1, { MESSAGE: `prefix ${encoded} tail` })]),
		);
		const text = await (await openExport()).text();
		expect(text).not.toContain(encoded.replace(/\n/g, "\n    "));
		expect(text).not.toContain("[REDACTED:remote_key]=");
		expect(text).toEndWith("# complete: 1 entries\n");
	},
);

test("a held credential cannot be reconstructed by joining the unit and message", async () => {
	credentials.mockReturnValue({ remote_key: "fixture-join-halves" });
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_SYSTEMD_UNIT: "fixture-join-.service",
				MESSAGE: "halves",
			}),
		]),
	);
	const text = await (await openExport()).text();
	expect(text).not.toContain("fixture-join-");
	expect(text).not.toContain("halves");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a credential formed across serialized filter values is withheld", async () => {
	const key = 'error","info';
	credentials.mockReturnValue({ remote_key: key });
	fixture.scan.mockImplementation(journal([record(1)]));
	const reply = await createExport(
		{},
		{ boot: "all", filter: { levels: ["error", "info"] } },
	);
	if (!reply.ok) throw new Error(reply.error);
	const text = await (
		await handleLogExportRequest(new Request(`http://device${reply.url}`))
	).text();
	expect(text).not.toContain(key);
	const filter = text.split("\n").find((line) => line.startsWith("# filter: "));
	expect(JSON.parse(filter?.slice("# filter: ".length) ?? "")).toEqual({
		sources: [],
		levels: "[REDACTED]",
	});
});

test("replacement markers cannot reintroduce a held value into an entry", async () => {
	credentials.mockReturnValue({
		remote_key: "fixture-secret",
		pairing_secret: "REDACTED",
	});
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "fixture-secret" })]),
	);
	const text = await (await openExport()).text();
	expect(
		text.split("\n").find((line) => line.includes(" INFO ")),
	).not.toContain("REDACTED");
	expect(text).not.toContain("fixture-secret");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test.each([
	{
		label: "pairing key in a path",
		config: { pairing_secret: "Qk+9xZr/7mWq3Tz+Lp0aB8vN2cY4dHs6fJ1gK5uE+o0=" },
		message: "GET /claim/Qk+9xZr%2F7mWq3Tz+Lp0aB8vN2cY4dHs6fJ1gK5uE+o0=",
	},
	{
		label: "password plus between percent-escaped spaces",
		config: { ssh_pass: "my pass+word 42" },
		message: "p=my%20pass+word%2042",
	},
	{
		label: "encodeURI with a literal plus and slash",
		config: { remote_key: "Fx+pw 77/Lm-Q" },
		message: "u=Fx+pw%2077/Lm-Q",
	},
	{
		label: "encodeURI with a literal plus and escaped percent",
		config: { remote_key: "Fx+pw%77Lm-Qz" },
		message: "u=Fx+pw%2577Lm-Qz",
	},
])(
	"redacts $label without treating the plus as a form space",
	async ({ config, message }) => {
		credentials.mockReturnValue(config);
		fixture.scan.mockImplementation(
			journal([
				record(1, { MESSAGE: message }),
				record(2, { MESSAGE: "unrelated log entry" }),
			]),
		);
		const text = await (await openExport()).text();
		expect(text).not.toContain(message);
		expect(text).toContain("[REDACTED]");
		expect(text).toContain("ceralive: unrelated log entry");
		expect(text).toEndWith("# complete: 2 entries\n");
	},
);
