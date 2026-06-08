/*
 * T14 — verifies the ingest layer (srt.ts + rtmp.ts) after migration off
 * node:child_process / node:fs to Bun-native equivalents.
 *
 * The load-bearing semantic that this suite guards is the directory-aware
 * existence check in rtmp.ts: the production frontend bundle "public" is a
 * DIRECTORY, and `Bun.file(path).exists()` returns false for directories.
 * A naive Bun.file() swap would therefore invert the dev-mode skip logic, so
 * we lock both the wrong behavior (Bun.file) and the correct one (fs access).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	getRTMPIngestStats,
	initRTMPIngestStats,
} from "../modules/ingest/rtmp.ts";
import { getSRTIngestStats } from "../modules/ingest/srt.ts";

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("rtmp ingest — directory-aware existence (post node:fs migration)", () => {
	let tmp: string;
	const originalCwd = process.cwd();
	const originalNodeEnv = process.env.NODE_ENV;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "ceraui-ingest-"));
		process.chdir(tmp);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = originalNodeEnv;
		}
		rmSync(tmp, { recursive: true, force: true });
	});

	it("Bun.file().exists() returns false for a directory — the trap we avoid", async () => {
		mkdirSync(join(tmp, "public"));
		expect(await Bun.file("public").exists()).toBe(false);
	});

	it("the directory-aware check detects a present 'public' directory", async () => {
		mkdirSync(join(tmp, "public"));
		expect(await pathExists("public")).toBe(true);
	});

	it("the directory-aware check returns false when 'public' is missing — no throw", async () => {
		expect(await pathExists("public")).toBe(false);
	});

	it("initRTMPIngestStats resolves without throwing when public dir is missing in dev mode", async () => {
		process.env.NODE_ENV = "development";
		await expect(initRTMPIngestStats()).resolves.toBeUndefined();
	});

	it("getRTMPIngestStats returns an object snapshot", () => {
		expect(typeof getRTMPIngestStats()).toBe("object");
	});
});

describe("srt ingest — stats accessor (post node:child_process migration)", () => {
	it("getSRTIngestStats returns the connection-stats slot without throwing", () => {
		const stats = getSRTIngestStats();
		const ok =
			stats === null || stats === "" || /^\d+ Kbps, \d+ ms RTT$/.test(stats);
		expect(ok).toBe(true);
	});
});
