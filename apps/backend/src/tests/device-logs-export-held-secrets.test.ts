import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type LogExportInput,
	logQueryInputSchema,
	type VersionContext,
} from "@ceraui/rpc/schemas";
import { setCredentialStoreState } from "../helpers/credential-store-state.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { exportHeader } from "../modules/device-logs/export-format.ts";
import { buildRedactor } from "../modules/device-logs/redaction.ts";
import {
	initModemCredentials,
	resetModemCredentialsForTest,
} from "../modules/modems/modem-credentials.ts";
import * as versions from "../modules/system/version-context.ts";
import {
	initHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

// Quote, backslash and spaces give distinct JSON and percent forms; its base64
// holds "+", so base64url differs too.
const secret = 'held "key"\\ ~?>> x';
const jsonForm = JSON.stringify(secret).slice(1, -1);
const percentForm = encodeURIComponent(secret);
const lowerPercentForm = percentForm.replace(/%[0-9A-F]{2}/g, (hex) =>
	hex.toLowerCase(),
);
const base64Form = Buffer.from(secret).toString("base64");
const base64UrlForm = Buffer.from(secret).toString("base64url");
const currentVersions: VersionContext = {
	bootId,
	osImage: "current-os",
	slot: "A",
	board: "board",
	boardModel: null,
	ceraui: "ui",
	engine: "engine",
	senderVersion: "sender",
	kernel: "kernel",
	bun: "bun",
};
let fixture: ReturnType<typeof queryFixture>;
let held: ReturnType<typeof spyOn<typeof data, "collectHeldSecrets">>;
let context: ReturnType<typeof spyOn<typeof versions, "collectVersionContext">>;
let boot: ReturnType<typeof spyOn<typeof identity, "currentBootId">>;
let storeDir: string;
beforeEach(() => {
	storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-stores-"));
	boot = spyOn(identity, "currentBootId").mockReturnValue(bootId);
	fixture = queryFixture();
	held = spyOn(data, "collectHeldSecrets").mockReturnValue([
		{ kind: "key", value: secret },
	]);
	context = spyOn(versions, "collectVersionContext").mockResolvedValue(
		currentVersions,
	);
});
afterEach(async () => {
	await abortLogExports();
	boot.mockRestore();
	context.mockRestore();
	held.mockRestore();
	fixture.restore();
	resetHotspotCredentialsForTest();
	resetModemCredentialsForTest();
	fs.rmSync(storeDir, { recursive: true, force: true });
});
async function download(input: LogExportInput = { filter: {} }) {
	const created = await createExport({}, input);
	if (!created.ok) throw new Error(created.error);
	return (
		await handleLogExportRequest(new Request(`http://device${created.url}`))
	).text();
}

test("held credentials are redacted from every exported line, in any unit and encoding", async () => {
	expect(new Set([secret, jsonForm, percentForm, lowerPercentForm]).size).toBe(
		4,
	);
	expect(base64Form).not.toBe(base64UrlForm);
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: `caller uri ?passphrase=${secret}&latency=120` }),
			record(2, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: `json ${JSON.stringify({ key: secret })} uri ${percentForm} lower ${lowerPercentForm}`,
			}),
			record(3, { MESSAGE: `first line\nsecond ${secret} line` }),
			record(4, { MESSAGE: `b64 ${base64Form} b64url ${base64UrlForm}` }),
			record(5, { MESSAGE: "nothing held here" }),
		]),
	);
	const text = await download();
	for (const form of [
		secret,
		jsonForm,
		percentForm,
		lowerPercentForm,
		base64Form,
		base64UrlForm,
	])
		expect(text).not.toContain(form);
	expect(text).toContain("caller uri ?passphrase=[REDACTED:key]&latency=120");
	expect(text).toContain(
		'srtla-send: json {"key":"[REDACTED:key]"} uri [REDACTED:key] lower [REDACTED:key]',
	);
	expect(text).toContain("second [REDACTED:key] line");
	expect(text).toContain("b64 [REDACTED:key] b64url [REDACTED:key]");
	expect(text).toContain("nothing held here");
	expect(text).toEndWith("# complete: 5 entries\n");
});

