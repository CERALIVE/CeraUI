import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestCommand } from "./helpers/run-test-command.ts";

test("a backend test owns its streaming sentinel instead of an inherited session's marker", async () => {
	// Given an unrelated session's marker on a writable runtime filesystem.
	const root = await mkdtemp(join(tmpdir(), "backend-runtime-isolation-"));
	const marker = join(root, "streaming");
	await Bun.write(marker, "foreign-session");
	try {
		// When the unchanged mock-Stop regression runs with the normal preload.
		const result = await runTestCommand(
			[
				process.execPath,
				"test",
				"--parallel=2",
				"./src/tests/switch-input-follow.test.ts",
				"-t",
				"5b",
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: { CERALIVE_STREAMING_MARKER: marker },
			},
		);
		// Then the one-broadcast assertion passes without clearing foreign state.
		expect({
			code: result.code,
			output: result.code === 0 ? "" : result.stdout + result.stderr,
		}).toEqual({ code: 0, output: "" });
		expect(await Bun.file(marker).text()).toBe("foreign-session");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
