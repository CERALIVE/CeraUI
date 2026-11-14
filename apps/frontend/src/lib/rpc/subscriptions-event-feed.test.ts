// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type DeviceEvent,
	deviceEventSchema,
	EVENT_PUSH,
	logAroundInputSchema,
} from "@ceraui/rpc/schemas";
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
	setEventFeedListener,
} from "./subscriptions.svelte";

const event: DeviceEvent = {
	id: "first",
	seq: 1,
	bootId: "66d8d1808694489b8c3a3fb4795cab24",
	at: 10,
	code: "engine_lost",
	family: "stream",
	severity: "error",
	params: { streaming: true },
};

function push(data: unknown): void {
	if (!captured) throw new Error("subscription handler was not registered");
	captured(EVENT_PUSH, data);
}

beforeEach(() => {
	resetState();
	initSubscriptions();
});
afterEach(() => resetState());

it("delivers valid siblings and skips malformed records individually", () => {
	const listener = vi.fn();
	setEventFeedListener(listener);
	const { seq: _seq, ...missingSeq } = event;
	push({
		append: [
			event,
			missingSeq,
			{ ...event, seq: 2, params: { nested: {} } },
			{ ...event, id: "last", seq: 3 },
		],
	});
	expect(listener).toHaveBeenCalledExactlyOnceWith([
		event,
		{ ...event, id: "last", seq: 3 },
	]);
});

it("retains future event codes and flat params with lenient family and severity", () => {
	const listener = vi.fn();
	setEventFeedListener(listener);
	push({
		append: [
			{
				...event,
				code: "from_the_future",
				family: "future",
				severity: "future",
				params: { added: ["one", "two"], nullable: null },
			},
		],
	});
	expect(listener).toHaveBeenCalledExactlyOnceWith([
		{
			...event,
			code: "from_the_future",
			family: "device",
			severity: "info",
			params: { added: ["one", "two"], nullable: null },
		},
	]);
});

it.each([
	null,
	undefined,
	"invalid",
	1,
	true,
	{},
	{ append: null },
	{ append: {} },
	{ append: [] },
	{ append: [null, {}, { ...event, seq: "bad" }] },
])(
	"ignores an unusable append payload without notifying the listener: %j",
	(data) => {
		const listener = vi.fn();
		setEventFeedListener(listener);
		expect(() => push(data)).not.toThrow();
		expect(listener).not.toHaveBeenCalled();
	},
);

it("detaches and replaces listeners without retaining or replaying closed-view events", () => {
	const first = vi.fn();
	const second = vi.fn();
	setEventFeedListener(first);
	push({ append: [event] });
	setEventFeedListener(undefined);
	push({ append: [{ ...event, seq: 2 }] });
	setEventFeedListener(second);
	expect(second).not.toHaveBeenCalled();
	push({ append: [{ ...event, seq: 3 }] });
	expect(first).toHaveBeenCalledExactlyOnceWith([event]);
	expect(second).toHaveBeenCalledExactlyOnceWith([{ ...event, seq: 3 }]);
	resetState();
	push({ append: [{ ...event, seq: 4 }] });
	expect(second).toHaveBeenCalledTimes(1);
});

it("delivers every real device_started version field and accepts its normalized boot in a raw-log link", () => {
	const params = {
		osImage: "2026.11.0",
		slot: "A",
		board: "rk3588",
		boardModel: "Orange Pi 5 Plus",
		ceraui: "2026.11.3",
		engine: "2026.11.1",
		senderVersion: "1.2.3",
		kernel: "6.1.99",
		bun: "1.4.4",
		previousBootId: null,
		previousShutdown: null,
	};
	const output = execFileSync(
		"bun",
		[
			"-e",
			`
		import { currentBootId } from "./src/modules/device-logs/boot-id.ts";
		import { emitEvent, resetEventEmitterForTest, setEventSink } from "./src/modules/events/emit.ts";
		resetEventEmitterForTest({
			bootId: () => currentBootId(() => "66D8D180-8694-489B-8C3A-3FB4795CAB24"),
			now: () => 123456, tailSeq: () => 40, appendEvent: () => {}, log: () => {},
		});
		setEventSink(event => process.stdout.write(JSON.stringify({ append: [event] })));
		emitEvent("device_started", ${JSON.stringify(params)});
		resetEventEmitterForTest();
	`,
		],
		{
			cwd: resolve(process.cwd(), "../backend"),
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	const listener = vi.fn<(events: DeviceEvent[]) => void>();
	setEventFeedListener(listener);
	push(JSON.parse(output));
	expect(listener).toHaveBeenCalledTimes(1);
	const delivered = deviceEventSchema.parse(listener.mock.calls[0]?.[0][0]);
	expect(delivered.params).toEqual(params);
	expect(delivered).toMatchObject({
		id: "66d8d180-41",
		seq: 41,
		at: 123456,
		code: "device_started",
	});
	expect(delivered.bootId).toMatch(/^[0-9a-f]{32}$/);
	expect(
		logAroundInputSchema.parse({
			bootId: delivered.bootId,
			at: delivered.at,
			eventId: delivered.id,
		}),
	).toMatchObject({
		bootId: "66d8d1808694489b8c3a3fb4795cab24",
		at: 123456,
		eventId: "66d8d180-41",
	});
});

it("imports only boot-safe event wire schemas into startup subscriptions", () => {
	const source = readFileSync(
		resolve(process.cwd(), "src/lib/rpc/subscriptions.svelte.ts"),
		"utf8",
	);
	expect(source).not.toContain("@ceraui/rpc/events");
	const wireImports = source
		.match(/import\s*\{[^}]+\}\s*from\s*["']@ceraui\/rpc\/schemas["']/g)
		?.join("\n");
	expect(wireImports).toContain("deviceEventSchema");
	expect(wireImports).toContain("EVENT_PUSH");
});
