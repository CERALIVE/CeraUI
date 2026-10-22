import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as device from "../modules/system/device-detection.ts";
import { defaultCeraUiRevisionSources } from "../modules/system/revisions.ts";

const directory = await mkdtemp(join(tmpdir(), "aptparse-dpkg-"));
const executable = join(directory, "dpkg-query");
await writeFile(
	executable,
	`#!/bin/sh
[ "$1" = '-W' ] && [ "$2" = '-f=\u0024{Version}' ] && [ "$3" = 'ceralive-device' ] && [ "$#" = 3 ] || exit 99
/usr/bin/printf '%s' "$APTPARSE_DPKG_OUTPUT"
exit "$APTPARSE_DPKG_EXIT"
`,
);
await chmod(executable, 0o700);
const realDevice = spyOn(device, "isRealDevice").mockResolvedValue(true);

afterEach(() => {
	delete process.env.APTPARSE_DPKG_OUTPUT;
	delete process.env.APTPARSE_DPKG_EXIT;
});
afterAll(async () => {
	realDevice.mockRestore();
	await rm(directory, { recursive: true, force: true });
});

it.each([
	["2026.9.5-20261022T070000.abc\n", "0", "2026.9.5-20261022T070000.abc"],
	["2:2026.9.5+fix~rc1\r\n", "0", "2:2026.9.5+fix~rc1"],
	["", "0", undefined],
	[" \r\n", "0", undefined],
	["2026.9.5", "1", undefined],
	["2026.9.5\nextra diagnostic", "0", "2026.9.5\nextra diagnostic"],
])(
	"executes the shipped argv-only dpkg scalar reader for %j / exit %s",
	async (output, code, expected) => {
		// Given: a private executable checks the exact real reader's argv.
		process.env.APTPARSE_DPKG_OUTPUT = output;
		process.env.APTPARSE_DPKG_EXIT = code;
		const spawn = Bun.spawnSync;
		const command = spyOn(Bun, "spawnSync").mockImplementation((...args) => {
			expect(args[0]).toEqual([
				"dpkg-query",
				"-W",
				"-f=\u0024{Version}",
				"ceralive-device",
			]);
			return spawn({
				cmd: [executable, "-W", "-f=\u0024{Version}", "ceralive-device"],
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
		});
		// When
		try {
			const actual =
				await defaultCeraUiRevisionSources.readInstalledPackageVersion();
			// Then: this scalar is display-only, never package installation authority.
			expect(actual).toBe(expected);
			expect(command).toHaveBeenCalledTimes(1);
		} finally {
			command.mockRestore();
		}
	},
);
