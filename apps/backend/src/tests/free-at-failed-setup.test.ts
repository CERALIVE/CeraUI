import { expect, test } from "bun:test";

// Isolate native module mocks from the real-pty lease tests.
test("failed native setup retains the actual fs.close promise on overrun", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { mock, expect } from "bun:test";
		const fs = await import("node:fs");
		let finish;
		mock.module("node:fs", () => ({ ...fs, openSync: () => 42,
			close: (_fd, callback) => { finish = callback; } }));
		mock.module("bun:ffi", () => ({ FFIType: {}, ptr: () => 0,
			dlopen: () => ({ symbols: { ioctl: () => -1 } }) }));
		const { openExclusiveRawTty, TtyOpenError } = await import(${JSON.stringify(new URL("../modules/modems/free-at-tty.ts", import.meta.url).pathname)});
		let error;
		try { await openExclusiveRawTty("/synthetic/tty"); } catch (e) { error = e; }
		expect(error).toBeInstanceOf(TtyOpenError);
		expect(error.failure).toBe("stuck");
		expect(error.cleanup).toBeInstanceOf(Promise);
		let settled = false;
		error.cleanup.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await error.cleanup;
		expect(settled).toBe(true);
	`,
		],
		{ stdout: "pipe", stderr: "pipe", env: process.env },
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
});
