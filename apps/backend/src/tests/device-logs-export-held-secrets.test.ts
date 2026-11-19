import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogExportInput, VersionContext } from "@ceraui/rpc/schemas";
import { setCredentialStoreState } from "../helpers/credential-store-state.ts";
import * as identity from "../modules/device-logs/boot-id.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
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

test("a held credential too short to match stops the export, naming kinds only", async () => {
	held.mockReturnValue([
		{ kind: "router_password", value: "ab1" },
		{ kind: "apn_password", value: "x" },
		{ kind: "key", value: "abcd" },
	]);
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "login ab1 then abcd" })]),
	);
	// Neither an entry nor the filter text is sent, only the footer.
	expect(await download({ filter: { text: "ab1" } })).toBe(
		"# incomplete: CREDENTIAL_TOO_SHORT (apn_password, router_password)\n",
	);
	// Four characters is the shortest value the matcher replaces.
	held.mockReturnValue([{ kind: "key", value: "abcd" }]);
	const text = await download();
	expect(text).toContain("login ab1 then [REDACTED:key]");
	expect(text).toEndWith("# complete: 1 entries\n");
});

test("the header's fixed text is never altered by a held value that matches it", async () => {
	held.mockReturnValue([
		{ kind: "key", value: "newest first" },
		{ kind: "key", value: "review before sharing" },
		{ kind: "key", value: "exported-by" },
		{ kind: "key", value: "current-os" },
	]);
	fixture.scan.mockImplementation(journal([record(1, { MESSAGE: "entry" })]));
	const text = await download();
	expect(text).toStartWith("# exported-by\n");
	expect(text).toContain("# newest first\n");
	expect(text).toContain(
		"# may contain sensitive data: review before sharing\n",
	);
	// Values are still redacted.
	expect(text).toContain('# osImage: "[REDACTED:key]"\n');
	expect(text).not.toContain("current-os");
});
