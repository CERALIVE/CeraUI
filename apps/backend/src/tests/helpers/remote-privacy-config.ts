import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../../modules/config.ts";
import { AUTH_KEY, secrets } from "./remote-privacy-cases.ts";

export function usePrivacyConfig(): void {
	let original: ReturnType<typeof getConfig>;
	let originalConfigPath: string;
	let scratch: string;
	beforeEach(async () => {
		original = structuredClone(getConfig());
		originalConfigPath = getConfigFilePath();
		scratch = await mkdtemp(join(tmpdir(), "remote-config-privacy-"));
		setConfigFilePath(join(scratch, "config.json"));
		Object.assign(getConfig(), secrets, { remote_key: AUTH_KEY });
	});
	afterEach(async () => {
		for (const key of Object.keys(getConfig()))
			Reflect.deleteProperty(getConfig(), key);
		Object.assign(getConfig(), original);
		setConfigFilePath(originalConfigPath);
		await rm(scratch, { recursive: true, force: true });
	});
}
