import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { z } from "zod";
import * as configLoader from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
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
	setUpdateImageChannelFilePathForTest,
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
const sidecar = join(dir, "update-image-channel.json");
const aptSource = join(dir, "ceralive.sources");
const capabilityFile = join(dir, "capabilities.json");
// Frozen schema shipped by older CeraUI, independent of the current RPC schema.
const oldTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const oldSettingsSchema = z
	.object({
		packagesAuto: z.boolean().default(true),
		systemAuto: z.boolean().default(true),
		schedule: z
			.object({
				mode: z.enum(["any-idle", "window"]).default("any-idle"),
				start: oldTime.default("03:00"),
				end: oldTime.default("05:00"),
			})
			.strict()
			.default({ mode: "any-idle", start: "03:00", end: "05:00" }),
		channel: z.enum(["stable", "beta"]).default("stable"),
		allowPackagesOverCellular: z.boolean().default(true),
		allowSystemOverCellular: z.boolean().default(false),
	})
	.strict();

function expectRollbackCompatible(input: unknown): void {
	const persisted: unknown = JSON.parse(readFileSync(file, "utf8"));
	expect(oldSettingsSchema.parse(persisted)).toEqual({
		...updateSettingsSchema.parse(input),
		channel: "stable",
	});
}
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
	rmSync(sidecar, { force: true });
	rmSync(aptSource, { force: true });
	rmSync(capabilityFile, { force: true });
	setUpdateSettingsFilePathForTest(null);
	setUpdateImageChannelFilePathForTest(null);
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
		expect(existsSync(file)).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
	});

	test.each(["stable", "beta"] as const)(
		"writes and reads the %s image selection without changing the six-key legacy schema",
		async (channel) => {
			// Given a valid complete selection, when saved atomically and loaded again.
			const input = {
				packagesAuto: false,
				systemAuto: true,
				schedule: { mode: "window", start: "22:30", end: "04:00" },
				channel,
				allowPackagesOverCellular: false,
				allowSystemOverCellular: true,
			};
			const saved = saveUpdateSettings(input, file);
			// Then old CeraUI sees stable packages and this CeraUI sees the selected image.
			expectRollbackCompatible(input);
			expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
				schema: 1,
				channel,
			});
			expect(await loadUpdateSettings(file)).toEqual(saved);
		},
	);

	test.each(["stable", "beta"] as const)(
		"migrates legacy %s once, resetting only the old system cellular permission",
		async (channel) => {
			const legacy = oldSettingsSchema.parse({
				channel,
				packagesAuto: false,
				allowPackagesOverCellular: false,
				allowSystemOverCellular: true,
			});
			writeFileSync(file, JSON.stringify(legacy));
			const writes = spyOn(configLoader, "writeFileAtomicSync");
			const info = spyOn(logger, "info");
			try {
				const migrated = await loadUpdateSettings(file);
				expect(migrated).toEqual({
					...legacy,
					channel: "beta",
					allowSystemOverCellular: false,
				});
				expectRollbackCompatible(migrated);
				expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
					schema: 1,
					channel: "beta",
				});
				expect(writes.mock.calls.map(([path]) => path)).toEqual([
					file,
					sidecar,
				]);
				expect(info).toHaveBeenCalledWith(
					"Update settings moved to the image-only channel: system images follow beta, packages always come from stable",
				);
				const before = [file, sidecar].map((path) => ({
					bytes: readFileSync(path, "utf8"),
					mtime: statSync(path).mtimeMs,
				}));
				writes.mockClear();
				expect(await loadUpdateSettings(file)).toEqual(migrated);
				expect(await loadUpdateSettings(file)).toEqual(migrated);
				expect(
					[file, sidecar].map((path) => ({
						bytes: readFileSync(path, "utf8"),
						mtime: statSync(path).mtimeMs,
					})),
				).toEqual(before);
				expect(writes).toHaveBeenCalledTimes(0);
			} finally {
				writes.mockRestore();
				info.mockRestore();
			}
		},
	);

	test("preserves an explicit stable image channel after an older CeraUI rewrites settings, normalizing only on save", async () => {
		saveUpdateSettings(updateSettingsSchema.parse({ channel: "stable" }), file);
		const rolledBack = oldSettingsSchema.parse({
			channel: "beta",
			allowSystemOverCellular: true,
		});
		writeFileSync(file, JSON.stringify(rolledBack));
		const before = [file, sidecar].map((path) => ({
			bytes: readFileSync(path, "utf8"),
			mtime: statSync(path).mtimeMs,
		}));
		const loaded = { ...rolledBack, channel: "stable" as const };
		expect(await loadUpdateSettings(file)).toEqual(loaded);
		expect(await loadUpdateSettings(file)).toEqual(loaded);
		expect(
			[file, sidecar].map((path) => ({
				bytes: readFileSync(path, "utf8"),
				mtime: statSync(path).mtimeMs,
			})),
		).toEqual(before);
		saveUpdateSettings(loaded, file);
		expectRollbackCompatible(loaded);
		expect(await loadUpdateSettings(file)).toEqual(loaded);
	});

	test("returns migrated settings and warns once across three read-only loads, then retries successfully", async () => {
		writeFileSync(
			file,
			JSON.stringify(
				oldSettingsSchema.parse({ allowSystemOverCellular: true }),
			),
		);
		const warn = spyOn(logger, "warn");
		chmodSync(dir, 0o500);
		try {
			for (let tick = 0; tick < 3; tick++) {
				expect(await loadUpdateSettings(file)).toEqual(
					updateSettingsSchema.parse({}),
				);
			}
			expect(
				warn.mock.calls.filter(([message]) => String(message).includes(file)),
			).toHaveLength(1);
			expect(existsSync(sidecar)).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
			warn.mockRestore();
		}
		expect(await loadUpdateSettings(file)).toEqual(
			updateSettingsSchema.parse({}),
		);
		expectRollbackCompatible({});
		expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
			schema: 1,
			channel: "beta",
		});
	});

	test("a failed sidecar write leaves stable legacy settings and retries the migration", async () => {
		writeFileSync(
			file,
			JSON.stringify(
				oldSettingsSchema.parse({
					channel: "beta",
					allowSystemOverCellular: true,
				}),
			),
		);
		setUpdateImageChannelFilePathForTest(join(dir, "missing", "image.json"));
		expect(await loadUpdateSettings(file)).toEqual(
			updateSettingsSchema.parse({}),
		);
		expectRollbackCompatible({});
		setUpdateImageChannelFilePathForTest(null);
		expect(await loadUpdateSettings(file)).toEqual(
			updateSettingsSchema.parse({}),
		);
		expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
			schema: 1,
			channel: "beta",
		});
	});

	test.each([
		"{not json",
		'{"schema":1,"channel":"drill"}',
		'{"schema":2,"channel":"beta"}',
		'{"schema":1,"channel":"beta","extra":true}',
		'{"schema":1,"channel":"beta","channel":"stable"}',
	])(
		"rejects damaged sidecar %s and repairs both files on an explicit save",
		async (bytes) => {
			writeFileSync(file, JSON.stringify(oldSettingsSchema.parse({})));
			writeFileSync(sidecar, bytes);
			await expect(loadUpdateSettings(file)).rejects.toBeInstanceOf(
				UpdateSettingsValidationError,
			);
			expect(readFileSync(sidecar, "utf8")).toBe(bytes);
			const selected = updateSettingsSchema.parse({ channel: "stable" });
			saveUpdateSettings(selected, file);
			expectRollbackCompatible(selected);
			expect(await loadUpdateSettings(file)).toEqual(selected);
		},
	);

	test("rejects an invalid schedule without modifying the existing file", () => {
		// Given a valid stored selection, when a bad schedule is saved.
		const valid = updateSettingsSchema.parse({});
		saveUpdateSettings(valid, file);
		const before = readFileSync(file, "utf8");
		const imageBefore = readFileSync(sidecar, "utf8");
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
		expect(readFileSync(sidecar, "utf8")).toBe(imageBefore);
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
	test("a capable image channel change keeps stable-only apt sources; legacy changes write none", async () => {
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
		expect(readFileSync(aptSource, "utf8")).toBe(buildCeraliveSources("amd64"));
		await call(
			setUpdateSettingsProcedure,
			{ ...beta, channel: "stable" },
			{ context },
		);
		expect(readFileSync(aptSource, "utf8")).toBe(buildCeraliveSources("amd64"));
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
