import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "authority-process-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test.each([
	'{"hw":"rk3588","apt_update_enabled":false,"apt_update_enabled":true}',
	'{"hw":"rk3588","apt_update_enabled":"bad"}',
])(
	"packaged setup ambiguity grants zero update permission: %s",
	async (bytes) => {
		// Given the real packaged setup module, isolated by child CWD rather than reader mocks.
		writeFileSync(join(dir, "setup.json"), bytes);
		const module = new URL("../modules/setup.ts", import.meta.url).pathname;
		const script = `const {setup}=await import(${JSON.stringify(module)}); if(setup.apt_update_enabled) await Bun.write('grant','yes');`;
		// When that module determines whether the child can submit an update.
		await runTestCommand([process.execPath, "-e", script], { cwd: dir });
		// Then ambiguous presence does not acquire the safe-absence default.
		expect(existsSync(join(dir, "grant"))).toBe(false);
		expect(readFileSync(join(dir, "setup.json"), "utf8")).toBe(bytes);
	},
);

test("contradictory stored token grants zero authenticated sessions", async () => {
	// Given a known token digest with contradictory membership.
	const token = "private-test-token";
	const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
	const bytes = `{"${digest}":false,"${digest}":true}`;
	writeFileSync(join(dir, "auth_tokens.json"), bytes);
	const module = new URL("../rpc/procedures/auth.procedure.ts", import.meta.url)
		.pathname;
	const orpc = import.meta.resolve("@orpc/server");
	const script = `const {writeFileSync}=await import('node:fs'); const {call}=await import(${JSON.stringify(orpc)}); const p=await import(${JSON.stringify(module)}); p.setPasswordHash('test-hash'); await call(p.loginProcedure,{token:${JSON.stringify(token)}},{context:{authenticate(){writeFileSync('grant','yes');}}});`;
	// When the actual login procedure evaluates membership in a fresh process.
	const result = await runTestCommand([process.execPath, "-e", script], {
		cwd: dir,
	});
	// Then the loader must deny instead of selecting the final duplicate.
	expect(result.code).toBe(0);
	expect(existsSync(join(dir, "grant"))).toBe(false);
	expect(readFileSync(join(dir, "auth_tokens.json"), "utf8")).toBe(bytes);
});
