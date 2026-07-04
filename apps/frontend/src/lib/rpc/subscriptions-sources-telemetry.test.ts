// @vitest-environment jsdom
/**
 * Sources ingestion + telemetry clear-on-stop (Wave 2, T6).
 *
 * Drives the REAL production path: `initSubscriptions()` registers `handleMessage`
 * via `rpcClient.onMessage`; we capture that handler and feed it real frames, then
 * read the merged result back through the public getters. Covers:
 *   - the new `sources` case (ingest + seq-guard drop-stale)
 *   - the belt-and-braces telemetry clear on a true→false streaming transition,
 *     including a `{is_streaming:false}` frame that omits `linkTelemetry`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let captured: ((type: string, data: unknown, seq?: number) => void) | undefined;
vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (h: (type: string, data: unknown, seq?: number) => void) => {
			captured = h;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));

import type {
	LinkTelemetryMessage,
	SourcesMessage,
	StatusResponse,
} from "@ceraui/rpc/schemas";

import {
	getLinkTelemetry,
	getSources,
	initSubscriptions,
	resetState,
} from "./subscriptions.svelte";

function push(type: string, data: unknown, seq?: number): void {
	if (!captured) throw new Error("message handler was never registered");
	captured(type, data, seq);
}

const telemetryFixture: LinkTelemetryMessage = {
	links: [
		{
			conn_id: "c1",
			iface: "wwan0",
			rtt_ms: 42,
			nak_count: 0,
			weight_percent: 100,
			stale: false,
		},
	],
};

const sourcesFixture: SourcesMessage = {
	hardware: "generic",
	sources: [
		{
			id: "test",
			pipelineId: "test",
			origin: "virtual",
			labelKey: "settings.sources.test",
			modes: [],
			supportsAudio: false,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audioKind: "none",
			available: true,
		},
	],
};

beforeEach(() => {
	resetState();
	initSubscriptions();
});

// The per-type seq tracker is module-global and is only cleared on reconnect
// (not by resetState), so these seq-using cases advance monotonically to stay
// isolated from one another — mirroring the real transport's single sequence.
describe("sources broadcast ingestion (T6)", () => {
	it("ingests a sources message and exposes it via getSources()", () => {
		push("sources", sourcesFixture);
		expect(getSources()).toEqual(sourcesFixture);
	});

	it("drops a stale-seq sources replay — getter stays on the newer frame", () => {
		push("sources", sourcesFixture, 10);

		const stale: SourcesMessage = { hardware: "jetson", sources: [] };
		push("sources", stale, 8);

		expect(getSources()).toEqual(sourcesFixture);
	});

	it("applies a strictly-newer sources frame", () => {
		const next: SourcesMessage = { hardware: "rk3588", sources: [] };
		push("sources", next, 11);
		expect(getSources()).toEqual(next);
	});
});

describe("link telemetry clears on stream stop (T6 belt-and-braces)", () => {
	function pushStreaming(
		is_streaming: boolean,
		extra?: Partial<StatusResponse>,
	) {
		push("status", { is_streaming, ...extra } as StatusResponse);
	}

	it("clears live telemetry when is_streaming flips true→false without a linkTelemetry field", () => {
		pushStreaming(true, { linkTelemetry: telemetryFixture });
		expect(getLinkTelemetry()).toEqual(telemetryFixture);

		pushStreaming(false);
		expect(getLinkTelemetry()).toBeNull();
	});

	it("clears live telemetry on stop even if the stop frame carries stale telemetry", () => {
		pushStreaming(true, { linkTelemetry: telemetryFixture });
		pushStreaming(false, { linkTelemetry: telemetryFixture });
		expect(getLinkTelemetry()).toBeNull();
	});

	it("does not clear telemetry on steady-state streaming ticks", () => {
		pushStreaming(true, { linkTelemetry: telemetryFixture });
		pushStreaming(true);
		expect(getLinkTelemetry()).toEqual(telemetryFixture);
	});
});
