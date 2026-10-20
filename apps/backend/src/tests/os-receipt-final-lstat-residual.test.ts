import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("documents that noncooperative replacement after final lstat is consumed by rename", async () => {
	// Given a real receipt and a bypass writer at the final lstat return boundary.
	const dir = mkdtempSync("/var/tmp/ceraui-receipt-final-path-");
	const receipt = {
		schema: 1,
		version: "2026.10.64",
		channel: "drill",
		stagedAt: 1791464043236,
		bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	};
	const fresh = JSON.stringify({ ...receipt, version: "2026.10.70" });
	writeFileSync(join(dir, "os-staged.json"), JSON.stringify(receipt));
	const agent = new URL(
		"../modules/system/update-orchestrator/os-agent.ts",
		import.meta.url,
	).pathname;
	const store = new URL(
		"../modules/system/update-orchestrator/os-receipt-retirement-store.ts",
		import.meta.url,
	).pathname;
	const script = `import { spyOn } from "bun:test"; import * as fs from "node:fs";
const dir = ${JSON.stringify(dir)};
const { readStagedReceiptEvidence } = await import(${JSON.stringify(agent)});
const judged = await readStagedReceiptEvidence(dir); const native = fs.lstatSync; let checks = 0;
spyOn(fs, "lstatSync").mockImplementation((...args) => {
 const info = native(...args);
 if (String(args[0]).endsWith("/os-staged.json") && ++checks === 2) {
  fs.writeFileSync(dir + "/replacement", ${JSON.stringify(fresh)});
  fs.renameSync(dir + "/replacement", dir + "/os-staged.json");
 }
 return info;
});
const { retireStagedReceipt } = await import(${JSON.stringify(store)});
process.stdout.write(JSON.stringify({ retired: retireStagedReceipt(judged, dir), checks }));`;
	try {
		// When replacement happens after the final check, without taking CONTROL.
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, LOG_LEVEL: "error" },
		});
		const [stdout, stderr, rc] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		// Then rename consumes the replacement: this pins a residual, not a guarantee.
		expect(rc, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ retired: true, checks: 2 });
		expect(readFileSync(join(dir, "os-staged.consumed.json"), "utf8")).toBe(
			fresh,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
