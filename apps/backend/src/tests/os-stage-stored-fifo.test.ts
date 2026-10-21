import { afterAll, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, spawn, write } from "bun";

const entrypoint = join(import.meta.dir, "fifo-startup-child.ts");
const childSource = `
	const { readOsJobFile } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-job-files.ts"))});
	const { reconcileOsStageStartup, osUpdateAdmissionReady } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-stage-startup.ts"))});
	const { fileRecoveryStore } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/recovery-store.ts"))});
	process.send("ready");
	const { dir, name } = JSON.parse(await Bun.stdin.text());
	let disposed = 0;
	try { await reconcileOsStageStartup({
		acquireControl: async () => ({ held: () => true, [Symbol.asyncDispose]: async () => { disposed++; } }),
		readJob: async () => { if (name === "maintenance") await fileRecoveryStore(dir).read("agent.json"); else await readOsJobFile(name, dir, process.getuid()); throw new Error("reader accepted FIFO"); }
	}); console.log(JSON.stringify({ refused: false, disposed })); }
	catch (error) { console.log(JSON.stringify({ refused: true, disposed, ready: osUpdateAdmissionReady(), cause: error.cause?.name ?? error.name })); }
`;
// Cold graph loading took 30–32 s; each fresh child signals readiness before a guarded read.
const compiled = await build({
	entrypoints: [entrypoint],
	files: { [entrypoint]: childSource },
	target: "bun",
});
const bundle = compiled.outputs[0];
if (!compiled.success || !bundle)
	throw new AggregateError(compiled.logs, "FIFO startup bundle failed");
const bundleRoot = mkdtempSync(join(tmpdir(), "ceraui-fifo-bundle-"));
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
const program = join(bundleRoot, "startup.js");
await write(program, bundle);
const names = ["job.json", "token", "ready", "release", "maintenance"] as const;
const children = new Map<
	(typeof names)[number],
	{
		readonly child: ReturnType<typeof spawn<"pipe", "pipe", "pipe">>;
		readonly output: Promise<readonly [string, string, number]>;
	}
>();
afterAll(async () => {
	for (const { child } of children.values()) await child[Symbol.asyncDispose]();
});
await Promise.all(
	names.map(async (name) => {
		let ready = () => {};
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const child = spawn([process.execPath, program], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			ipc: (message) => {
				if (message === "ready") ready();
			},
		});
		const output = Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		children.set(name, { child, output });
		await Promise.race([started, child.exited]);
	}),
);

test.each(names)(
	"rejects no-writer %s FIFO promptly and disposes startup CONTROL",
	async (name) => {
		// Given private provenance containing a real FIFO with no writer.
		const dir = mkdtempSync(join(tmpdir(), "ceraui-private-fifo-"));
		const path = join(dir, name === "maintenance" ? "agent.json" : name);
		const fifo = spawn(["mkfifo", "-m", "600", path]);
		expect(await fifo.exited).toBe(0);
		const before = lstatSync(path);
		try {
			// When the production reader runs inside actual startup.
			const prepared = children.get(name);
			if (!prepared) throw new Error("missing prepared FIFO child");
			prepared.child.stdin.write(JSON.stringify({ dir, name }));
			await prepared.child.stdin.end();
			const [output, stderr, exit] = await prepared.output;
			// Then refusal disposes CONTROL, leaves admission closed and preserves provenance.
			expect(exit, stderr).toBe(0);
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
