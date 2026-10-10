import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { retireStagedReceipt } from "../modules/system/update-orchestrator/os-receipt-retirement-store.ts";

const receipt = {
	schema: 1 as const,
	version: "2026.10.64",
	channel: "drill" as const,
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
};
const bytes = JSON.stringify(receipt);
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test.each(["read", "before-rename", "after-rename", "after-fsync"] as const)(
	"converges after real SIGKILL at %s with an old consumed receipt",
	async (boundary) => {
		// Given real inodes and a killed child at each retirement boundary.
		const dir = mkdtempSync("/var/tmp/ceraui-receipt-kill-");
		dirs.push(dir);
		writeFileSync(join(dir, "os-staged.json"), bytes);
		writeFileSync(join(dir, "os-staged.consumed.json"), "older");
		const store = new URL(
			"../modules/system/update-orchestrator/os-receipt-retirement-store.ts",
			import.meta.url,
		).pathname;
		const sync = new URL(
			"../modules/system/update-orchestrator/orchestrator-directory-sync.ts",
			import.meta.url,
		).pathname;
		const script = `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { syncOrchestratorDirectory } from ${JSON.stringify(sync)};
const kill = () => process.kill(process.pid, "SIGKILL");
const boundary = ${JSON.stringify(boundary)};
if (boundary === "read") {
  const original = fs.readFileSync;
  spyOn(fs, "readFileSync").mockImplementation((...args) => { const result = original(...args); kill(); return result; });
}
if (boundary === "before-rename") spyOn(fs, "renameSync").mockImplementation(kill);
const { retireStagedReceipt } = await import(${JSON.stringify(store)});
retireStagedReceipt(${bytes}, ${JSON.stringify(dir)}, (path) => {
  if (boundary === "after-rename") kill();
  syncOrchestratorDirectory(path);
  if (boundary === "after-fsync") kill();
});
`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited, stderr).toBe(137);
		// When the surviving controller retries real retirement.
		retireStagedReceipt(receipt, dir);
		const repeated = retireStagedReceipt(receipt, dir);
		// Then the judged evidence survives exactly once and no live receipt remains.
		expect(repeated).toBe(false);
		expect(existsSync(join(dir, "os-staged.json"))).toBe(false);
		expect(readFileSync(join(dir, "os-staged.consumed.json"), "utf8")).toBe(
			bytes,
		);
	},
);
