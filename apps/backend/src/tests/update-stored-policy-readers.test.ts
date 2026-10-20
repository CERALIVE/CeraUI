import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, spawn, write } from "bun";

const readers = ["serial", "receipt", "quarantine", "pending"] as const;
const faults = ["absent", "directory", "symlink", "denied", "fifo"] as const;

const entrypoint = join(import.meta.dir, "policy-reader-child.ts");
const childSource = `
	const dir = process.env.CERALIVE_POLICY_DIR;
	const reader = process.env.CERALIVE_POLICY_READER;
	if (!dir || !reader) throw new TypeError("missing policy fixture input");
	const nativeFile = Bun.file;
	Bun.file = (path, options) => nativeFile(path === "/data/ceralive/update-state/os-staged.json" ? dir + "/os-staged.json" : path, options);
	const { readManifestSerial, readStagedReceipt } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/os-agent.ts"))});
	const { UpdateQuarantine } = await import(${JSON.stringify(join(import.meta.dir, "../modules/system/update-orchestrator/quarantine.ts"))});
	const q = new UpdateQuarantine(dir + "/quarantine.json");
	if (!process.send) throw new TypeError("missing policy fixture IPC");
	process.send("ready");
	await Bun.stdin.text();
	process.disconnect();
	try { const value = await (reader === "serial" ? readManifestSerial("stable", dir) : reader === "receipt" ? readStagedReceipt(dir) : reader === "pending" ? q.readPending() : q.isOsVersionQuarantined("2026.10.0")); console.log(JSON.stringify({ accepted: true, value })); }
	catch (error) { console.log(JSON.stringify({ accepted: false, name: error.name, code: error.code })); }
`;
// Bundle real readers once: contended source loading took >5 s before any read.
const compiled = await build({
	entrypoints: [entrypoint],
	files: { [entrypoint]: childSource },
	target: "bun",
});
const bundle = compiled.outputs[0];
if (!compiled.success || !bundle)
	throw new AggregateError(compiled.logs, "policy reader bundle failed");
const bundleRoot = mkdtempSync(join(tmpdir(), "ceraui-policy-bundle-"));
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
const program = join(bundleRoot, "reader.js");
await write(program, bundle);

// Bundled startup/evaluation still took 18.6 s under load; readiness precedes the read guard.
const fixtures = await Promise.all(
	readers.flatMap((reader) =>
		faults.map(async (fault) => {
			const dir = mkdtempSync(join(tmpdir(), "ceraui-policy-reader-"));
			const ready = Promise.withResolvers<void>();
			const child = spawn([process.execPath, program], {
				env: {
					...process.env,
					CERALIVE_POLICY_DIR: dir,
					CERALIVE_POLICY_READER: reader,
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				ipc(message: unknown) {
					if (message === "ready") ready.resolve();
				},
				onExit(_child, code, signal, error) {
					ready.reject(
						error ??
							new TypeError(
								`policy child exited before readiness: ${code}/${signal}`,
							),
					);
				},
			});
			const output = new Response(child.stdout).text();
			const errors = new Response(child.stderr).text();
			afterAll(async () => {
				child.kill();
				await child.exited;
				rmSync(dir, { recursive: true, force: true });
			});
			await ready.promise;
			return { reader, fault, dir, child, output, errors };
		}),
	),
);

for (const { reader, fault, dir, child, output, errors } of fixtures) {
	test(`${reader} refuses ${fault} evidence except genuine absence`, async () => {
		// Given a real filesystem entry, separate from the missing-entry control.
		await using proc = child;
		const path = join(
			dir,
			reader === "serial"
				? "manifest-serial.stable"
				: reader === "receipt"
					? "os-staged.json"
					: reader === "pending"
						? "quarantine.json.pending"
						: "quarantine.json",
		);
		try {
			switch (fault) {
				case "absent":
					break;
				case "directory":
					mkdirSync(path);
					break;
				case "symlink":
					symlinkSync(join(dir, "missing-target"), path);
					break;
				case "denied":
					await write(path, "0\n");
					chmodSync(path, 0);
					break;
				case "fifo": {
					const child = spawn(["mkfifo", "-m", "600", path]);
					expect(await child.exited).toBe(0);
					break;
				}
			}
			// When each real reader is invoked in a bounded process (FIFO has no writer).
			await proc.stdin.end();
			const [stdout, stderr, exit] = await Promise.all([
				output,
				errors,
				proc.exited,
			]);
			// Then refusal is prompt, with the entry retained; absence alone has defaults.
			expect(exit, stderr).toBe(0);
			expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toMatchObject({
				accepted: fault === "absent",
			});
			if (fault !== "absent") expect(lstatSync(path)).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
