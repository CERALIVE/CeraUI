import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestCommand } from "./helpers/run-test-command.ts";

test.each([
	"one-eio",
	"persistent-eio",
	"eagain",
	"short",
	"damaged",
	"damaged-json",
] as const)(
	"required setup module retains authority through %s",
	async (fault) => {
		// Given real image metadata and a leaf-read fault in a fresh module process.
		const root = mkdtempSync(join(tmpdir(), "setup-retry-"));
		const bytes =
			fault === "damaged"
				? '{"hw":"rk3588","apt_update_enabled":"bad"}'
				: fault === "damaged-json"
					? '{"hw":'
					: '{"hw":"rk3588","apt_update_enabled":false,"cerastream_path":"real-engine"}';
		writeFileSync(join(root, "setup.json"), bytes);
		const module = new URL("../modules/setup.ts", import.meta.url).pathname;
		const script = `
const {mock,spyOn}=await import('bun:test');
const fs=await import('node:fs/promises'); const realOpen=fs.open;
const waits=[]; let reads=0;
spyOn(Bun,'sleep').mockImplementation(async(ms)=>{waits.push(ms);});
mock.module('node:fs/promises',()=>({...fs,open:async(...args)=>{
 if(String(args[0]).endsWith('/setup.json')) {
  reads++; const f=${JSON.stringify(fault)};
  if(f==='persistent-eio'||(reads===1&&(f==='one-eio'||f==='eagain'))) throw Object.assign(new Error('leaf IO'),{code:f==='eagain'?'EAGAIN':'EIO'});
  const h=await realOpen(...args);
  if(f==='short'&&reads===1) h.read=async()=>({bytesRead:0});
  return h;
 } return realOpen(...args);
}}));
try { const {setup}=await import(${JSON.stringify(module)}); console.log(JSON.stringify({loaded:true,reads,waits,hw:setup.hw,apt:setup.apt_update_enabled,engine:setup.cerastream_path})); }
catch(e) { console.log(JSON.stringify({loaded:false,reads,waits,name:e.name,reason:e.reason,code:e.cause?.code})); }
`;
		try {
			// When the unchanged module-evaluation export is imported (sleep is injected).
			const result = await runTestCommand([process.execPath, "-e", script], {
				cwd: root,
			});
			expect(result.code).toBe(0);
			const observed = JSON.parse(
				result.stdout.trim().split("\n").at(-1) ?? "null",
			);
			// Then transient errors recover actual values, while exhaustion/damage stays typed.
			if (fault === "persistent-eio")
				expect(observed).toEqual({
					loaded: false,
					reads: 5,
					waits: [250, 500, 1000, 1250],
					name: "StoredStateReadError",
					reason: "read_failed",
					code: "EIO",
				});
			else if (fault === "damaged")
				expect(observed).toEqual({
					loaded: false,
					reads: 1,
					waits: [],
					name: "ZodError",
				});
			else if (fault === "damaged-json")
				expect(observed).toEqual({
					loaded: false,
					reads: 1,
					waits: [],
					name: "AuthorityJsonError",
					reason: "invalid_json",
				});
			else
				expect(observed).toEqual({
					loaded: true,
					reads: 2,
					waits: [250],
					hw: "rk3588",
					apt: false,
					engine: "real-engine",
				});
			expect(readFileSync(join(root, "setup.json"), "utf8")).toBe(bytes);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
