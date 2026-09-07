import { afterAll, mock } from "bun:test";
import { rm } from "node:fs/promises";
import { loadJsonConfigSync } from "../helpers/config-loader.ts";
import {
	SETUP_CONFIG_DEFAULTS,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";

const setup = await loadJsonConfigSync(
	"setup.json",
	setupConfigSchema,
	SETUP_CONFIG_DEFAULTS,
	false,
);
mock.module("../modules/setup.ts", () => ({ setup }));

afterAll(async () => {
	await Bun.sleep(0);
	await rm("stream.armed.json", { force: true });
});
