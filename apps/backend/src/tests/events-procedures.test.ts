import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EVENT_PUSH,
	type EventListInput,
	eventAppendSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	emitEvent,
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import { appendBoot, appendEvent } from "../modules/events/store.ts";
import {
	isRelayable,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastMsgLocal } from "../rpc/compat.ts";
import { createContext } from "../rpc/context.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { appRouter } from "../rpc/router.ts";
import type { AppWebSocket, SocketData } from "../rpc/types.ts";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const OTHER_BOOT = "123456788694489b8c3a3fb4795cab24";
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const originalDir = process.env.CERALIVE_EVENTS_DIR;
let dir: string;
let server: ReturnType<typeof Bun.serve<SocketData>>;
let authed: AppWebSocket;
let guest: AppWebSocket;
const peers: WebSocket[] = [];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "event-rpc-"));
	process.env.CERALIVE_EVENTS_DIR = dir;
	resetEventEmitterForTest({ bootId: () => BOOT, log: () => {} });
	const opened: ((ws: AppWebSocket) => void)[] = [];
	server = Bun.serve<SocketData>({
		port: 0,
		fetch(request, srv) {
			return srv.upgrade(request, {
				data: {
					isAuthenticated: new URL(request.url).pathname === "/authed",
					lastActive: 0,
				},
			})
				? undefined
				: new Response(null, { status: 400 });
		},
		websocket: {
			open(ws) {
				addClient(ws);
				opened.shift()?.(ws);
			},
			message() {},
		},
	});
	async function connect(path: string): Promise<AppWebSocket> {
		const connected = Promise.withResolvers<AppWebSocket>();
		opened.push(connected.resolve);
		const peer = new WebSocket(`ws://127.0.0.1:${server.port}/${path}`);
		peer.addEventListener("error", connected.reject, { once: true });
		peers.push(peer);
		return connected.promise;
	}
	authed = await connect("authed");
	guest = await connect("guest");
});

afterEach(() => {
	resetEventEmitterForTest();
	resetStatusRelay();
	removeClient(authed);
	removeClient(guest);
	for (const peer of peers.splice(0)) peer.close();
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
	if (originalDir === undefined) delete process.env.CERALIVE_EVENTS_DIR;
	else process.env.CERALIVE_EVENTS_DIR = originalDir;
});

function seed(): void {
	const severities = [
		"info",
		"warning",
		"error",
		"success",
		"warning",
	] as const;
	for (const [index, severity] of severities.entries()) {
		const seq = 11 + index;
		appendEvent(
			{
				id: `event-${seq}`,
				seq,
				at: seq,
				bootId: seq === 12 ? OTHER_BOOT : BOOT,
				code: "future_code",
				family: seq === 14 ? "capture" : "network",
				severity,
				params: {},
			},
			{ sync: false },
		);
	}
}

function list(input: EventListInput) {
	return call(appRouter.events.list, input, { context: createContext(authed) });
}

test("paging walks five retained events as two, two, one without repeats", async () => {
	seed();
	const first = await list({ limit: 2 });
	const second = await list({ limit: 2, beforeSeq: first.nextBeforeSeq ?? 0 });
	const third = await list({ limit: 2, beforeSeq: second.nextBeforeSeq ?? 0 });
	expect([first, second, third]).toEqual([
		{
			events: expect.any(Array),
			nextBeforeSeq: 14,
			headSeq: 15,
			retainedFromSeq: 11,
			epoch: expect.any(String),
		},
		{
			events: expect.any(Array),
			nextBeforeSeq: 12,
			headSeq: 15,
			retainedFromSeq: 11,
			epoch: expect.any(String),
		},
		{
			events: expect.any(Array),
			nextBeforeSeq: null,
			headSeq: 15,
			retainedFromSeq: 11,
			epoch: expect.any(String),
		},
	]);
	expect(
		[first, second, third].map((page) => page.events.map((event) => event.seq)),
	).toEqual([[15, 14], [13, 12], [11]]);
});

test("problemsOnly includes exactly warnings and errors across all families", async () => {
	seed();
	expect(
		(await list({ problemsOnly: true })).events.map((event) => event.seq),
	).toEqual([15, 13, 12]);
});

