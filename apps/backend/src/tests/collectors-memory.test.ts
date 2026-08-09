/*
 * Memory/swap collector — `/proc/meminfo` read through the root-aware
 * collector filesystem seam (`collectors/fs.ts`).
 *
 * Every leg runs against a REAL fixture tree on disk (an injected root), not a
 * hand-stubbed `readText`, so the path resolution the production collector uses
 * is exercised end to end. The four legs pin the one rule this collector exists
 * to keep honest — OMISSION vs ZERO:
 *
 *   normal    — named byte values, derived percent
 *   no-swap   — SwapTotal/SwapFree are REAL zeros (a swapless board), present
 *   malformed — unparseable/absent lines are OMITTED, never zero-filled
 *   absent    — no /proc/meminfo at all → every field omitted
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCollectorFs } from "../modules/system/collectors/fs.ts";
import {
	collectMemory,
	memoryStatsFromMeminfo,
} from "../modules/system/collectors/memory.ts";

/** kB → bytes, the unit `/proc/meminfo` actually reports (KiB, despite "kB"). */
const KIB = 1024;

/**
 * Build a fixture root containing `proc/meminfo` (or none at all when
 * `meminfo` is undefined — the absent-source leg).
 */
async function fixtureRoot(meminfo?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-meminfo-"));
	await mkdir(join(root, "proc"), { recursive: true });
	if (meminfo !== undefined) {
		await writeFile(join(root, "proc", "meminfo"), meminfo);
	}
	return root;
}

const NORMAL_MEMINFO = [
	"MemTotal:        8192000 kB",
	"MemFree:         1024000 kB",
	"MemAvailable:    6144000 kB",
	"Buffers:          204800 kB",
	"Cached:          3072000 kB",
	"SwapTotal:       2048000 kB",
	"SwapFree:        1536000 kB",
	"",
].join("\n");

const NO_SWAP_MEMINFO = [
	"MemTotal:        4096000 kB",
	"MemFree:          512000 kB",
	"MemAvailable:    2048000 kB",
	"SwapTotal:             0 kB",
	"SwapFree:              0 kB",
	"",
].join("\n");

// MemTotal unparseable, MemAvailable absent entirely, swap intact. The two
// memory fields and the derived percent must be OMITTED — not 0, not NaN.
const MALFORMED_MEMINFO = [
	"MemTotal:        banana kB",
	"MemFree:         1024000 kB",
	"SwapTotal:       1024000 kB",
	"SwapFree:         512000 kB",
	"",
].join("\n");

describe("memory collector — /proc/meminfo through the injected root", () => {
	test("normal: exact byte values + derived used percent", async () => {
		const root = await fixtureRoot(NORMAL_MEMINFO);
		expect(await collectMemory(createCollectorFs(root))).toEqual({
			memTotalBytes: 8_192_000 * KIB,
			memAvailableBytes: 6_144_000 * KIB,
			// (8192000 − 6144000) / 8192000 × 100 = 25
			memUsedPercent: 25,
			swapTotalBytes: 2_048_000 * KIB,
			swapFreeBytes: 1_536_000 * KIB,
		});
	});

	test("no-swap: SwapTotal=0 is a REAL reading — present as zero, not omitted", async () => {
		const root = await fixtureRoot(NO_SWAP_MEMINFO);
		expect(await collectMemory(createCollectorFs(root))).toEqual({
			memTotalBytes: 4_096_000 * KIB,
			memAvailableBytes: 2_048_000 * KIB,
			// (4096000 − 2048000) / 4096000 × 100 = 50
			memUsedPercent: 50,
			swapTotalBytes: 0,
			swapFreeBytes: 0,
		});
	});

	test("malformed: unparseable/absent fields are omitted, readable ones survive", async () => {
		const root = await fixtureRoot(MALFORMED_MEMINFO);
		const stats = await collectMemory(createCollectorFs(root));
		expect(stats).toEqual({
			swapTotalBytes: 1_024_000 * KIB,
			swapFreeBytes: 512_000 * KIB,
		});
		// Spelled out: omission is the contract, a fabricated 0 is not.
		expect("memTotalBytes" in stats).toBe(false);
		expect("memAvailableBytes" in stats).toBe(false);
		expect("memUsedPercent" in stats).toBe(false);
	});

	test("absent /proc/meminfo: every field omitted, no throw", async () => {
		const root = await fixtureRoot();
		expect(await collectMemory(createCollectorFs(root))).toEqual({});
	});
});

describe("memoryStatsFromMeminfo — parse edge cases", () => {
	test("MemTotal=0 keeps the real zero but omits the undefined percent", () => {
		const stats = memoryStatsFromMeminfo(
			"MemTotal:              0 kB\nMemAvailable:          0 kB\n",
		);
		expect(stats).toEqual({ memTotalBytes: 0, memAvailableBytes: 0 });
	});

	test("percent is clamped to 0-100 when MemAvailable exceeds MemTotal", () => {
		const stats = memoryStatsFromMeminfo(
			"MemTotal:           1000 kB\nMemAvailable:       4000 kB\n",
		);
		expect(stats.memUsedPercent).toBe(0);
	});

	test("a non-kB unit is refused rather than assumed", () => {
		expect(memoryStatsFromMeminfo("MemTotal:        8192000 MB\n")).toEqual({});
	});
});