test("a held credential that spans the unit and the message is redacted on the formatted line", async () => {
	held.mockReturnValue([{ kind: "key", value: "srtla-send: cross" }]);
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_SYSTEMD_UNIT: "srtla-send.service",
				MESSAGE: "cross field",
			}),
		]),
	);
	const text = await download();
	expect(text).not.toContain("srtla-send: cross");
	expect(text).toContain("INFO    [REDACTED:key] field\n");
});

test("a held credential typed into the search filter is redacted from the header", async () => {
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: secret })]));
	const text = await download({ filter: { text: secret } });
	expect(text).not.toContain(secret);
	expect(text).not.toContain(jsonForm);
	expect(text).toContain('"text":"[REDACTED:key]"');
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a header value that JSON escaping turns into a held credential is replaced whole", async () => {
	// A backslash and "n": the escaped form of a line break in the filter text
	// or a version string. The unescaped values match nothing held.
	held.mockReturnValue([
		{ kind: "key", value: "split\\nvalue" },
		{ kind: "key", value: "os\\timage" },
	]);
	context.mockResolvedValue({ ...currentVersions, osImage: "os\timage" });
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "split\nvalue" })]),
	);
	const text = await download({ filter: { text: "split\nvalue" } });
	expect(text).not.toContain("split\\nvalue");
	expect(text).not.toContain("os\\timage");
	expect(text).toContain('# filter: {"sources":[],"levels":[');
	expect(text).toContain('"text":"[REDACTED]"}\n');
	expect(text).toContain('# osImage: "[REDACTED]"\n');
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("numeric header values are checked as they are written", () => {
	const { known } = buildRedactor([{ kind: "key", value: "1234567" }]);
	const query = logQueryInputSchema.parse({ since: 1_700_001_234_567 });
	const header = exportHeader(currentVersions, [], query, 0, known);
	expect(header).not.toContain("1234567");
	expect(header).toContain('"since":"[REDACTED]"}\n');
});

test("a multi-line held credential is redacted before continuation lines are indented", async () => {
	const multiLine = "first-half-of-key\nsecond-half-of-key";
	held.mockReturnValue([{ kind: "key", value: multiLine }]);
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: `before ${multiLine} after` }),
			record(2, { _SYSTEMD_UNIT: `${multiLine}.service`, MESSAGE: "unit" }),
		]),
	);
	const text = await download();
	expect(text).not.toContain("first-half-of-key");
	expect(text).not.toContain("second-half-of-key");
	expect(text).toContain("before [REDACTED:key] after");
	expect(text).toEndWith("# complete: 2 entries\n");
});

test("an unreadable credential holder fails the export closed before any entry", async () => {
	held.mockImplementation(() => {
		throw new Error("Unsafe credential storage");
	});
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: secret })]));
	const text = await download();
	expect(text).toBe("# incomplete: READ_FAILED\n");
});

test("a held set the redactor refuses also fails the export closed", async () => {
	held.mockReturnValue([{ kind: "key", value: "x".repeat(65 * 1024) }]);
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	const text = await download();
	expect(text).toBe("# incomplete: READ_FAILED\n");
});

test("a credential store that exists but cannot be loaded fails the export closed", async () => {
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	// The real loaders: a missing file is an empty store, the export completes.
	await initHotspotCredentials(path.join(storeDir, "missing-hotspot.json"));
	await initModemCredentials(path.join(storeDir, "missing-modems.json"));
	expect(await download()).toEndWith("# complete: 1 entries\n");
	// A corrupt hotspot store: its passwords are unknown to the backend.
	const hotspot = path.join(storeDir, "hotspot.json");
	fs.writeFileSync(hotspot, "{ not json");
	await initHotspotCredentials(hotspot);
	expect(await download()).toBe("# incomplete: READ_FAILED\n");
	resetHotspotCredentialsForTest();
	// A modem store of the wrong shape: the same.
	const modems = path.join(storeDir, "modems.json");
	fs.writeFileSync(modems, JSON.stringify({ devices: "not a record" }));
	await initModemCredentials(modems);
	expect(await download()).toBe("# incomplete: READ_FAILED\n");
});

