import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import * as follow from "../modules/device-logs/follow.ts";
import { createWebSocketHandler } from "../rpc/adapter.ts";
import { createContext } from "../rpc/context.ts";
import * as events from "../rpc/events.ts";
import { appRouter } from "../rpc/router.ts";
import { followFixture, record } from "./helpers/device-follow.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

let f: ReturnType<typeof followFixture>;
let sockets: Awaited<ReturnType<typeof logsSockets>>;
const start = follow.startFollow;
beforeEach(async () => {
	f = followFixture();
	sockets = await logsSockets();
	spyOn(follow, "startFollow").mockImplementation((conn, input, options) =>
		start(conn, input, { ...options, ...f.options }),
	);
});
afterEach(async () => {
	await follow.stopAllFollows("cleared");
	spyOn(follow, "startFollow").mockRestore();
	sockets.close();
	f.restore();
});
test("followStart and followStop share the socket and leave no timers or watcher", async () => {
	const result = await call(
		appRouter.logs.followStart,
		{},
		{ context: sockets.context },
	);
	expect(result).toMatchObject({ ok: true, checkpointCursor: "s=1" });
	const child = f.children[0];
	if (!child) throw new Error("missing watcher");
	await child.emit([record(2)]);
	expect(f.time.timers.size).toBe(1);
	expect(
		await call(appRouter.logs.followStop, undefined, {
			context: sockets.context,
		}),
	).toEqual({ success: true, checkpointCursor: "s=1" });
	expect(child.signals).toEqual(["SIGTERM"]);
	expect(f.time.timers.size).toBe(0);
	expect(
		await call(appRouter.logs.followStop, undefined, {
			context: sockets.context,
		}),
	).toEqual({ success: false, checkpointCursor: null });
});
test("adapter close removes the client before joining its follow and frees all four slots", async () => {
	const owners = [
		sockets.ws,
		await sockets.connect(),
		await sockets.connect(),
		await sockets.connect(),
	];
	for (const ws of owners) {
		expect(
			await call(
				appRouter.logs.followStart,
				{},
				{ context: createContext(ws) },
			),
		).toMatchObject({ ok: true });
	}
	expect(
		await call(
			appRouter.logs.followStart,
			{},
			{ context: createContext(await sockets.connect()) },
		),
	).toEqual({ ok: false, error: "BUSY" });
	const child = f.children[0];
	if (!child) throw new Error("missing watcher");
	await child.emit([record(2)]);
	const order: string[] = [];
	const remove = events.removeClient;
	const stop = follow.stopFollow;
	const removed = spyOn(events, "removeClient").mockImplementation((ws) => {
		order.push("remove");
		remove(ws);
	});
	const stopped = spyOn(follow, "stopFollow").mockImplementation((ws) => {
		order.push("stop");
		return stop(ws);
	});
	try {
		for (const ws of owners)
			await createWebSocketHandler().close?.(ws, 1000, "done");
		expect(order).toEqual([
			"remove",
			"stop",
			"remove",
			"stop",
			"remove",
			"stop",
			"remove",
			"stop",
		]);
		expect(f.time.timers.size).toBe(0);
		expect(f.children.map((c) => c.signals)).toEqual([
			["SIGTERM"],
			["SIGTERM"],
			["SIGTERM"],
			["SIGTERM"],
		]);
		expect(await follow.stopFollow(sockets.ws)).toEqual({
			success: false,
			checkpointCursor: null,
		});
	} finally {
		removed.mockRestore();
		stopped.mockRestore();
	}
});
test("a throwing push consumer retires its follow and clears pending timers", async () => {
	const sent = spyOn(sockets.ws, "send").mockImplementation(() => {
		throw new Error("closed transport");
	});
	try {
		await call(appRouter.logs.followStart, {}, { context: sockets.context });
		const child = f.children[0];
		if (!child) throw new Error("missing watcher");
		await child.emit([record(2)]);
		f.time.advance(250);
		await follow.stopFollow(sockets.ws);
		expect(sent).toHaveBeenCalledTimes(1);
		expect(child.signals).toEqual(["SIGTERM"]);
		expect(f.time.timers.size).toBe(0);
	} finally {
		sent.mockRestore();
	}
});

test("logout retires a follow and blocks records while its child is reaping", async () => {
	expect(
		await call(appRouter.logs.followStart, {}, { context: sockets.context }),
	).toMatchObject({ ok: true });
	const child = f.children[0];
	if (!child) throw new Error("missing watcher");
	const kill = spyOn(child.proc, "kill").mockImplementation(() => undefined);
	const send = spyOn(sockets.ws, "send");
	try {
		await child.emit([record(2)]);
		expect(f.time.timers.size).toBe(1);
		await call(appRouter.auth.logout, undefined, { context: sockets.context });
		await expect(child.emit([record(3)])).rejects.toBeInstanceOf(TypeError);
		f.time.advance(250);
		expect(send.mock.calls).toEqual([]);
		expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	} finally {
		child.finish();
		send.mockRestore();
		kill.mockRestore();
	}
});

test("revoking a credential retires a follow on another socket using it", async () => {
	const peer = await sockets.connect();
	const peerContext = createContext(peer);
	const credential = crypto.randomUUID();
	peerContext.authenticate(credential);
	events.addClient(peer);
	try {
		expect(
			await call(appRouter.logs.followStart, {}, { context: peerContext }),
		).toMatchObject({ ok: true });
		const child = f.children[0];
		if (!child) throw new Error("missing watcher");
		await call(
			appRouter.auth.revokeToken,
			{ scope: "token", token: credential },
			{ context: sockets.context },
		);
		expect(peerContext.isAuthenticated()).toBe(false);
		expect(child.signals).toEqual(["SIGTERM"]);
		expect(sockets.context.isAuthenticated()).toBe(true);
	} finally {
		events.removeClient(peer);
	}
});

test("a replacement waiting for the previous child cannot start after logout", async () => {
	expect(
		await call(appRouter.logs.followStart, {}, { context: sockets.context }),
	).toMatchObject({ ok: true });
	const child = f.children[0];
	if (!child) throw new Error("missing watcher");
	const term = Promise.withResolvers<void>();
	const kill = spyOn(child.proc, "kill").mockImplementation(() =>
		term.resolve(),
	);
	const replacement = call(
		appRouter.logs.followStart,
		{},
		{ context: sockets.context },
	);
	try {
		await term.promise;
		await call(appRouter.auth.logout, undefined, { context: sockets.context });
		child.finish();
		expect(await replacement).toEqual({ ok: false, error: "READ_FAILED" });
		expect(f.children).toHaveLength(1);
	} finally {
		child.finish();
		kill.mockRestore();
	}
});
