import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	disposeMemoryPersistenceRoots,
	withMemoryPersistence,
} from "./helpers/orchestrator-memory-persistence.ts";

const FIXTURE_PREFIX = "orchestrator-intent-memory-";
const FIXTURES = 64;

const outer = mkdtempSync(join(tmpdir(), "memory-persistence-cleanup-"));
const isolatedTmp = join(outer, "tmp");
mkdirSync(isolatedTmp);
const previousTmpDir = process.env.TMPDIR;
process.env.TMPDIR = isolatedTmp;

afterAll(() => {
	disposeMemoryPersistenceRoots();
	if (previousTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmpDir;
	rmSync(outer, { recursive: true, force: true });
});

function fixtureDirs(): string[] {
	return readdirSync(isolatedTmp).filter((name) =>
		name.startsWith(FIXTURE_PREFIX),
	);
}

test("the disposer removes created fixture directories and nothing else", () => {
	// Given a directory the helper did not create alongside N fixtures.
	const notOurs = mkdtempSync(join(isolatedTmp, `${FIXTURE_PREFIX}not-ours-`));
	for (let i = 0; i < FIXTURES; i += 1) withMemoryPersistence({});
	expect(fixtureDirs()).toHaveLength(FIXTURES + 1);
	// When the helper's disposer runs twice.
	disposeMemoryPersistenceRoots();
	disposeMemoryPersistenceRoots();
	// Then every fixture is gone and the unowned directory survives.
	expect(fixtureDirs()).toEqual([basename(notOurs)]);
});
