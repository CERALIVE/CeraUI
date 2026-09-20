import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
	SENDER_TELEMETRY_STALE_MS,
	type TelemetryUpdate,
	type WatchTelemetryHandle,
	watchTelemetry,
} from "./index";

const created: Array<string> = [];

function tmpPath(): string {
	const path = `/tmp/srtla-send-tel-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
	created.push(path);
	return path;
}

async function writeSnapshot(content: string): Promise<string> {
	const path = tmpPath();
	await Bun.write(path, content);
	return path;
}

function snapshot(lastUpdatedMs = Date.now()): string {
	return JSON.stringify({
		schema_version: 1,
		last_updated_ms: lastUpdatedMs,
		connections: [
			{
				conn_id: "0",
				rtt_ms: 42,
				nak_count: 3,
				weight_percent: 85,
				window: 8192,
				in_flight: 100,
				bitrate_bps: 2_500_000,
			},
		],
	});
}

function firstUpdate(path: string): Promise<TelemetryUpdate> {
	return new Promise((resolve) => {
		let handle: WatchTelemetryHandle | undefined;
		handle = watchTelemetry(
			path,
			(update) => {
				handle?.stop();
				resolve(update);
			},
			{ intervalMs: 2_147_483_647 },
		);
	});
}

function waitForNextEventLoopTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

afterEach(async () => {
	for (const path of created.splice(0)) {
		const deletion = Bun.file(path).delete?.();
		if (deletion !== undefined) {
			await deletion.catch(() => undefined);
		}
	}
});

describe("watchTelemetry", () => {
	test("emits null and stale immediately when the file is absent", async () => {
		const update = await firstUpdate(tmpPath());

		expect(update.data).toBeNull();
		expect(update.stale).toBe(true);
	});

	test("treats the stale boundary as live and one millisecond beyond it as stale", async () => {
		const fixedNow = 1_800_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(fixedNow);
		try {
			const boundaryPath = await writeSnapshot(
				snapshot(fixedNow - SENDER_TELEMETRY_STALE_MS),
			);
			const stalePath = await writeSnapshot(
				snapshot(fixedNow - SENDER_TELEMETRY_STALE_MS - 1),
			);

			const [boundary, stale] = await Promise.all([
				firstUpdate(boundaryPath),
				firstUpdate(stalePath),
			]);

			expect(boundary.stale).toBe(false);
			expect(stale.stale).toBe(true);
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("stop prevents queued interval reads from invoking the callback", async () => {
		const path = await writeSnapshot(snapshot());
		let calls = 0;
		let handle: WatchTelemetryHandle | undefined;
		const firstCallback = new Promise<void>((resolve) => {
			handle = watchTelemetry(
				path,
				() => {
					calls += 1;
					handle?.stop();
					resolve();
				},
				{ intervalMs: 0 },
			);
		});

		await firstCallback;
		await waitForNextEventLoopTurn();
		await waitForNextEventLoopTurn();

		expect(calls).toBe(1);
	});

	test("observes a snapshot that appears after the initial absent state", async () => {
		const fixedNow = 1_800_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(fixedNow);
		const path = tmpPath();
		let writeStarted = false;
		let handle: WatchTelemetryHandle | undefined;
		try {
			const liveUpdate = new Promise<TelemetryUpdate>((resolve, reject) => {
				handle = watchTelemetry(
					path,
					(update) => {
						if (update.data !== null) {
							resolve(update);
							return;
						}
						if (!writeStarted) {
							writeStarted = true;
							void Bun.write(path, snapshot(fixedNow)).catch(reject);
						}
					},
					{ intervalMs: 0 },
				);
			});

			const update = await liveUpdate;

			expect(update.data?.last_updated_ms).toBe(fixedNow);
			expect(update.stale).toBe(false);
		} finally {
			handle?.stop();
			nowSpy.mockRestore();
		}
	});

	test("emits null and stale for a schema-invalid snapshot", async () => {
		const path = await writeSnapshot('{"schema_version":2,"connections":[]}');

		const update = await firstUpdate(path);

		expect(update.data).toBeNull();
		expect(update.stale).toBe(true);
	});

	test("emits the validated telemetry payload to the callback", async () => {
		const fixedNow = 1_800_000_000_000;
		const nowSpy = spyOn(Date, "now").mockReturnValue(fixedNow);
		try {
			const path = await writeSnapshot(snapshot(fixedNow));

			const update = await firstUpdate(path);

			expect(update.data?.connections[0]).toEqual({
				conn_id: "0",
				rtt_ms: 42,
				nak_count: 3,
				weight_percent: 85,
				window: 8192,
				in_flight: 100,
				bitrate_bps: 2_500_000,
			});
			expect(update.stale).toBe(false);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
