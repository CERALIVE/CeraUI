import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { setup } from "../modules/setup.ts";
import {
	aptUpdatesEnabled,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import {
	buildCeraliveSources,
	setCeraliveSourcesFileForTest,
} from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import {
	loadUpdateSettings,
	saveUpdateSettings,
	setUpdateSettingsFilePathForTest,
	UpdateSettingsValidationError,
} from "../modules/system/update-settings.ts";
import {
	getUpdateSettingsProcedure,
	setUpdateSettingsProcedure,
} from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-update-settings-"));
const file = join(dir, "update-settings.json");
const aptSource = join(dir, "ceralive.sources");
const capabilityFile = join(dir, "capabilities.json");
const context = {
	ws: {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: () => {},
	} as unknown as AppWebSocket,
	isAuthenticated: () => true,
	authenticate: () => {},
	deauthenticate: () => {},
	markActive: () => {},
	getLastActive: () => 0,
	setSenderId: () => {},
	getSenderId: () => undefined,
	clearSenderId: () => {},
} satisfies RPCContext;

afterEach(() => {
	rmSync(file, { force: true });
	rmSync(aptSource, { force: true });
	rmSync(capabilityFile, { force: true });
	setUpdateSettingsFilePathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setUpdateCapabilityPathForTest(null);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("update settings persistence", () => {
	test("loads the canonical defaults when the file is absent", async () => {
		// Given no settings file, when loaded, then schema defaults apply.
		expect(await loadUpdateSettings(file)).toEqual(
			updateSettingsSchema.parse({}),
		);
	});

	test("writes and reads an operator selection without losing any fields", async () => {
		// Given a valid complete selection, when saved atomically and loaded again.
		const input = {
			packagesAuto: false,
			systemAuto: true,
			schedule: { mode: "window", start: "22:30", end: "04:00" },
			channel: "beta",
			allowPackagesOverCellular: false,
			allowSystemOverCellular: true,
		};
		const saved = saveUpdateSettings(input, file);
		// Then both the bytes and parsed value retain exactly what was selected.
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(input);
		expect(await loadUpdateSettings(file)).toEqual(saved);
	});

	test("rejects an invalid schedule without modifying the existing file", () => {
		// Given a valid stored selection, when a bad schedule is saved.
		const valid = updateSettingsSchema.parse({});
		saveUpdateSettings(valid, file);
		const before = readFileSync(file, "utf8");
		// Then a typed error leaves the original bytes intact.
		expect(() =>
			saveUpdateSettings(
				{
					...valid,
					schedule: { mode: "window", start: "25:00", end: "05:00" },
				},
				file,
			),
		).toThrow(UpdateSettingsValidationError);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("rejects malformed persisted content rather than silently salvaging defaults", async () => {
		// Given a present malformed file, when loaded, then a typed error is raised.
		writeFileSync(file, "{not json");
		await expect(loadUpdateSettings(file)).rejects.toBeInstanceOf(
			UpdateSettingsValidationError,
		);
	});

	test("rejects invalid persisted fields rather than salvaging siblings", async () => {
		// Given a present invalid schedule, when loaded, then it is not defaulted.
		writeFileSync(
			file,
			JSON.stringify({
				schedule: { mode: "window", start: "25:00", end: "05:00" },
			}),
		);
		await expect(loadUpdateSettings(file)).rejects.toBeInstanceOf(
			UpdateSettingsValidationError,
		);
	});
});

describe("update-settings RPC", () => {
	test("a capable channel change writes layered apt sources before persisting settings; legacy changes write none", async () => {
		setUpdateSettingsFilePathForTest(file);
		setCeraliveSourcesFileForTest(aptSource);
		setUpdateCapabilityPathForTest(capabilityFile);
		const beta = updateSettingsSchema.parse({ channel: "beta" });
		writeFileSync(aptSource, "legacy bytes");
		await call(setUpdateSettingsProcedure, beta, { context });
		expect(readFileSync(aptSource, "utf8")).toBe("legacy bytes");
		writeFileSync(
			capabilityFile,
			JSON.stringify({
				schema: 1,
				features: ["apt-all-packages"],
				ota_uid: 42041,
				apt_uid: 42042,
			}),
		);
		await call(setUpdateSettingsProcedure, beta, { context });
		expect(readFileSync(aptSource, "utf8")).toBe(
			buildCeraliveSources("beta", "amd64"),
		);
		await call(
			setUpdateSettingsProcedure,
			{ ...beta, channel: "stable" },
			{ context },
		);
		expect(readFileSync(aptSource, "utf8")).toBe(
			buildCeraliveSources("stable", "amd64"),
		);
	});
	test("set and get return the exact saved selection", async () => {
		// Given a valid selection, when set via RPC and read back via RPC.
		setUpdateSettingsFilePathForTest(file);
		const input = updateSettingsSchema.parse({
			channel: "beta",
			packagesAuto: false,
		});
		const applied = await call(setUpdateSettingsProcedure, input, { context });
		// Then the RPC returns the applied value, not a parallel local wire type.
		expect(applied).toEqual(input);
		expect(
			await call(getUpdateSettingsProcedure, undefined, { context }),
		).toEqual(input);
	});

	test("the existing setup hard switch still refuses manual apt installs", () => {
		// Given an explicit old-image opt-out while the new auto preference is on.
		const old = setup.apt_update_enabled;
		try {
			setup.apt_update_enabled = false;
			// When a manual install is attempted, then the existing typed refusal wins.
			expect(aptUpdatesEnabled()).toBe(false);
			expect(startSoftwareUpdate()).toEqual({
				started: false,
				reason: "updates_disabled",
			});
		} finally {
			setup.apt_update_enabled = old;
		}
	});
});
