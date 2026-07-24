// @vitest-environment jsdom
/**
 * Integration test through the WS layer (Todo 29 acceptance d).
 *
 * Proves the backend's authoritative `is_streaming=false` status broadcast — the
 * frame the Todo-27 transactional-launch rollback emits on a terminal start
 * failure that had reached streaming — reaches AND is consumed by the frontend.
 *
 * It drives the ACTUAL production ingestion path: `initSubscriptions()` registers
 * `handleMessage` via `rpcClient.onMessage`; we capture that handler and feed it a
 * real `{ status: { is_streaming } }` frame (the exact wire envelope
 * `broadcastMsg("status", { is_streaming })` produces), then read the merged
 * result back through the public `getIsStreaming()` getter — the same
 * authoritative flag the optimism overlay reconciles against and LiveView leaves
 * live mode on. The pure overlay reconciliation is covered by the
 * `reconcileToAuthority` truth-table in streaming-optimism.test.ts.
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

import {
	getIsStreaming,
	initSubscriptions,
	resetState,
} from "./subscriptions.svelte";

/**
 * Feed a `status` frame through the exact handler the transport calls. No `seq`
 * is passed — the per-type seq drop-stale guard is orthogonal to authoritative
 * consumption and its map is not reset between tests.
 */
function pushStatus(isStreaming: boolean): void {
	if (!captured) throw new Error("message handler was never registered");
	captured("status", { is_streaming: isStreaming });
}

beforeEach(() => {
	resetState();
	initSubscriptions();
});

describe("backend is_streaming=false broadcast reaches + is consumed (Todo 29 d)", () => {
	it("consumes an authoritative false frame into getIsStreaming()", () => {
		pushStatus(true);
		expect(getIsStreaming()).toBe(true);

		// The Todo-27 terminal-failure rollback broadcasts is_streaming=false.
		pushStatus(false);
		expect(getIsStreaming()).toBe(false);
	});

	it("consumes each frame live across a true→false→true sequence", () => {
		pushStatus(true);
		expect(getIsStreaming()).toBe(true);
		pushStatus(false);
		expect(getIsStreaming()).toBe(false);
		pushStatus(true);
		expect(getIsStreaming()).toBe(true);
	});

	it("consumes a bare false broadcast even with no prior true frame", () => {
		// A start that never reached streaming: the authoritative flag stays false
		// and is still ingested, never left stale.
		pushStatus(false);
		expect(getIsStreaming()).toBe(false);
	});
});
