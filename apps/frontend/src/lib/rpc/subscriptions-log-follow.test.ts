// @vitest-environment jsdom
import { LOG_FOLLOW_EVENT, type LogFollowMessage } from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let captured: ((type: string, data: unknown) => void) | undefined;
vi.mock("$lib/rpc/client", () => ({
	rpc: {},
	rpcClient: {
		onMessage: (handler: (type: string, data: unknown) => void) => {
			captured = handler;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));

import {
	initSubscriptions,
	resetState,
	setLogFollowListener,
} from "./subscriptions.svelte";

const frame: LogFollowMessage = {
	subscriptionId: "viewer",
	entries: [
		{
			cursor: "s=2",
			ts: 42,
			bootId: "66d8d1808694489b8c3a3fb4795cab24",
			level: "error",
			source: "app",
			unit: "ceralive.service",
			message: "failure",
			marker: null,
			truncated: false,
		},
	],
	checkpointCursor: "s=3",
	dropped: 2,
	gap: "suppressed",
};
function push(data: unknown): void {
	if (!captured) throw new Error("subscriptions were not initialized");
	captured(LOG_FOLLOW_EVENT, data);
}
beforeEach(() => {
	resetState();
	initSubscriptions();
});
afterEach(() => {
	resetState();
	vi.restoreAllMocks();
});

it("delivers a parsed follow frame and terminal state to the current listener", () => {
	const listener = vi.fn();
	setLogFollowListener(listener);
	push(frame);
	push({ ...frame, entries: [], ended: "cleared" });
	expect(listener.mock.calls).toEqual([
		[frame],
		[{ ...frame, entries: [], ended: "cleared" }],
	]);
});
it.each([
	null,
	undefined,
	{},
	"bad",
	{ ...frame, dropped: -1 },
	{ ...frame, entries: [{}] },
	{ ...frame, checkpointCursor: 1 },
])("ignores malformed frames silently: %j", (data) => {
	const listener = vi.fn();
	const warn = vi.spyOn(console, "warn");
	setLogFollowListener(listener);
	push(data);
	expect(listener).toHaveBeenCalledTimes(0);
	expect(warn).toHaveBeenCalledTimes(0);
});
it("detaches and replaces listeners without storing or replaying messages", () => {
	const first = vi.fn();
	const next = vi.fn();
	const error = vi.spyOn(console, "error");
	setLogFollowListener(first);
	push(frame);
	setLogFollowListener(undefined);
	push(frame);
	setLogFollowListener(next);
	expect(next).toHaveBeenCalledTimes(0);
	push(frame);
	resetState();
	push(frame);
	expect(first).toHaveBeenCalledExactlyOnceWith(frame);
	expect(next).toHaveBeenCalledExactlyOnceWith(frame);
	expect(error).toHaveBeenCalledTimes(0);
});
it("contains a throwing consumer and still delivers the next frame", () => {
	const failure = new Error("view unmounted");
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const listener = vi.fn().mockImplementationOnce(() => {
		throw failure;
	});
	setLogFollowListener(listener);
	push(frame);
	push(frame);
	expect(listener).toHaveBeenCalledTimes(2);
	expect(error).toHaveBeenCalledExactlyOnceWith(
		"Log follow listener failed:",
		failure,
	);
});
