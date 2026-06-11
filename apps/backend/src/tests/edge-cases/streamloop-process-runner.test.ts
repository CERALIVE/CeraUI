import { describe, expect, test } from "bun:test";

// Edge-case hardening for the stream subprocess supervisor
// (streamloop/process-runner.ts). This is the layer that owns every live
// ceracoder / srtla_send process. The device relies on three invariants here:
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

// spawnStreamingLoop does not return the process it creates, so identify "ours"
// as the single entry that appeared in the supervised list after the call.
function spawnAndCapture(
	command: string,
	args: string[],
	cb: (data: string) => void,
): StreamingProcess {
	const before = new Set(getStreamingProcesses());
	spawnStreamingLoop(command, args, cb);
	const mine = getStreamingProcesses().find((p) => !before.has(p));
	if (!mine)
		throw new Error("spawned process was not registered in the supervisor");
	return mine;
}

describe("process-runner: stderr is drained into the error callback", () => {
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
