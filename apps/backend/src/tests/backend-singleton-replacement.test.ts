import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.each(["controlled tick", "real 2-second cadence"])(
	"a replaced singleton path refuses a contender and terminates its original backend (%s)",
	async (mode) => {
		// Given a real backend and the unmodified shipped observer, with a controlled tick.
		const root = await mkdtemp(
			join(tmpdir(), "backend-singleton-replacement-"),
		);
		const paths = {
			lock: join(root, "lock"),
			helper: resolve("../../deployment/ceralive-os-stage-guard"),
		};
		const module = new URL("../helpers/backend-singleton.ts", import.meta.url)
			.pathname;
		const source = `import { acquireBackendSingleton, enforceBackendSingleton } from ${JSON.stringify(module)};
let tick; const clock = { schedule: (callback, ms) => { tick = callback; return () => { tick = undefined; }; } };
await enforceBackendSingleton(() => acquireBackendSingleton(${JSON.stringify(paths)}${mode === "controlled tick" ? ", clock" : ""}));
process.stdout.write("backend-ready\\n");
for await (const chunk of Bun.stdin.stream()) { if (tick) await tick(); }
setInterval(() => {}, 60000);`;
		const children: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>[] = [];
		const spawn = () => {
			const child = Bun.spawn([process.execPath, "--eval", source], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			children.push(child);
			return child;
		};
		try {
			const first = spawn();
			const reader = first.stdout.getReader();
			const ready = await reader.read();
			reader.releaseLock();
			expect(new TextDecoder().decode(ready.value)).toBe("backend-ready\n");
			// When root replaces the inode, the old flock remains live on the renamed file.
			await rename(paths.lock, `${paths.lock}.old`);
			await writeFile(paths.lock, "", { mode: 0o600 });
			const contender = spawn();
			const contenderReader = contender.stdout.getReader();
			const result = await contenderReader.read();
			contenderReader.releaseLock();
			// Then the holder census refuses BEFORE the old owner's periodic check runs.
			expect(new TextDecoder().decode(result.value)).not.toContain(
				"backend-ready",
			);
			expect(await contender.exited).not.toBe(0);
			expect(first.exitCode).toBeNull();
			if (mode === "controlled tick") first.stdin.write("tick\n");
			// The injected 2-second tick detects replacement through the real helper fd.
			expect(await first.exited).toBe(1);
			const logs = first.stdout.getReader();
			let output = "";
			for (;;) {
				const chunk = await logs.read();
				if (chunk.done) break;
				output += new TextDecoder().decode(chunk.value);
			}
			logs.releaseLock();
			expect(output).toContain("Backend singleton lock path identity changed");
		} finally {
			for (const child of children)
				if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.all(children.map((child) => child.exited));
			for (const lock of [paths.lock, `${paths.lock}.old`]) {
				const barrier = Bun.spawn(
					["/usr/bin/flock", "-x", lock, "/usr/bin/true"],
					{ stdout: "ignore", stderr: "ignore" },
				);
				await barrier.exited;
			}
			await rm(root, { recursive: true });
		}
	},
);
