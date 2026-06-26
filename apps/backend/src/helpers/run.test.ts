import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	ALLOWED,
	DEFAULT_TIMEOUT_MS,
	RunAbortError,
	RunTimeoutError,
	run,
	runWithStdin,
} from "./run.ts";

// `sleep`/`bun` are NOT part of the production allowlist (which stays exactly the
// 13 entries defined in run.ts). They are added for the lifetime of THIS suite
// only — so the timeout/abort paths can be exercised against a real sleeping
// child — and removed again in afterAll. The source allowlist is never edited.
const TEST_BINS = ["sleep", "bun"] as const;

beforeAll(() => {
	for (const b of TEST_BINS) ALLOWED.add(b);
});
afterAll(() => {
	for (const b of TEST_BINS) ALLOWED.delete(b);
});

describe("run() timeout + abort (Standard S1)", () => {
	test("DEFAULT_TIMEOUT_MS is 30s", () => {
		expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
	});

	test("a child sleeping past the timeout rejects with RunTimeoutError within budget", async () => {
		const start = Date.now();
		let caught: unknown;
		try {
			await run("sleep", ["10"], { timeout: 150 });
		} catch (err) {
			caught = err;
		}
		const elapsed = Date.now() - start;

		expect(caught).toBeInstanceOf(RunTimeoutError);
		expect((caught as RunTimeoutError).name).toBe("RunTimeoutError");
		expect((caught as RunTimeoutError).cmd).toContain("sleep");
		expect(elapsed).toBeLessThan(3000);
	});

	test("an aborted call cancels and rejects with RunAbortError", async () => {
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(), 50);

		let caught: unknown;
		try {
			await run("sleep", ["10"], { timeout: 30_000, signal: ctrl.signal });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(RunAbortError);
		expect((caught as RunAbortError).name).toBe("RunAbortError");
		expect((caught as RunAbortError).cmd).toContain("sleep");
	});

	test("an already-aborted signal rejects before the child is spawned", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(
			run("sleep", ["10"], { signal: ctrl.signal }),
		).rejects.toBeInstanceOf(RunAbortError);
	});

	test("partial stdout is preserved on RunTimeoutError", async () => {
		let caught: unknown;
		try {
			await run(
				"bun",
				["-e", "process.stdout.write('partial-out'); await Bun.sleep(10000);"],
				{ timeout: 1500 },
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(RunTimeoutError);
		expect((caught as RunTimeoutError).partialStdout).toContain("partial-out");
	});

	test("runWithStdin() honours the timeout too", async () => {
		await expect(
			runWithStdin("bun", ["-e", "await Bun.sleep(10000);"], "", {
				timeout: 150,
			}),
		).rejects.toBeInstanceOf(RunTimeoutError);
	});
});

describe("run() normal behaviour (unchanged)", () => {
	test("a successful command resolves with its stdout", async () => {
		const out = await run("bun", ["-e", "process.stdout.write('hello-ok')"]);
		expect(out).toContain("hello-ok");
	});

	test("runWithStdin() feeds stdin and resolves with stdout", async () => {
		const out = await runWithStdin("grep", ["foo"], "foo\nbar\nfoobar\n");
		const lines = out.split("\n").filter((line) => line.length > 0);
		expect(lines).toEqual(["foo", "foobar"]);
	});

	test("a non-zero exit rejects with the code attached", async () => {
		let caught: unknown;
		try {
			await run("bun", ["-e", "process.exit(3)"]);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as { code: number }).code).toBe(3);
	});
});

describe("allowlist enforcement (unchanged)", () => {
	test("run() rejects a non-allowlisted binary", async () => {
		await expect(run("cat", ["/etc/hostname"])).rejects.toThrow(
			"binary not allowlisted: cat",
		);
	});

	test("runWithStdin() rejects a non-allowlisted binary", async () => {
		await expect(runWithStdin("cat", [], "x")).rejects.toThrow(
			"binary not allowlisted: cat",
		);
	});
});
