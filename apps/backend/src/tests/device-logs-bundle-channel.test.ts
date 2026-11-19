import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readUpdateChannel,
	setUpdateSettingsFilePathForTest,
} from "../modules/system/update-settings.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bundle-channel-"));
	setUpdateSettingsFilePathForTest(join(dir, "settings.json"));
});
afterEach(() => {
	setUpdateSettingsFilePathForTest(null);
	rmSync(dir, { recursive: true, force: true });
});
test.each([
	{ legacy: false, sidecar: undefined, channel: "beta" },
	{ legacy: true, sidecar: undefined, channel: "beta" },
	{ legacy: true, sidecar: "stable", channel: "stable" },
	{ legacy: false, sidecar: "beta", channel: "beta" },
])(
	"reads effective channel without migration writes: %j",
	async ({ legacy, sidecar, channel }) => {
		if (legacy)
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ channel: "stable" }),
			);
		if (sidecar)
			writeFileSync(
				join(dir, "update-image-channel.json"),
				JSON.stringify({ schema: 1, channel: sidecar }),
			);
		const write = spyOn(fs, "writeFileSync");
		try {
			expect(await readUpdateChannel()).toBe(channel);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	},
);

test.each(["settings.json", "update-image-channel.json"])(
	"invalid channel authority in %s is not replaced with an assumed channel",
	async (file) => {
		writeFileSync(join(dir, file), '{"channel":"planted-secret"');
		await expect(readUpdateChannel()).rejects.toThrow(
			"Invalid persisted update settings",
		);
	},
);
