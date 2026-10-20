import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

test.each(["EIO", "ENOSPC"] as const)(
	"import-time legacy token migration survives %s and retries retained intent",
	async (code) => {
		// Given real legacy bytes, one atomic-write fault and the real import-time timer.
		const root = mkdtempSync(join(tmpdir(), "auth-migration-"));
		const bytes = '{"legacy-token":true}';
		writeFileSync(join(root, "auth_tokens.json"), bytes);
		const module = new URL(
			"../rpc/procedures/auth.procedure.ts",
			import.meta.url,
		).pathname;
		const script = `
const fs=(await import('node:fs')).default; const {spyOn}=await import('bun:test');
const open=fs.openSync; let writes=0; let retained;
const spy=spyOn(fs,'openSync').mockImplementation((p,...args)=>{
 if(String(p).endsWith('.tmp')&&String(p).includes('auth_tokens.json')) {
  writes++;
  if(writes===1) {retained=fs.readFileSync('auth_tokens.json','utf8'); throw Object.assign(new Error('write fault'),{code:${JSON.stringify(code)}});}
 } return open(p,...args);
});
await import(${JSON.stringify(module)});
await new Promise(resolve=>setTimeout(resolve,2000));
spy.mockRestore(); console.log(JSON.stringify({writes,retained,stored:fs.readFileSync('auth_tokens.json','utf8')}));
`;
		try {
			// When the production timer runs, fails, and its bounded owner retries.
			const result = await runTestCommand([process.execPath, "-e", script], {
				cwd: root,
				env: { NODE_ENV: "production", MOCK_MODE: "false" },
			});
			// Then no uncaught callback terminates the process and the original write intent completes.
			expect(result.code).toBe(0);
			expect(
				JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null"),
			).toEqual({ writes: 2, retained: bytes, stored: "{}" });
			expect(readFileSync(join(root, "auth_tokens.json"), "utf8")).toBe("{}");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	15_000,
);
