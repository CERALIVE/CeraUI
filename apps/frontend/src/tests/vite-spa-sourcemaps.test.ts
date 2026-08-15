import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	relocateSourcemaps,
	SPA_SOURCEMAP_OUT_DIR,
	spaSourcemapRelocationPlugin,
} from "../../vite.sourcemaps";

let root = "";
let outDir = "";
let mapDir = "";

async function write(relative: string): Promise<void> {
	const target = path.join(outDir, relative);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, "x");
}

async function listFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (relative: string): Promise<void> => {
		const entries = await readdir(path.join(dir, relative), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const next = path.join(relative, entry.name);
			if (entry.isDirectory()) await walk(next);
			else found.push(next);
		}
	};
	await walk(".");
	return found.sort();
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "ceraui-sourcemaps-"));
	outDir = path.join(root, "public");
	mapDir = path.join(root, SPA_SOURCEMAP_OUT_DIR);
	await mkdir(outDir, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("SPA sourcemap relocation", () => {
	it("moves every nested map out of the packaged tree, keeping its path", async () => {
		await write("index.html");
		await write("sw.js");
		await write("assets/live-abc.js");
		await write("assets/live-abc.js.map");
		await write("assets/style.css");
		await write("assets/style.css.map");
		await write("assets/nested/deep-xyz.js.map");

		const moved = await relocateSourcemaps(outDir, mapDir);

		expect(moved.sort()).toEqual([
			path.join("assets", "live-abc.js.map"),
			path.join("assets", "nested", "deep-xyz.js.map"),
			path.join("assets", "style.css.map"),
		]);
		expect(await listFiles(outDir)).toEqual([
			path.join("assets", "live-abc.js"),
			path.join("assets", "style.css"),
			"index.html",
			"sw.js",
		]);
		expect(await listFiles(mapDir)).toEqual([
			path.join("assets", "live-abc.js.map"),
			path.join("assets", "nested", "deep-xyz.js.map"),
			path.join("assets", "style.css.map"),
		]);
	});

	it("leaves a map-free build untouched and creates nothing", async () => {
		await write("assets/live-abc.js");

		expect(await relocateSourcemaps(outDir, mapDir)).toEqual([]);
		expect(await listFiles(outDir)).toEqual([
			path.join("assets", "live-abc.js"),
		]);
		await expect(readdir(mapDir)).rejects.toThrow();
	});

	it("does not touch the build output when disabled", async () => {
		await write("assets/live-abc.js.map");

		await spaSourcemapRelocationPlugin({
			outDir,
			mapDir,
			enabled: false,
		}).closeBundle.handler();

		expect(await listFiles(outDir)).toEqual([
			path.join("assets", "live-abc.js.map"),
		]);
	});

	it("relocates through the plugin when enabled", async () => {
		await write("assets/live-abc.js.map");

		await spaSourcemapRelocationPlugin({
			outDir,
			mapDir,
			enabled: true,
		}).closeBundle.handler();

		expect(await listFiles(outDir)).toEqual([]);
		expect(await listFiles(mapDir)).toEqual([
			path.join("assets", "live-abc.js.map"),
		]);
	});

	it("runs as a post hook, after vite-plugin-pwa emits sw.js and its map", () => {
		expect(
			spaSourcemapRelocationPlugin({ outDir, mapDir, enabled: true })
				.closeBundle.order,
		).toBe("post");
	});
});
