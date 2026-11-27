import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

test("a first start without relays_cache.json logs the missing cache at info, not warn", async () => {
	// Given a fresh process whose own working directory has no relays cache.
	const root = mkdtempSync(join(tmpdir(), "relays-cache-"));
	const logger = new URL("../helpers/logger.ts", import.meta.url).pathname;
	const schemas = new URL("../helpers/config-schemas.ts", import.meta.url)
		.pathname;
	const setup = new URL("../modules/setup.ts", import.meta.url).pathname;
	const relays = new URL("../modules/remote/remote-relays.ts", import.meta.url)
		.pathname;
	const script = `
const {mock,spyOn}=await import('bun:test');
const {SETUP_CONFIG_DEFAULTS}=await import(${JSON.stringify(schemas)});
mock.module(${JSON.stringify(setup)},()=>({setup:SETUP_CONFIG_DEFAULTS}));
const {logger}=await import(${JSON.stringify(logger)});
const seen={warn:0,info:0};
const notFound=(m)=>String(m).startsWith('Config file not found: relays_cache.json');
spyOn(logger,'warn').mockImplementation((m)=>{if(notFound(m))seen.warn++;return logger;});
spyOn(logger,'info').mockImplementation((m)=>{if(notFound(m))seen.info++;return logger;});
const relays=await import(${JSON.stringify(relays)});
console.log(JSON.stringify({...seen,cached:relays.getRelays()!==undefined}));
`;
	try {
		// When the relays module loads there.
		const result = await runTestCommand([process.execPath, "-e", script], {
			cwd: root,
		});
		// Then the missing cache is an info line, not a warning.
		expect(result.code).toBe(0);
		expect(
			JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null"),
		).toEqual({ warn: 0, info: 1, cached: false });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);
