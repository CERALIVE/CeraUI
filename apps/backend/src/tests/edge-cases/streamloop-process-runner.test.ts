import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onLogLine } from "../../helpers/logger.ts";
import { resolveProcessError } from "../../modules/streaming/streamloop/process-error-patterns.ts";

// Edge-case hardening for the stream subprocess supervisor
// (streamloop/process-runner.ts). This is the layer that owns every live
// srtla_send process. The device relies on three invariants here:
//
//   1. stderr is drained and every chunk is routed to the per-process error
//      callback (that callback is how a "Failed to establish any initial
//      connections" / capture-card error becomes a user-facing notification);
//   2. when a supervised process dies it is removed from the supervised list and
//      NOT respawned (ADR-0005: systemd is the sole restart authority);
//   3. stopProcess() reports whether the kill is synchronous (already dead) or
//      pending (SIGTERM sent to a live process).
//
// These drive the REAL spawn path against short-lived `bun -e` subprocesses (the
// same no-mock strategy as streamloop.test.ts) so a regression in the supervision
// seam is actually caught, not stubbed away.

import {
	getStreamingProcesses,
	type StreamingProcess,
	spawnStreamingLoop,
	stopProcess,
} from "../../modules/streaming/streamloop/process-runner.ts";

// getStreamingProcesses() is re-fetched on every read because removeProc()
// REASSIGNS the backing array — a reference captured earlier goes stale.
async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return predicate();
}

