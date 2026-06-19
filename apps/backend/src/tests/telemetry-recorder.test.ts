import { afterEach, describe, expect, it } from "bun:test";

import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	bufferedSampleCountForTest,
	flushTelemetry,
	recordTelemetryTick,
	samplesFromLinkTelemetry,
	startTelemetryRecorder,
	stopTelemetryRecorder,
	TELEMETRY_STATUS_TYPE,
	type TelemetryRecorderDeps,
} from "../modules/remote-control/telemetry-recorder.ts";
import type { LinkTelemetryMessage } from "../modules/streaming/link-telemetry.ts";

interface RelayCall {
	type: string;
	payload: unknown;
	seq: number;
}

function freshLink(
	overrides: Partial<LinkTelemetryMessage["links"][number]> = {},
) {
	return {
		conn_id: "0",
		iface: "eth0",
		rtt_ms: 42,
		nak_count: 3,
		weight_percent: 100,
		stale: false,
		...overrides,
	};
}

/** A controllable recorder harness: a fake clock, snapshot source, and relay spy. */
function harness(opts: {
	snapshot: () => LinkTelemetryMessage | null;
	maxBatch?: number;
	maxAgeMs?: number;
}): {
	relayed: RelayCall[];
	clock: { t: number };
	deps: Partial<TelemetryRecorderDeps>;
} {
	const relayed: RelayCall[] = [];
	const clock = { t: 1_000 };
	let seq = 0;
	const deps: Partial<TelemetryRecorderDeps> = {
		readLinkTelemetry: opts.snapshot,
		relay: (type, payload, s) => relayed.push({ type, payload, seq: s }),
		nextSeq: () => seq++,
		now: () => clock.t,
		maxBatch: opts.maxBatch ?? 30,
		maxAgeMs: opts.maxAgeMs ?? 10_000,
	};
	return { relayed, clock, deps };
}

afterEach(() => {
	stopTelemetryRecorder();
});

describe("samplesFromLinkTelemetry", () => {
	it("maps fresh per-link rows to spec §8.1 samples (iface → linkId, loss/jitter default 0)", () => {
		const msg: LinkTelemetryMessage = {
			links: [
				freshLink(),
				freshLink({ conn_id: "1", iface: "wwan0", rtt_ms: 80, nak_count: 1 }),
			],
			lastReadMs: 1234,
		};
		const samples = samplesFromLinkTelemetry(msg, 5_000);
		expect(samples).toEqual([
			{
				linkId: "eth0",
				rttMs: 42,
				nakCount: 3,
				weightPercent: 100,
				packetLoss: 0,
				jitterMs: 0,
				tsMs: 5_000,
			},
			{
				linkId: "wwan0",
				rttMs: 80,
				nakCount: 1,
				weightPercent: 100,
				packetLoss: 0,
				jitterMs: 0,
				tsMs: 5_000,
			},
		]);
	});

	it("skips stale rows (no new data) and returns [] for a null snapshot", () => {
		const msg: LinkTelemetryMessage = {
			links: [
				freshLink(),
				freshLink({ conn_id: "1", iface: "wwan0", stale: true }),
			],
			lastReadMs: 1,
		};
		expect(samplesFromLinkTelemetry(msg, 1).map((s) => s.linkId)).toEqual([
			"eth0",
		]);
		expect(samplesFromLinkTelemetry(null, 1)).toEqual([]);
	});
});

describe("recorder batching", () => {
	it("flushes ONE telemetry frame when the size boundary is hit", () => {
		const { relayed, deps } = harness({
			snapshot: () => ({ links: [freshLink()], lastReadMs: 0 }),
			maxBatch: 3,
		});
		startTelemetryRecorder(deps);

		recordTelemetryTick(); // 1 buffered
		recordTelemetryTick(); // 2 buffered
		expect(relayed).toHaveLength(0);
		expect(bufferedSampleCountForTest()).toBe(2);

		recordTelemetryTick(); // 3 → size boundary → flush
		expect(relayed).toHaveLength(1);
		expect(bufferedSampleCountForTest()).toBe(0);

		const frame = relayed[0] as RelayCall;
		expect(frame.type).toBe(TELEMETRY_STATUS_TYPE);
		expect((frame.payload as { samples: unknown[] }).samples).toHaveLength(3);
	});

	it("flushes on the AGE boundary even when below the size threshold", () => {
		const { relayed, clock, deps } = harness({
			snapshot: () => ({ links: [freshLink()], lastReadMs: 0 }),
			maxBatch: 100,
			maxAgeMs: 5_000,
		});
		startTelemetryRecorder(deps);

		recordTelemetryTick(); // buffers, oldest = t=1000
		expect(relayed).toHaveLength(0);

		clock.t += 5_000; // age boundary reached
		recordTelemetryTick();
		expect(relayed).toHaveLength(1);
		expect(bufferedSampleCountForTest()).toBe(0);
	});

	it("emits spec-valid telemetry status frames via relayStatusToGateway shape", () => {
		const { relayed, deps } = harness({
			snapshot: () => ({ links: [freshLink()], lastReadMs: 0 }),
			maxBatch: 1,
		});
		startTelemetryRecorder(deps);
		recordTelemetryTick();

		const call = relayed[0] as RelayCall;
		// The relay call is what status-relay turns into a kind:status frame; assert
		// it would parse as a §8 status frame with type "telemetry".
		const frame = StatusSchema.parse({
			v: 1,
			kind: "status",
			type: call.type,
			cid: "6f92c357-2b8d-4a6f-a372-0e1f2a3b4c5d",
			seq: call.seq,
			payload: call.payload,
		});
		expect(frame.type).toBe("telemetry");
		expect((frame.payload as { samples: unknown[] }).samples).toHaveLength(1);
	});
});

describe("recorder is non-blocking / exception-safe", () => {
	it("a throwing snapshot source never propagates out of the tick", () => {
		const { relayed, deps } = harness({
			snapshot: () => {
				throw new Error("snapshot exploded");
			},
		});
		startTelemetryRecorder(deps);
		expect(() => recordTelemetryTick()).not.toThrow();
		expect(relayed).toHaveLength(0);
	});

	it("a null snapshot (srtla not running) records nothing and never flushes", () => {
		const { relayed, deps } = harness({ snapshot: () => null, maxBatch: 1 });
		startTelemetryRecorder(deps);
		recordTelemetryTick();
		recordTelemetryTick();
		expect(relayed).toHaveLength(0);
		expect(bufferedSampleCountForTest()).toBe(0);
	});

	it("flushTelemetry is a no-op on an empty buffer / stopped recorder", () => {
		expect(flushTelemetry()).toBe(0); // stopped
		startTelemetryRecorder({
			snapshot: () => null,
		} as Partial<TelemetryRecorderDeps>);
		expect(flushTelemetry()).toBe(0); // empty
	});
});
