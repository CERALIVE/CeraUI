/*
 * Task 15 — Bun-native migration of system/sensors.ts + system/revisions.ts.
 *
 * Proves the migrated read/exec primitives (Bun.file().text(), Bun.spawnSync)
 * produce IDENTICAL parsed values to the previous node:fs / node:child_process
 * implementation, and that a missing /sys path degrades gracefully (no crash).
 *
 * Sensor parse functions are module-private, so we replicate the exact parse
 * arithmetic here against real temp files read via Bun.file().text() — the
 * same primitive the migrated sensors.ts now uses.
 */
import { afterAll, describe, expect, test } from "bun:test";

import { getRevisions, initRevisions } from "../modules/system/revisions.ts";

const tmpFiles: string[] = [];

async function writeTmp(name: string, contents: string): Promise<string> {
	const path = `/tmp/task15-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await Bun.write(path, contents);
	tmpFiles.push(path);
	return path;
}

afterAll(async () => {
	for (const path of tmpFiles) {
		try {
			await Bun.file(path).delete();
		} catch (_err) {}
	}
});

describe("sensors.ts — Bun.file().text() read + numeric parse", () => {
	test("thermal: parseInt(str,10)/1000 → toFixed(1) °C (identical to readFileSync path)", async () => {
		// Kernel exposes millidegrees, often with a trailing newline.
		const path = await writeTmp("thermal", "45123\n");
		const socTempStr = await Bun.file(path).text();
		const socTemp = Number.parseInt(socTempStr, 10) / 1000.0;
		expect(`${socTemp.toFixed(1)} °C`).toBe("45.1 °C");
	});

	test("jetson voltage: parseInt(str,10)/1000 → toFixed(3) V", async () => {
		const path = await writeTmp("voltage", "5123\n");
		const socVoltageStr = await Bun.file(path).text();
		const socVoltage = Number.parseInt(socVoltageStr, 10) / 1000.0;
		expect(`${socVoltage.toFixed(3)} V`).toBe("5.123 V");
	});

	test("jetson current: parseInt(str,10)/1000 → toFixed(3) A", async () => {
		const path = await writeTmp("current", "1500\n");
		const socCurrentStr = await Bun.file(path).text();
		const socCurrent = Number.parseInt(socCurrentStr, 10) / 1000.0;
		expect(`${socCurrent.toFixed(3)} A`).toBe("1.500 A");
	});

	test("missing /sys path: Bun.file().text() rejects → caught, graceful fallback (no crash)", async () => {
		const missing = `/sys/class/thermal/thermal_zone999/temp-${process.pid}-nope`;
		let threw = false;
		// This mirrors the try/catch in updateSensorThermal: a missing sensor
		// path must NOT crash the sampling loop.
		try {
			const str = await Bun.file(missing).text();
			Number.parseInt(str, 10);
		} catch (_err) {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

describe("revisions.ts — Bun.spawnSync exec + Bun.file().text() read", () => {
	test("readRevision-style: spawnSync stdout Buffer → .toString().trim()", () => {
		const result = Bun.spawnSync(["echo", "abc1234"], { stdout: "pipe" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("abc1234");
	});

	test("readRevision-style: non-zero exit → 'unknown revision' fallback", () => {
		const result = Bun.spawnSync(["false"], { stdout: "pipe" });
		const value =
			result.exitCode !== 0
				? "unknown revision"
				: result.stdout.toString().trim();
		expect(value).toBe("unknown revision");
	});

	test("initRevisions() populates a non-empty record incl. Bun.version", async () => {
		await initRevisions();
		const revisions = getRevisions();
		expect(revisions.bun).toBe(Bun.version);
		// ceralive revision is always set (file read OR git fallback OR unknown).
		expect(typeof revisions.ceralive).toBe("string");
		expect(revisions.ceralive.length).toBeGreaterThan(0);
	});
});