test("captures the sender tracing writer without widening stderr notifications", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sender-stdio-"));
	const command = join(dir, "srtla_send");
	const timestamp = "2026-11-19T10:00:00.000000Z";
	const lines = [
		[`${timestamp} ERROR warning: no available connections`, "error"],
		[`${timestamp} TRACE retry failed`, "debug"],
		[`${timestamp} DEBUG payload warning`, "debug"],
		[`${timestamp}  INFO failed earlier`, "info"],
		[`${timestamp}  WARN fatal payload`, "warn"],
		["DEBUG: sender test retry scheduled after error", "debug"],
		["<3>sender test literal priority", "info"],
		[
			'{"ts":"2026-01-01","level":"debug","msg":"sender test nested","processSource":"forged"}',
			"info",
		],
		["sender test color=1", "info"],
	] as const;
	const stderr = "thread 'main' panicked at fixture";
	const originalNoColor = process.env.NO_COLOR;
	process.env.NO_COLOR = "0";
	const seen = new Map<string, string>();
	const unsubscribe = onLogLine((line) => {
		const entry = JSON.parse(line);
		if (entry.processSource === "srtla_send" && typeof entry.msg === "string")
			seen.set(entry.msg, entry.level);
	});
	try {
		writeFileSync(
			command,
			'#!/bin/sh\nprintf \'%s\\nsender test color=%s\\n\' "$1" "$NO_COLOR"\nprintf \'%s\' "$2" >&2\n',
			{ mode: 0o700 },
		);
		const received: string[] = [];
		const sender = spawnStreamingLoop(
			{ command, role: "srtla_send" },
			[
				lines
					.slice(0, -1)
					.map(([line]) => line)
					.join("\n"),
				stderr,
			],
			(chunk) => received.push(chunk),
		);
		expect(await sender.proc.exited).toBe(0);
		await waitUntil(() => seen.size >= lines.length + 1, 750);
		expect(received.join("")).toBe(stderr);
		expect(
			received.map((chunk) => resolveProcessError("srtla", chunk)),
		).toEqual(received.map(() => undefined));
		expect(seen).toEqual(
			new Map(
				[...lines, [stderr, "error"]].map(([msg, level]) => [
					`srtla_send: ${msg}`,
					level,
				]),
			),
		);
	} finally {
		if (originalNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = originalNoColor;
		unsubscribe();
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	["oversized", `${"€".repeat(8000)}\nsender test resumed\n`, ""],
	["oversized at EOF", "", "x".repeat(24_000)],
	["burst", "sender test burst\n".repeat(50), "sender test burst\n".repeat(50)],
] as const)(
	"bounds %s sender output without cutting off the stderr callback",
	async (kind, stderr, stdout) => {
		const dir = mkdtempSync(join(tmpdir(), "sender-bounds-"));
		const command = join(dir, "srtla_send");
		const seen: unknown[] = [];
		const unsubscribe = onLogLine((line) => {
			const entry = JSON.parse(line);
			if (typeof entry.msg === "string" && entry.msg.startsWith("srtla_send: "))
				seen.push(
					entry.meta ? [entry.msg, entry.level, entry.meta] : entry.msg,
				);
		});
		try {
			writeFileSync(
				command,
				"#!/bin/sh\nprintf '%s' \"$1\" >&2\nprintf '%s' \"$2\"\n",
				{ mode: 0o700 },
			);
			const received: string[] = [];
			const sender = spawnStreamingLoop(
				{ command, role: "srtla_send" },
				[stderr, stdout],
				(chunk) => {
					received.push(chunk);
				},
			);
			expect(await sender.proc.exited).toBe(0);
			if (kind === "oversized") {
				await waitUntil(
					() => seen.includes("srtla_send: sender test resumed"),
					750,
				);
				const [truncated, resumed] = seen;
				expect(seen).toHaveLength(2);
				expect(truncated).toBe(`srtla_send: ${"€".repeat(2730)} [truncated]`);
				expect(resumed).toBe("srtla_send: sender test resumed");
				expect(received.join("").endsWith("\nsender test resumed\n")).toBe(
					true,
				);
			} else if (kind === "oversized at EOF") {
				await waitUntil(() => seen.length > 0, 750);
				expect(seen).toEqual([`srtla_send: ${"x".repeat(8192)} [truncated]`]);
				expect(received).toEqual([]);
			} else {
				await waitUntil(() => seen.some(Array.isArray), 1500);
				expect(seen).toEqual([
					...Array<string>(32).fill("srtla_send: sender test burst"),
					["srtla_send: output lines dropped", "warn", { dropped: 68 }],
				]);
				expect(received.join("")).toBe(stderr);
			}
		} finally {
			unsubscribe();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

function spawnAndCapture(
	command: string,
	args: string[],
	cb: (data: string) => void,
): StreamingProcess {
	return spawnStreamingLoop(command, args, cb);
}

describe("process-runner: stderr is drained into the error callback", () => {
	test("stores sender lines at their own severity while delivering unchanged stderr", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sender-stderr-"));
		const command = join(dir, "srtla_send");
		const lines = [
			["Info: waiting for peers", "info"],
			["WARN: retrying", "warn"],
			["Warning: slow peer", "warn"],
			["Error opening socket", "error"],
			["Fatal startup", "error"],
			["Failed to establish any initial connections", "error"],
			["Cannot bind", "error"],
			["Could not read addresses", "error"],
			["Unable to connect", "error"],
		] as const;
		const stderr = lines.map(([line]) => line).join("\n");
		const seen: unknown[] = [];
		const unsubscribe = onLogLine((line) => {
			const entry = JSON.parse(line);
			if (typeof entry.msg === "string" && entry.msg.startsWith("srtla_send: "))
				seen.push([entry.msg, entry.level]);
		});
		try {
			writeFileSync(command, "#!/bin/sh\nprintf '%s' \"$1\" >&2\n", {
				mode: 0o700,
			});
			const received: string[] = [];
			const sender = spawnStreamingLoop(
				{ command, role: "srtla_send" },
				[stderr],
				(chunk) => {
					received.push(chunk);
				},
			);
			expect(await sender.proc.exited).toBe(0);
			await waitUntil(() => seen.length >= lines.length, 750);
			expect(received.join("")).toBe(stderr);
			expect(resolveProcessError("srtla", received.join(""))?.code).toBe(
				"srtla_initial_connect_failed",
			);
			expect(seen).toEqual(
				lines.map(([line, level]) => [`srtla_send: ${line}`, level]),
			);
		} finally {
			unsubscribe();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("each stderr chunk reaches the per-process error callback in order", async () => {
		const received: string[] = [];
		// Emit a known srtla-style error line on stderr, then exit cleanly.
		const script =
			'process.stderr.write("Failed to establish any initial connections\\n"); process.exit(0);';
		const mine = spawnAndCapture("bun", ["-e", script], (data) => {
			received.push(data);
		});

		// Wait until the callback has seen the line (stderr drain is async).
		await waitUntil(() =>
			received.join("").includes("Failed to establish any initial connections"),
		);
		// And until the process has been reaped from the supervised list.
		await waitUntil(() => !getStreamingProcesses().includes(mine));

		const all = received.join("");
		expect(all).toContain("Failed to establish any initial connections");
	});
});

describe("process-runner: a dead process is removed, never respawned", () => {
	test("non-zero exit removes the process from the supervised list", async () => {
		const script = 'process.stderr.write("boom\\n"); process.exit(7);';
		const mine = spawnAndCapture("bun", ["-e", script], () => {});

		// Present immediately after spawn...
		expect(getStreamingProcesses()).toContain(mine);

		// ...and gone once it exits (ADR-0005 observe-and-notify cleanup). If the
		// removeProc() call in the exit listener regressed, this would time out
		// with the dead process still supervised.
		const removed = await waitUntil(
			() => !getStreamingProcesses().includes(mine),
		);
		expect(removed).toBe(true);

		// The supervisor must NOT have respawned a replacement: no entry sharing
		// the same spawnfile lingers from this process.
		expect(getStreamingProcesses()).not.toContain(mine);
	});
});

describe("process-runner: stopProcess reports live-vs-already-dead", () => {
	test("stopProcess on a live process returns false, SIGTERMs it, then it is reaped", async () => {
		// A process that stays alive until signalled.
		const script = "setInterval(() => {}, 1000);";
		const mine = spawnAndCapture("bun", ["-e", script], () => {});
		expect(getStreamingProcesses()).toContain(mine);

		// Live process: the kill is asynchronous, so stopProcess returns false
		// (caller must wait for the exit listener rather than proceed immediately).
		const result = stopProcess(mine);
		expect(result).toBe(false);

		// SIGTERM was sent; the cleanup listener removes it once it dies.
		const removed = await waitUntil(
			() => !getStreamingProcesses().includes(mine),
		);
		expect(removed).toBe(true);
	});
});