test("a password loaded from the real hotspot store is redacted", async () => {
	held.mockRestore();
	const hotspot = path.join(storeDir, "hotspot.json");
	fs.writeFileSync(
		hotspot,
		JSON.stringify({
			version: 2,
			adapters: {
				"02:00:00:00:00:01": { ssid: "box-ap", password: "loaded-wpa-key" },
			},
		}),
	);
	await initHotspotCredentials(hotspot);
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "psk=loaded-wpa-key" })]),
	);
	const text = await download();
	expect(text).not.toContain("loaded-wpa-key");
	expect(text).toContain("psk=[REDACTED:hotspot]");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a credential store that has not finished loading stops the export", async () => {
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: secret })]));
	for (const store of ["hotspot", "modem"] as const) {
		setCredentialStoreState(store, "pending");
		expect(await download({ filter: { text: secret } })).toBe(
			"# incomplete: CREDENTIALS_LOADING\n",
		);
		setCredentialStoreState(store, "ready");
	}
	// A failure wins over a store that is still loading.
	setCredentialStoreState("hotspot", "pending");
	setCredentialStoreState("modem", "failed");
	expect(await download()).toBe("# incomplete: READ_FAILED\n");
	setCredentialStoreState("hotspot", "ready");
	setCredentialStoreState("modem", "ready");
	expect(await download()).toEndWith("# complete: 1 entries\n");
});

const notRedactedLine = (kinds: string) =>
	`# not redacted, shorter than 4 characters: ${kinds}\n`;

test("a short stream ID does not stop the export, and the header names its kind only", async () => {
	// The desktop E2E seed and many real boxes use a stream ID like "e2e".
	held.mockReturnValue([
		{ kind: "stream", value: "e2e" },
		{ kind: "key", value: "abcd" },
	]);
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "stream e2e login abcd" })]),
	);
	const text = await download({ filter: { text: "e2e" } });
	expect(text).toContain(notRedactedLine("stream"));
	// The short value is sent as logged; longer held values are still replaced.
	expect(text).toContain("stream e2e login [REDACTED:key]");
	expect(text).not.toContain("abcd");
	expect(text).toContain('"text":"e2e"');
	expect(text).toEndWith("# complete: 1 entries\n");
	// Without a short value the header has no such line.
	held.mockReturnValue([{ kind: "stream", value: "e2e login" }]);
	const full = await download();
	expect(full).not.toContain("not redacted");
	expect(full).toContain("stream [REDACTED:stream] abcd");
});

test("the header lists every short identifier kind once, sorted, without values", async () => {
	const values = ["e2e", "cam", "w3b", "q", "adm", "s9"];
	held.mockReturnValue([
		{ kind: "stream", value: "e2e" },
		{ kind: "stream", value: "cam" },
		{ kind: "apn_user", value: "w3b" },
		{ kind: "apn_password", value: "q" },
		{ kind: "router_user", value: "adm" },
		{ kind: "serial", value: "s9" },
		{ kind: "stream", value: "" },
	]);
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	const text = await download();
	const line = text
		.split("\n")
		.find((candidate) => candidate.startsWith("# not redacted"));
	expect(`${line}\n`).toBe(
		notRedactedLine("apn_password, apn_user, router_user, serial, stream"),
	);
	for (const value of values) expect(line).not.toContain(value);
	// The line sits in the header, before the warning and the entries.
	expect(text.indexOf(line ?? "")).toBeLessThan(
		text.indexOf("# may contain sensitive data"),
	);
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("a short password or key still stops the export, naming the blocking kinds only", async () => {
	held.mockReturnValue([
		{ kind: "stream", value: "e2e" },
		{ kind: "apn_password", value: "x" },
		{ kind: "router_password", value: "ab1" },
		{ kind: "password", value: "pw" },
		{ kind: "key", value: "abcd" },
	]);
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "login ab1 pw e2e then abcd" })]),
	);
	// Neither an entry nor the filter text is sent, only the footer.
	expect(await download({ filter: { text: "ab1" } })).toBe(
		"# incomplete: CREDENTIAL_TOO_SHORT (password, router_password)\n",
	);
	// A kind not on the identifier list, including one added later, blocks.
	held.mockReturnValue([
		{ kind: "stream", value: "e2e" },
		{ kind: "future_secret", value: "zz" },
	]);
	expect(await download()).toBe(
		"# incomplete: CREDENTIAL_TOO_SHORT (future_secret)\n",
	);
	// Four characters is the shortest value the matcher replaces.
	held.mockReturnValue([{ kind: "password", value: "abcd" }]);
	const text = await download();
	expect(text).toContain("login ab1 pw e2e then [REDACTED:password]");
	expect(text).not.toContain("not redacted");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("only identifier-like kinds may be sent when short", () => {
	expect([...data.SHORT_VALUE_EXPORT_KINDS].sort()).toEqual([
		"apn_password",
		"apn_user",
		"router_user",
		"serial",
		"stream",
	]);
});

