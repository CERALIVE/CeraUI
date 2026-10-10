import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("keeps a fresh candidate replacing the path after the descriptor's entry check", async () => {
	// Given real files and an inode replacement at the native lstat return boundary.
	const dir = mkdtempSync("/var/tmp/ceraui-receipt-path-");
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
	const script = `
import { spyOn } from "bun:test";
import * as fs from "node:fs";
const dir = ${JSON.stringify(dir)};
const agent = await import(${JSON.stringify(agent)});
const judged = agent.readStagedReceiptEvidence ? await agent.readStagedReceiptEvidence(dir) : ${JSON.stringify(receipt)};
const native = fs.lstatSync;
let replaced = false;
spyOn(fs, "lstatSync").mockImplementation((...args) => {
  const info = native(...args);
  if (!replaced && String(args[0]).endsWith("/os-staged.json")) {
    replaced = true;
    fs.writeFileSync(dir + "/replacement", ${JSON.stringify(fresh)});
    fs.renameSync(dir + "/replacement", dir + "/os-staged.json");
  }
  return info;
});
const { retireStagedReceipt } = await import(${JSON.stringify(store)});
process.stdout.write(JSON.stringify({ retired: retireStagedReceipt(judged, dir), replaced }));
`;
	// When production retirement crosses that controlled native interleaving.
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
	// Then the replacement remains a live candidate, never a consumed receipt.
	expect(rc, stderr).toBe(0);
	expect(JSON.parse(stdout)).toEqual({ retired: false, replaced: true });
	expect(readFileSync(join(dir, "os-staged.json"), "utf8")).toBe(fresh);
});
