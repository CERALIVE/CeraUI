/*
    CeraUI - test fixture loader

    Tiny synchronous helper for bun:test. Reads captured nmcli/mmcli output
    (and any other) fixtures from `src/tests/fixtures/` so tests can feed the
    real parsers real-shaped strings without spawning subprocesses.
*/

import { readFileSync } from "node:fs";
import { join } from "node:path";

// `import.meta.dir` is the directory of THIS file: src/tests/helpers/.
// Fixtures live one level up, under src/tests/fixtures/.
const FIXTURES_ROOT = join(import.meta.dir, "..", "fixtures");

/**
 * Load a fixture file as a UTF-8 string.
 *
 * @param name Path relative to `src/tests/fixtures/`,
 *             e.g. `"network/nmcli-device-status.txt"`.
 */
export function loadFixture(name: string): string {
	return readFileSync(join(FIXTURES_ROOT, name), "utf8");
}

/**
 * Load a fixture and split it into trimmed, non-empty lines. Convenient for
 * line-oriented nmcli/mmcli output where trailing newlines are noise.
 */
export function loadFixtureLines(name: string): Array<string> {
	return loadFixture(name)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Load and JSON-parse a fixture. Caller supplies the expected shape.
 */
export function loadFixtureJson<T = unknown>(name: string): T {
	return JSON.parse(loadFixture(name)) as T;
}
