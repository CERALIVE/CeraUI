/**
 * An absent update-settings.json is the factory state of every board that
 * never saved a preference, and the orchestrator reads settings on every
 * tick (3 s while a phase is active). It must not become a warn line per
 * tick, while a present-but-corrupt file, and a missing file read through
 * the shared loader by anyone else, must still warn.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { loadJsonConfig } from "../helpers/config-loader.ts";
import { logger } from "../helpers/logger.ts";
import {
	loadUpdateSettings,
	UpdateSettingsValidationError,
} from "../modules/system/update-settings.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-update-settings-log-"));
const warn = spyOn(logger, "warn");

function warnsNaming(path: string): number {
	return warn.mock.calls.filter((args) => String(args[0]).includes(path))
		.length;
}

afterEach(() => warn.mockClear());
afterAll(() => {
	warn.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

describe("update settings missing-file logging", () => {
	test("twenty ticks on a factory-default board log no warning", async () => {
		const file = join(dir, "absent-update-settings.json");
		for (let tick = 0; tick < 20; tick += 1) {
			expect(await loadUpdateSettings(file)).toEqual(
				updateSettingsSchema.parse({}),
			);
		}
		expect(warnsNaming(file)).toBe(0);
	});

	test("a corrupt settings file still warns and still refuses", async () => {
		const file = join(dir, "corrupt-update-settings.json");
		writeFileSync(file, "{not json");
		const outcome = await loadUpdateSettings(file).catch(
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(UpdateSettingsValidationError);
		expect(warnsNaming(file)).toBe(1);
	});

	test("a directory at the settings path is not absence: it still warns", async () => {
		const path = join(dir, "directory-update-settings.json");
		mkdirSync(path);
		expect(await loadUpdateSettings(path)).toEqual(
			updateSettingsSchema.parse({}),
		);
		expect(
			warn.mock.calls.filter((args) =>
				String(args[0]).startsWith(`Failed to read config file: ${path}`),
			).length,
		).toBe(1);
	});

	test("the shared loader still warns for any other missing config", async () => {
		const file = join(dir, "some-other-config.json");
		await loadJsonConfig(file, z.object({}), {});
		expect(warnsNaming(file)).toBe(1);
	});
});
