import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["job.json", "token", "ready", "release", "maintenance"] as const)(
	"rejects no-writer %s FIFO promptly and disposes startup CONTROL",
	async (name) => {
		// Given private provenance containing a real FIFO with no writer.
		const dir = mkdtempSync(join(tmpdir(), "ceraui-private-fifo-"));
		const path = join(dir, name === "maintenance" ? "agent.json" : name);
		const fifo = Bun.spawn(["mkfifo", "-m", "600", path]);
		expect(await fifo.exited).toBe(0);
		const before = lstatSync(path);
		try {
			const source = `
				const { readOsJobFile } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-job-files.ts"))});
				const { reconcileOsStageStartup, osUpdateAdmissionReady } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-startup.ts"))});
				const { fileRecoveryStore } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/recovery-store.ts"))});
				let disposed = 0;
				try { await reconcileOsStageStartup({
					acquireControl: async () => ({ held: () => true, [Symbol.asyncDispose]: async () => { disposed++; } }),
					readJob: async () => { if (${JSON.stringify(name)} === "maintenance") await fileRecoveryStore(${JSON.stringify(dir)}).read("agent.json"); else await readOsJobFile(${JSON.stringify(name)}, ${JSON.stringify(dir)}, process.getuid()); throw new Error("reader accepted FIFO"); }
				}); console.log(JSON.stringify({ refused: false, disposed })); }
				catch (error) { console.log(JSON.stringify({ refused: true, disposed, ready: osUpdateAdmissionReady(), cause: error.cause?.name ?? error.name })); }
			`;
			// When the production reader runs inside actual startup, bounded by its parent.
			const child = Bun.spawn([process.execPath, "--eval", source], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const timer = setTimeout(() => child.kill(), 2000);
			const output = await new Response(child.stdout).text();
			const exit = await child.exited;
			clearTimeout(timer);
			// Then refusal disposes CONTROL, leaves admission closed and preserves provenance.
			expect(exit).toBe(0);
			expect(JSON.parse(output.trim().split("\n").at(-1) ?? "")).toMatchObject({
				refused: true,
				disposed: 1,
				ready: false,
				cause: name === "maintenance" ? "RecoveryStoreError" : "OsStageError",
			});
			const after = lstatSync(path);
			expect(after.ino).toBe(before.ino);
			expect(after.isFIFO()).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	},
);
