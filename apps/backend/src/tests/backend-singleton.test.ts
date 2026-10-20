import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	acquireBackendSingleton,
	BackendSingletonError,
	enforceBackendSingleton,
} from "../helpers/backend-singleton.ts";

test("main acquires singleton ownership before the control bind and update startup", async () => {
	const source = await Bun.file(new URL("../main.ts", import.meta.url)).text();
	const lock = source.indexOf(
		'await runCritical("backend-singleton", enforceBackendSingleton)',
	);
	const startup = source.indexOf('void guardNonCritical("update-bootstrap",');
	const bind = source.indexOf('await runCritical("ws-control-server"');
	expect(lock).toBeGreaterThan(0);
	expect(bind).toBeGreaterThan(0);
	expect(startup).toBeGreaterThan(0);
	expect(lock).toBeLessThan(bind);
	expect(bind).toBeLessThan(startup);
	expect(lock).toBeLessThan(startup);
});

test("only genuine directory creation failure permits singleton fallback", async () => {
	await enforceBackendSingleton(async () => {
		throw new BackendSingletonError("directory-unavailable");
	});
	for (const reason of ["contended", "unproven"] as const) {
		await expect(
			enforceBackendSingleton(async () => {
				throw new BackendSingletonError(reason);
			}),
		).rejects.toHaveProperty("reason", reason);
	}
});

test("a missing directory is distinct from a symlink or missing helper", async () => {
	const root = mkdtempSync(join(tmpdir(), "backend-singleton-errors-"));
	try {
		await expect(
			acquireBackendSingleton({
				lock: join(root, "absent", "lock"),
				helper: "/missing",
			}),
		).rejects.toHaveProperty("reason", "directory-unavailable");
		symlinkSync(join(root, "target"), join(root, "lock"));
		await expect(
			acquireBackendSingleton({ lock: join(root, "lock"), helper: "/missing" }),
		).rejects.toHaveProperty("reason", "unproven");
		await expect(
			acquireBackendSingleton({
				lock: join(root, "regular"),
				helper: "/missing",
			}),
		).rejects.toHaveProperty("reason", "unproven");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("real backends exclude a second process and admit replacement after SIGKILL", async () => {
	// Given a real flock/helper owner with readiness delivered through its stdout.
	const root = mkdtempSync(join(tmpdir(), "backend-singleton-process-"));
	const paths = {
		lock: join(root, "lock"),
		helper: resolve("../../deployment/ceralive-os-stage-guard"),
	};
	const module = new URL("../helpers/backend-singleton.ts", import.meta.url)
		.pathname;
	const source = `import { acquireBackendSingleton, enforceBackendSingleton } from ${JSON.stringify(module)};
await enforceBackendSingleton(() => acquireBackendSingleton(${JSON.stringify(paths)}));
process.stdout.write("backend-ready\\n"); setInterval(() => {}, 60000);`;
	const children: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>[] = [];
	const spawn = () => {
		const child = Bun.spawn([process.execPath, "--eval", source], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.push(child);
		return child;
	};
	const ready = async (child: ReturnType<typeof spawn>) => {
		const reader = child.stdout.getReader();
		try {
			const value = await reader.read();
			expect(new TextDecoder().decode(value.value)).toBe("backend-ready\n");
		} finally {
			reader.releaseLock();
		}
	};
	try {
		const first = spawn();
		await ready(first);
		// When another process starts while the owner is alive, it must fail nonzero.
		const second = spawn();
		expect(await second.exited).not.toBe(0);
		expect(first.exitCode).toBeNull();
		expect(await new Response(second.stderr).text()).toContain("contended");
		first.kill("SIGKILL");
		await first.exited;
		// Wait on kernel acquisition, not a sleep or a guessed EOF scheduling delay.
		const released = Bun.spawn(
			["/usr/bin/flock", "-x", paths.lock, "/usr/bin/true"],
			{ stdout: "ignore", stderr: "pipe" },
		);
		expect(await released.exited).toBe(0);
		// Then a new process (the Restart=always lifecycle shape) acquires normally.
		const replacement = spawn();
		await ready(replacement);
		expect(replacement.exitCode).toBeNull();
	} finally {
		for (const child of children)
			if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all(children.map((child) => child.exited));
		const released = Bun.spawn(
			["/usr/bin/flock", "-x", paths.lock, "/usr/bin/true"],
			{ stdout: "ignore", stderr: "pipe" },
		);
		await released.exited;
		rmSync(root, { recursive: true });
	}
});
