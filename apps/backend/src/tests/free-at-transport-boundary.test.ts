import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("only the lease and session import the raw tty transport", async () => {
	const root = join(import.meta.dir, "..");
	const importers: string[] = [];
	for await (const path of new Bun.Glob("**/*.ts").scan(root)) {
		if (path.startsWith("tests/") || path.endsWith(".test.ts")) continue;
		const source = await readFile(join(root, path), "utf8");
		if (
			/(?:from\s*|import\s*(?:\(\s*)?|require\s*\(|export\s*[^;]*from\s*)["'][^"']*free-at-tty(?:\.[cm]?[jt]s)?["']/.test(
				source,
			)
		)
			importers.push(path);
	}
	expect(importers.sort()).toEqual([
		"modules/modems/free-at-port.ts",
		"modules/modems/free-at-session.ts",
	]);
});
