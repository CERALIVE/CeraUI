import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupConfigSchema } from "../helpers/config-schemas.ts";

const entrypoint = join(import.meta.dir, "transport-setup-child.ts");
const childSource = `
const { prepareUpdateTransportSetup } = await import(${JSON.stringify(`${import.meta.dir}/fixtures/update-transport-setup.ts`)});
await prepareUpdateTransportSetup(process.argv[2]);
await import(${JSON.stringify(`${import.meta.dir}/../modules/setup.ts`)});
await import(${JSON.stringify(`${import.meta.dir}/../modules/system/update-transport/executor.ts`)});
process.send("ready");
await Bun.stdin.text();`;
// Real preparation/imports precede readiness; the guard still detects a child that cannot exit.
const compiled = await Bun.build({
	entrypoints: [entrypoint],
	files: { [entrypoint]: childSource },
	target: "bun",
});
const bundle = compiled.outputs[0];
if (!compiled.success || !bundle)
	throw new AggregateError(compiled.logs, "transport setup bundle failed");
const bundleRoot = mkdtempSync(join(tmpdir(), "update-transport-bundle-"));
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
const program = join(bundleRoot, "setup.js");
await Bun.write(program, bundle);
// Given an empty private cwd, without the bun:test setup mock in the child.
const root = await mkdtemp(join(tmpdir(), "update-transport-setup-"));
const deviceRoot = join(root, "device");
await mkdir(deviceRoot);
let ready = () => {};
const started = new Promise<void>((resolve) => {
	ready = resolve;
});
// When the same fixture preparation used by the netns client runs.
const child = Bun.spawn([process.execPath, program, deviceRoot], {
	cwd: root,
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
afterAll(async () => {
	await child[Symbol.asyncDispose]();
	await rm(root, { recursive: true, force: true });
});
await Promise.race([started, child.exited]);

test("transport fixture loads real setup and selector in a plain Bun child without privileges", async () => {
	await child.stdin.end();
	const [stdout, stderr, exit] = await output;
	// Then the real strict loader accepts its emitted metadata, without probes.
	expect(exit, `${stdout}\n${stderr}`).toBe(0);
	const written: unknown = await Bun.file(
		join(deviceRoot, "setup.json"),
	).json();
	expect(setupConfigSchema.parse(written).hw).toBe("rk3588");
});
