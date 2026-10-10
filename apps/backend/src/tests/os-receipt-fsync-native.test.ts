import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { retireStagedReceipt } from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";

test("replays the native directory fsync after real rename survives EIO", () => {
	// Given actual inodes and a fault at the native fsync boundary, not a new API argument.
	const dir = fs.mkdtempSync("/var/tmp/ceraui-receipt-native-sync-");
	const receipt = {
		schema: 1 as const,
		version: "2026.10.64",
		channel: "drill" as const,
		stagedAt: 1791464043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	};
	const bytes = JSON.stringify(receipt);
	fs.writeFileSync(join(dir, "os-staged.json"), bytes);
	const nativeSync = fs.fsyncSync;
	let syncs = 0;
	const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		syncs++;
		if (syncs === 1)
			throw Object.assign(new Error("directory fsync failed"), { code: "EIO" });
		nativeSync(fd);
	});
	try {
		// When the actual directory syscall fails after rename, then retirement retries.
		expect(() => retireStagedReceipt(receipt, dir)).toThrow();
		expect(fs.existsSync(join(dir, "os-staged.json"))).toBe(false);
		expect(fs.readFileSync(join(dir, "os-staged.consumed.json"), "utf8")).toBe(
			bytes,
		);
		expect(retireStagedReceipt(receipt, dir)).toBe(false);
		// Then the same production syscall acknowledges the completed rename on retry.
		expect(syncs).toBe(2);
	} finally {
		sync.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