test("the header's fixed text is never altered by a held value that matches it", async () => {
	held.mockReturnValue([
		{ kind: "key", value: "newest first" },
		{ kind: "key", value: "review before sharing" },
		{ kind: "key", value: "exported-by" },
		{ kind: "key", value: "current-os" },
		{ kind: "key", value: '"levels":[' },
		{ kind: "key", value: "filter: {" },
	]);
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	const text = await download();
	expect(text).toStartWith("# exported-by\n");
	expect(text).toContain("# newest first\n");
	expect(text).toContain(
		"# may contain sensitive data: review before sharing\n",
	);
	expect(text).toContain('# filter: {"sources":[],"levels":["');
	// Values are still redacted.
	expect(text).toContain('# osImage: "[REDACTED:key]"\n');
	expect(text).not.toContain("current-os");
});

test("a backend that has just started refuses exports until both stores have loaded", async () => {
	// A fresh process without the test preload, with the real store loaders.
	const module = (name: string) =>
		JSON.stringify(new URL(`../${name}`, import.meta.url).pathname);
	const script = `
		const { credentialStoresState } = await import(${module("helpers/credential-store-state.ts")});
		const { exportChunks } = await import(${module("modules/device-logs/export-body.ts")});
		const { getLogState } = await import(${module("modules/device-logs/settings.ts")});
		const { initHotspotCredentials } = await import(${module("modules/wifi/hotspot-credentials.ts")});
		const { initModemCredentials } = await import(${module("modules/modems/modem-credentials.ts")});
		const query = { sources: [], levels: ["info"], boot: "current", direction: "older", limit: 200 };
		// A refusal is a single chunk. Stop after the first one, so a header
		// fails the comparison at once and the host's journal is never read.
		const firstChunk = async () => {
			for await (const chunk of exportChunks(query, null, getLogState().historyEpoch, new AbortController().signal, Date.now()))
				return new TextDecoder().decode(chunk);
		};
		const sample = async () => [credentialStoresState(), await firstChunk()];
		const init = {
			hotspot: () => initHotspotCredentials(process.argv[1] + "/hotspot.json"),
			modem: () => initModemCredentials(process.argv[1] + "/modems.json"),
		};
		const [first, second] = process.argv[2].split(",");
		const steps = [await sample()];
		// Each store while its file is being read, then once it has been. Once
		// both have loaded only the state is sampled: an export would read the
		// host's journal.
		let loading = init[first]();
		steps.push(await sample());
		await loading;
		steps.push(await sample());
		loading = init[second]();
		steps.push(await sample());
		await loading;
		steps.push([credentialStoresState()]);
		console.log(JSON.stringify(steps));
	`;
	// The child reads the packaged setup.json from its working directory.
	fs.copyFileSync(
		new URL("../../setup.json", import.meta.url).pathname,
		path.join(storeDir, "setup.json"),
	);
	const run = async (order: string) => {
		const result = await runTestCommand(
			[process.execPath, "-e", script, storeDir, order],
			{ cwd: storeDir },
		);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
	};
	const loading = ["pending", "# incomplete: CREDENTIALS_LOADING\n"];
	const failed = ["failed", "# incomplete: READ_FAILED\n"];
	// No store files: both load as empty, but only once both have loaded.
	for (const order of ["hotspot,modem", "modem,hotspot"])
		expect(await run(order)).toEqual([
			loading,
			loading,
			loading,
			loading,
			["ready"],
		]);
	// A hotspot store that cannot be read fails at once, the modem store pending.
	fs.mkdirSync(path.join(storeDir, "hotspot.json"));
	expect(await run("hotspot,modem")).toEqual([
		loading,
		loading,
		failed,
		failed,
		["failed"],
	]);
}, 30_000);
