import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTestOsStageGuard,
	shippedOsStageGuard,
} from "./helpers/os-stage-test-guard.ts";

test("isolated helper differs from the shipped executable only in its two constants", async () => {
	// Given the actual shipped helper and an isolated path requiring shell quoting.
	const root = await mkdtemp(join(tmpdir(), "ceraui-test-guard-"));
	const directory = join(root, "job's state");
	try {
		const source = (await Bun.file(shippedOsStageGuard).text()).split("\n");
		// When the test-only copy is generated.
		const helper = await createTestOsStageGuard(root, directory, 12345);
		const copy = (await Bun.file(helper).text()).split("\n");
		// Then all executable logic is byte-identical; only directory and owner differ.
		expect(copy.length).toBe(source.length);
		expect(source.filter((line, index) => line !== copy[index])).toEqual([
			"directory=/run/ceralive/os-stage",
			"owner=0",
		]);
		expect(copy.filter((line, index) => line !== source[index])).toEqual([
			`directory='${directory.replaceAll("'", "'\\''")}'`,
			"owner=12345",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
