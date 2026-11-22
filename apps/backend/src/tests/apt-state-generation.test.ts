/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type AptStatePaths,
	aptStateGeneration,
} from "../modules/system/apt-state-generation.ts";

let root: string;
let paths: AptStatePaths;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "apt-state-generation-"));
	await mkdir(join(root, "lists"));
	await writeFile(join(root, "status"), "Status: install ok installed\n");
	await writeFile(join(root, "lists", "a_Packages"), "Package: cerastream\n");
	paths = {
		files: [join(root, "status"), join(root, "preferences")],
		dirs: [join(root, "lists"), join(root, "preferences.d")],
	};
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("the same files give the same token, absent paths included", () => {
	const token = aptStateGeneration(paths);
	expect(token).toMatch(/^[0-9a-f]{64}$/);
	expect(aptStateGeneration(paths)).toBe(token);
});

test("a file replaced by rename, the way dpkg and apt write, changes the token", async () => {
	const before = aptStateGeneration(paths);
	await writeFile(join(root, "status-new"), "Status: hold ok installed\n");
	await rename(join(root, "status-new"), join(root, "status"));
	expect(aptStateGeneration(paths)).not.toBe(before);
});

test("a list file added, rewritten in place or removed changes the token", async () => {
	const tokens = [aptStateGeneration(paths)];
	await writeFile(join(root, "lists", "b_Packages"), "Package: srtla\n");
	tokens.push(aptStateGeneration(paths));
	await writeFile(join(root, "lists", "a_Packages"), "Package: cerastream2\n");
	tokens.push(aptStateGeneration(paths));
	await rm(join(root, "lists", "b_Packages"));
	tokens.push(aptStateGeneration(paths));
	expect(new Set(tokens).size).toBe(4);
});

test("a pin file or directory that appears where none was changes the token", async () => {
	const before = aptStateGeneration(paths);
	await writeFile(join(root, "preferences"), "Package: *\nPin-Priority: 1\n");
	const file = aptStateGeneration(paths);
	await mkdir(join(root, "preferences.d"));
	const dir = aptStateGeneration(paths);
	expect(new Set([before, file, dir]).size).toBe(3);
});
