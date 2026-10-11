import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateCapabilities } from "../modules/system/update-capabilities.ts";
import { readActivationArmed } from "../modules/system/update-orchestrator/os-activation-marker.ts";
import {
	readStagedReceipt,
	readStagedReceiptEvidence,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import { fileRecoveryStore } from "../modules/system/update-orchestrator/recovery-store.ts";
import { parseStagedActivation } from "../modules/system/update-orchestrator/slot-status.ts";
import { parseInstalledPackages } from "../modules/system/update-orchestrator/slot-sync-cleanup.ts";
import {
	parseRaucSlotBootnames,
	readHealthyState,
} from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { loadUpdateSettings } from "../modules/system/update-settings.ts";

test.each([
	"settings",
	"capabilities",
	"health",
	"receipt",
	"receipt-evidence",
	"recovery-receipt",
])("%s reader cannot trust overwritten duplicate authority", async (reader) => {
	const dir = await mkdtemp(join(tmpdir(), "authority-sweep-"));
	const path = join(
		dir,
		reader === "receipt" || reader === "receipt-evidence"
			? "os-staged.json"
			: reader === "recovery-receipt"
				? `recovery-${"a".repeat(64)}.json`
				: "record.json",
	);
	const bytes =
		reader === "settings"
			? '{"channel":"stable","channel":"beta"}'
			: reader === "capabilities"
				? '{"schema":1,"features":[],"features":["apt-all-packages"]}'
				: '{"schema":1,"schema":1}';
	await writeFile(path, bytes, { mode: 0o600 });
	try {
		switch (reader) {
			case "settings":
				await expect(loadUpdateSettings(path)).rejects.toThrow();
				break;
			case "capabilities":
				expect(await readUpdateCapabilities(path)).toEqual({
					mode: "legacy",
					features: [],
				});
				break;
			case "health":
				await expect(readHealthyState(path)).rejects.toThrow();
				break;
			case "receipt":
				await expect(readStagedReceipt(dir)).rejects.toThrow();
				break;
			case "receipt-evidence":
				await expect(readStagedReceiptEvidence(dir)).rejects.toThrow();
				break;
			case "recovery-receipt":
				await expect(
					fileRecoveryStore(dir).readReceipt("a".repeat(64)),
				).rejects.toThrow();
				break;
			default:
				throw new Error(`unexpected reader ${reader}`);
		}
		expect(await readFile(path, "utf8")).toBe(bytes);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("large legitimate quarantine history is retained in full, not truncated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "authority-history-"));
	const path = join(dir, "quarantine.json");
	const history = {
		schema: 1 as const,
		packages: Array.from({ length: 10000 }, (_, i) => ({
			name: `pkg-${i}`,
			version: "2026.10.5",
		})),
		os: Array.from({ length: 10000 }, (_, i) => ({
			version: `2026.10.${i}`,
			bootedVersion: "2026.10.4",
		})),
		failedCommits: Array.from({ length: 10000 }, (_, i) => ({
			id: `commit-${i}`,
			reason: "apt-exit-1",
		})),
	};
	const bytes = JSON.stringify(history, null, 2);
	await writeFile(path, bytes);
	try {
		const loaded = await new UpdateQuarantine(path).read();
		expect(loaded).toEqual(history);
		expect(await readFile(path, "utf8")).toBe(bytes);
		console.log(
			`quarantine_valid_history_bytes=${Buffer.byteLength(bytes)} rows=30000`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("plain-field authority duplicates cannot lift quarantine or guess slot identity", () => {
	expect(() =>
		parseInstalledPackages(
			"Package: pkg\nStatus: install ok installed\nVersion: 1\nVersion: 2\n",
		),
	).toThrow();
	expect(() =>
		parseRaucSlotBootnames("[slot.rootfs.0]\nbootname=A\nbootname=B\n"),
	).toThrow();
	expect(
		parseStagedActivation(
			'{"boot_primary":"rootfs.0","boot_primary":"rootfs.1","slots":[]}',
		),
	).toBe("unknown");
});

test("dangling ancestor never proves activation marker absence", async () => {
	const dir = await mkdtemp(join(tmpdir(), "authority-marker-parent-"));
	await symlink(join(dir, "missing"), join(dir, "parent"));
	try {
		await expect(
			readActivationArmed(join(dir, "parent/activation-armed")),
		).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
