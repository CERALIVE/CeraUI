import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CerastreamConnectionError } from "@ceralive/cerastream";
import { getConfigFilePath, setConfigFilePath } from "../modules/config.ts";
import { cerastreamBackend } from "../modules/streaming/cerastream-backend.ts";
import { runStreamRestoration } from "../modules/streaming/stream-restoration.ts";
import {
	getStreamSessionSnapshot,
	reconcileStreamSession,
	startStreamSession,
	stopStreamSession,
} from "../modules/streaming/stream-session-orchestrator.ts";
import { getIsStreaming } from "../modules/streaming/streaming.ts";
import {
	notificationBroadcast,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";

afterEach(async () => {
	const query = spyOn(
		cerastreamBackend,
		"reconcileRuntimeState",
	).mockResolvedValue("idle");
	await reconcileStreamSession();
	query.mockRestore();
});

test("engine loss settles a failed stop and reconciles idle before the one restoration launch", async () => {
	// Given the real lifecycle with a live session and an armed same-boot marker.
	const dir = await mkdtemp(join(tmpdir(), "engine-loss-lifecycle-"));
	const previousPath = getConfigFilePath();
	setConfigFilePath(join(dir, "config.json"));
	const failure = new CerastreamConnectionError(
		"engine exited",
		undefined,
		"closed",
	);
	const stop = spyOn(cerastreamBackend, "stop").mockImplementation(
		(_done, failed) => {
			failed?.(failure);
			return true;
		},
	);
	const query = spyOn(
		cerastreamBackend,
		"reconcileRuntimeState",
	).mockResolvedValue("idle");
	let marker = JSON.stringify({
		bootId: "boot-test",
		armedAt: 1,
		config: { pipeline: "hdmi" },
	});
	let clock = 0;
	let launches = 0;
	try {
		await startStreamSession({ origin: "ui", launch: async () => {} });
		expect(getIsStreaming()).toBe(true);
		notificationBroadcast(
			"stream_recovery_failed",
			"error",
			"previous recovery failed",
			0,
			true,
		);
		expect(notificationExists("stream_recovery_failed")).toBeDefined();

		// When the stop dial fails before systemd has restarted the engine.
		const stopped = await stopStreamSession("engine_loss");
		expect(stopped).toEqual({ result: "stop_failed", reason: failure.message });
		expect(getStreamSessionSnapshot().state).toBe("stop_failed");
		expect(getIsStreaming()).toBe(true);
		const result = await runStreamRestoration({
			marker: {
				markerPath: join(dir, "armed.json"),
				readMarker: () => marker,
				writeMarker: (_path, value) => {
					marker = value;
				},
				removeMarker: () => {
					marker = "";
				},
				readBootId: () => "boot-test",
			},
			awaitRecovery: async () => {},
			now: () => clock,
			wait: async (ms) => {
				clock += ms;
			},
			launch: async () => {
				launches += 1;
				expect(getStreamSessionSnapshot().state).toBe("idle");
				expect(getIsStreaming()).toBe(false);
				const started = await startStreamSession({
					origin: "restoration",
					launch: async () => {},
				});
				return started.result === "started"
					? { ok: true }
					: { ok: false, reason: "start_busy" };
			},
		});

		// Then authoritative idle clears stale ownership; a real new start is admitted.
		expect(result.result).toBe("recovered");
		expect(launches).toBe(1);
		expect(notificationExists("stream_recovery_failed")).toBeUndefined();
		expect(getStreamSessionSnapshot().state).toBe("streaming");
	} finally {
		notificationRemove("stream_recovery_failed");
		await reconcileStreamSession();
		stop.mockRestore();
		query.mockRestore();
		setConfigFilePath(previousPath);
		await rm(dir, { recursive: true, force: true });
	}
}, 20_000);