test("boot, family, cursor and problem filters compose before limiting", async () => {
	seed();
	const result = await list({
		limit: 1,
		bootId: BOOT,
		families: ["network"],
		problemsOnly: true,
		beforeSeq: 15,
	});
	expect(result.events.map((event) => event.seq)).toEqual([13]);
	expect(result).toMatchObject({
		nextBeforeSeq: null,
		headSeq: 15,
		retainedFromSeq: 11,
	});
	expect(
		(await list({ families: [] })).events.map((event) => event.seq),
	).toEqual([15, 14, 13, 12, 11]);
	expect(
		(await list({ families: ["capture"] })).events.map((event) => event.seq),
	).toEqual([14]);
	expect(
		(await list({ bootId: OTHER_BOOT })).events.map((event) => event.seq),
	).toEqual([12]);
});

test("an exactly full page is terminal and omitted limit uses the contract default", async () => {
	seed();
	expect(
		(await list({ limit: 5, problemsOnly: false })).nextBeforeSeq,
	).toBeNull();
	expect((await list({})).events).toHaveLength(5);
	await expect(list({ limit: 0 })).rejects.toMatchObject({
		code: "BAD_REQUEST",
	});
});

test("clearing events keeps boot records and reports an empty timeline", async () => {
	seed();
	const boot = { bootId: BOOT, startedAt: 1, versions: null };
	appendBoot(boot);
	expect(
		await call(appRouter.events.clear, undefined, {
			context: createContext(authed),
		}),
	).toEqual({ success: true });
	expect(await list({})).toEqual({
		events: [],
		nextBeforeSeq: null,
		headSeq: 0,
		retainedFromSeq: 0,
		epoch: expect.any(String),
	});
	expect(
		await call(appRouter.events.boots, undefined, {
			context: createContext(authed),
		}),
	).toEqual([boot]);
});

test("pages share one ring epoch, and a clear and restart that reuse seq 1 name a new one", async () => {
	seed();
	const first = await list({ limit: 2 });
	const second = await list({ limit: 2, beforeSeq: first.nextBeforeSeq ?? 0 });
	expect(first.epoch).toMatch(UUID);
	expect(second.epoch).toBe(first.epoch);
	expect(
		await call(appRouter.events.clear, undefined, {
			context: createContext(authed),
		}),
	).toEqual({ success: true });
	resetEventEmitterForTest({ bootId: () => BOOT, log: () => {} });
	emitEvent("engine_lost", { streaming: true });

	const refilled = await list({});
	expect(refilled.events.map((event) => event.seq)).toEqual([1]);
	expect(refilled.epoch).toMatch(UUID);
	expect(refilled.epoch).not.toBe(first.epoch);
	expect((await list({})).epoch).toBe(refilled.epoch);
});

test("timeline reads and clear reject unauthenticated callers without erasing records", async () => {
	seed();
	const context = createContext(guest);
	await expect(
		call(appRouter.events.list, {}, { context }),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await expect(
		call(appRouter.events.boots, undefined, { context }),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	await expect(
		call(appRouter.events.clear, undefined, { context }),
	).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	expect((await list({})).events).toHaveLength(5);
});

test("the real emitter stores and pushes one event locally to authenticated sockets only", async () => {
	const authedSend = spyOn(authed, "send");
	const guestSend = spyOn(guest, "send");
	const remoteFrames: unknown[] = [];
	setControlChannel({
		isConnected: () => true,
		sendFrame: (frame) => {
			remoteFrames.push(frame);
		},
	});
	setEventSink((event) =>
		broadcastMsgLocal(EVENT_PUSH, { append: [event] }, 0, undefined, true),
	);
	const received = Promise.withResolvers<unknown>();
	peers[0]?.addEventListener(
		"message",
		(message) => received.resolve(JSON.parse(String(message.data))),
		{ once: true },
	);
	emitEvent("engine_lost", { streaming: true });
	const frame = await received.promise;
	const events = (await list({})).events;
	expect(events).toHaveLength(1);
	expect(frame).toEqual({ event: { append: events }, seq: expect.any(Number) });
	expect(eventAppendSchema.parse({ append: events }).append[0]?.code).toBe(
		"engine_lost",
	);
	expect(authedSend).toHaveBeenCalledTimes(1);
	expect(guestSend).not.toHaveBeenCalled();
	expect(remoteFrames).toEqual([]);
	expect(isRelayable(EVENT_PUSH)).toBe(false);
	const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
	expect(main.replace(/\s+/g, "").replace(/,\)/g, ")")).toContain(
		"setEventSink((event)=>broadcastMsgLocal(EVENT_PUSH,{append:[event]},0,undefined,true))",
	);
});
