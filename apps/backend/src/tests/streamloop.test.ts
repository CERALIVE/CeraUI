import { describe, expect, test } from "bun:test";

// streamloop.ts reads subprocess output via Bun.spawn async iteration and
// detects exit via `await proc.exited`. These tests exercise that exact
// mechanism against real subprocesses (no mocks) to lock in two guarantees the
// supervisor relies on: output arrives in order, and a non-zero exit is
// observable to the caller rather than silently swallowed.

describe("streamloop subprocess stream semantics", () => {
	test("all subprocess output delivered in order, exit 0 detected", async () => {
		const N = 10;
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				`for (let i = 0; i < ${N}; i++) { process.stdout.write("line " + i + "\\n"); } process.exit(0);`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const lines: string[] = [];
		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk);
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			lines.push(...parts.filter((l) => l.length > 0));
		}

		const exitCode = await proc.exited;

		expect(exitCode).toBe(0);
		expect(lines).toHaveLength(N);
		for (let i = 0; i < N; i++) {
			expect(lines[i]).toBe(`line ${i}`);
		}
	});

	test("subprocess crash surfaces error, no silent swallow", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				`process.stdout.write("partial output\\n"); process.exit(1);`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const lines: string[] = [];
		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk);
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			lines.push(...parts.filter((l) => l.length > 0));
		}

		const exitCode = await proc.exited;

		expect(lines).toContain("partial output");
		expect(exitCode).not.toBe(0);
		expect(exitCode).toBe(1);
	});
});
