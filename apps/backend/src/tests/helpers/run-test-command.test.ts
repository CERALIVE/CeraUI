import { expect, test } from "bun:test";
import { runTestCommand } from "./run-test-command.ts";

test("collects both output pipes and preserves a failed command's exit status", async () => {
	const result = await runTestCommand([
		process.execPath,
		"-e",
		'process.stdout.write("o".repeat(262144)); process.stderr.write("e".repeat(262144)); process.exitCode = 7;',
	]);
	expect(result).toEqual({
		code: 7,
		stdout: "o".repeat(262144),
		stderr: "e".repeat(262144),
	});
});

test("collects a real child after GC poisons Bun's synchronous spawn loop", async () => {
	const helperUrl = new URL("./run-test-command.ts", import.meta.url).href;
	// Upstream reproducer: oven-sh/bun#40078. Keep poisoning inside a disposable VM.
	const result = await runTestCommand(
		[
			process.execPath,
			"-e",
			`
import { runTestCommand } from ${JSON.stringify(helperUrl)};
globalThis.writers = [];
const refs = [];
for (let i = 0; i < 3; i++) {
  const writer = Bun.stderr.writer();
  writer.write("");
  writer.flush();
  globalThis.writers.push(writer);
  refs.push(new WeakRef(writer));
}
await Bun.sleep(0);
const warmup = { cmd: ["echo", "first"], stdout: "pipe", stderr: "ignore", timeout: 2000 };
Bun.spawnSync(warmup);
globalThis.writers = null;
Bun.spawnSync(warmup);
let collectedDuringCall = 0;
for (const ref of refs) if (ref.deref() === undefined) collectedDuringCall++;
const child = await runTestCommand(["sh", "-c", "sleep 0.3; echo second"]);
console.log(JSON.stringify({ collectedDuringCall, ...child }));
`,
		],
		{ env: { BUN_JSC_slowPathAllocsBetweenGCs: "5" } },
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		collectedDuringCall: 3,
		code: 0,
		stdout: "second\n",
		stderr: "",
	});
});
