import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupConfigSchema } from "../helpers/config-schemas.ts";

test("transport fixture loads real setup and selector in a plain Bun child without privileges", async () => {
	// Given an empty private cwd, without the bun:test setup mock in the child.
	const root = await mkdtemp(join(tmpdir(), "update-transport-setup-"));
	const deviceRoot = join(root, "device");
	await mkdir(deviceRoot);
	const helper = `${import.meta.dir}/fixtures/update-transport-setup.ts`;
	const setupModule = `${import.meta.dir}/../modules/setup.ts`;
	const selector = `${import.meta.dir}/../modules/system/update-transport/executor.ts`;
	try {
		// When the same fixture preparation used by the netns client runs.
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`const { prepareUpdateTransportSetup } = await import(${JSON.stringify(helper)});
await prepareUpdateTransportSetup(process.argv[1]);
await import(${JSON.stringify(setupModule)});
await import(${JSON.stringify(selector)});`,
				deviceRoot,
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		// Then the real strict loader accepts its emitted metadata, without probes.
		expect(exit, `${stdout}\n${stderr}`).toBe(0);
		const written: unknown = await Bun.file(
			join(deviceRoot, "setup.json"),
		).json();
		expect(setupConfigSchema.parse(written).hw).toBe("rk3588");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
