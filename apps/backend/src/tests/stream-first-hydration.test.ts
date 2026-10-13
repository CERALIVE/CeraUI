import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getStreamLifecycleState,
	updateStreamLifecycleState,
} from "../modules/streaming/stream-lifecycle-status.ts";
import * as ssh from "../modules/system/ssh.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import { idleProductionHarness } from "./helpers/stream-idle-production.ts";

let directory = "";
let sentinel = "";
let previous: string | undefined;
let h: ReturnType<typeof idleProductionHarness> | undefined;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "fix16-b2c-hydration-"));
	sentinel = join(directory, "streaming");
	previous = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = sentinel;
	updateStreamLifecycleState("idle");
});
afterEach(async () => {
	await h?.dispose();
	h = undefined;
	updateStreamLifecycleState("idle");
	if (previous === undefined) delete process.env.CERALIVE_STREAMING_MARKER;
	else process.env.CERALIVE_STREAMING_MARKER = previous;
	await rm(directory, { recursive: true, force: true });
});

for (const protectedBoot of [true, false]) {
	test(
		protectedBoot
			? "first hydration cannot publish idle beside retained boot protection"
			: "unprotected boot still hydrates idle",
		() => {
			// Given real boot protection (or a positively absent sentinel).
			if (protectedBoot) writeFileSync(sentinel, "");
			const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
				() => undefined,
			);
			const refresh = spyOn(ssh, "getSshStatus").mockImplementation(async () =>
				ssh.getCachedSshStatus(),
			);
			try {
				// When composition and real hydration run before any reconciliation.
				const harness = idleProductionHarness(directory, {
					setLifecycleState: updateStreamLifecycleState,
				});
				h = harness;
				const initial = buildInitialStatus();
				// Then literal wire/state/file oracles agree without a broadcast/query.
				if (protectedBoot) {
					expect(getStreamLifecycleState()).toBe("reconciling");
					expect(initial.status.stream_lifecycle).toBe("reconciling");
					expect(harness.session.snapshot()).toEqual({
						state: "reconciling",
						generation: 0,
					});
					expect(harness.session.streamLiveness()).toBe("unknown");
					expect(existsSync(sentinel)).toBe(true);
				} else {
					expect(getStreamLifecycleState()).toBe("idle");
					expect(initial.status.stream_lifecycle).toBe("idle");
					expect(harness.session.streamLiveness()).toBe("idle");
					expect(existsSync(sentinel)).toBe(false);
				}
				expect(initial.status.is_streaming).toBe(false);
				expect(harness.calls()).toEqual([]);
				expect(broadcast).not.toHaveBeenCalled();
			} finally {
				broadcast.mockRestore();
				refresh.mockRestore();
			}
		},
	);
}

test("first reconciliation publishes the seeded protected state once", async () => {
	// Given state-only composition with no constructor broadcast.
	writeFileSync(sentinel, "");
	const broadcast = spyOn(websocket, "broadcastMsg").mockImplementation(
		() => undefined,
	);
	try {
		const harness = idleProductionHarness(directory, {
			setLifecycleState: updateStreamLifecycleState,
		});
		h = harness;
		expect(broadcast).not.toHaveBeenCalled();
		// When the first reconciliation starts while the engine is silent.
		const observing = harness.session.reconcile();
		expect(broadcast).toHaveBeenCalledWith("status", {
			stream_lifecycle: "reconciling",
		});
		await harness.expireProbe();
		await observing;
		// Then protected hydration remains honest without automatic Stop.
		expect(getStreamLifecycleState()).toBe("reconciling");
		expect(existsSync(sentinel)).toBe(true);
		expect(harness.calls().filter((call) => call === "stop")).toEqual([]);
	} finally {
		broadcast.mockRestore();
	}
});
