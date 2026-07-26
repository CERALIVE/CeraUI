/**
 * Regression lock: the `config` echo the backend sends after a live
 * `setBitrate` must reach `getConfig().max_br` through the dirty-field lock.
 *
 * `commitBitrate` (LiveView) calls `markPending('max_br', …)` BEFORE the RPC, so
 * the echo lands while the field is locked. The whole point of the backend echo
 * is to refresh the cached authoritative bitrate the Live control re-seeds from
 * on remount — if the lock swallowed a matching echo instead of applying it, the
 * backend fix would be inert and the operator's change would still revert on a
 * destination switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers: { message?: (t: string, d: unknown, s?: number) => void } = {};

vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (fn: (t: string, d: unknown, s?: number) => void) => {
			handlers.message = fn;
		},
		onConnectionChange: () => undefined,
		connect: () => undefined,
		getSocket: () => undefined,
		sendLegacy: () => undefined,
	},
}));

import {
	destroyDirtyRegistry,
	isPending,
	markPending,
	onRpcAppliedReactive,
	onRpcResolved,
} from "$lib/rpc/dirty-registry.svelte";
import {
	getConfig,
	initSubscriptions,
	resetState,
} from "$lib/rpc/subscriptions.svelte";

const PRE_ADJUST = 6000;
const HOT_ADJUSTED = 9000;
const RE_ADJUSTED = 11000;

function pushConfig(maxBr: number): void {
	handlers.message?.("config", { max_br: maxBr, pipeline: "hdmi" });
}

describe("live bitrate hot-adjust — config echo ingestion", () => {
	beforeEach(() => {
		destroyDirtyRegistry();
		resetState();
		initSubscriptions();
		pushConfig(PRE_ADJUST);
	});

	afterEach(() => {
		destroyDirtyRegistry();
	});

	it("applies the echo of the value the operator just committed", () => {
		markPending("max_br", HOT_ADJUSTED);
		pushConfig(HOT_ADJUSTED);

		expect(getConfig()?.max_br).toBe(HOT_ADJUSTED);
	});

	it("releases the field lock once the RPC settles on the applied value", () => {
		markPending("max_br", HOT_ADJUSTED);
		pushConfig(HOT_ADJUSTED);
		onRpcResolved("max_br");
		onRpcAppliedReactive("max_br", HOT_ADJUSTED);

		expect(isPending("max_br")).toBe(false);
		expect(getConfig()?.max_br).toBe(HOT_ADJUSTED);
	});

	it("still ignores a stale echo of a superseded bitrate", () => {
		pushConfig(HOT_ADJUSTED);
		expect(getConfig()?.max_br).toBe(HOT_ADJUSTED);

		markPending("max_br", RE_ADJUSTED);
		pushConfig(PRE_ADJUST);

		expect(getConfig()?.max_br).toBe(HOT_ADJUSTED);
		expect(isPending("max_br")).toBe(true);
	});
});
