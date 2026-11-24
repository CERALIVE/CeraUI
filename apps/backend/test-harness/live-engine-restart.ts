import { rpcRequestSchema, SCHEMA_VERSION } from "@ceralive/cerastream";
import { MINIMAL_SAFE_CAPABILITIES } from "../src/modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../src/modules/streaming/cerastream-backend.ts";
import {
	initEngineConnection,
	settleEngineReconnect,
	stopEngineReconnect,
} from "../src/modules/streaming/engine-reconnect.ts";
import { reconcileStreamSession } from "../src/modules/streaming/stream-session-orchestrator.ts";
import { createWebSocketHandler } from "../src/rpc/adapter.ts";
import { initSocketData } from "../src/rpc/context.ts";
import { setPasswordHash } from "../src/rpc/state/password.ts";
import type { SocketData } from "../src/rpc/types.ts";

const socketPath = "engine.sock";
const password = "live-restart-fixture";
const mutations: string[] = [];
const modes: unknown[] = [];
const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
const frame = (value: object) => `${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`;

function listen(streaming: boolean, snapshots: boolean) {
	return Bun.listen<{ pending: string; heartbeat?: ReturnType<typeof setInterval> }>({
		unix: socketPath,
		socket: {
			open(peer) {
				peer.data = { pending: "" };
			},
			close(peer) {
				clearInterval(peer.data.heartbeat);
			},
			data(peer, bytes) {
				const lines = (peer.data.pending + bytes.toString()).split("\n");
				peer.data.pending = lines.pop() ?? "";
				for (const line of lines) {
					const request = rpcRequestSchema.parse(JSON.parse(line));
					const reply = (result: object) => frame({ id: request.id, result });
					switch (request.method) {
						case "hello":
							peer.write(reply({
								protocol: "cerastream-ipc/1",
								schema_version: SCHEMA_VERSION,
								engine_version: "live-restart-fixture",
							}));
							break;
						case "get-capabilities":
							peer.write(reply({
								...MINIMAL_SAFE_CAPABILITIES,
								...(snapshots ? { features: ["status-snapshot"] } : {}),
							}));
							break;
						case "list-devices":
							peer.write(reply({ devices: [] }));
							break;
						case "subscribe-events": {
							const mode = typeof request.params === "object" &&
								request.params !== null && "snapshot" in request.params
								? request.params.snapshot : undefined;
							if (!streaming) modes.push(mode ?? null);
							const result = reply({ subscribed: ["status"] });
							const status = frame({
								method: "event",
								params: {
									type: "status",
									seq: 1,
									state: streaming ? "streaming" : "idle",
									streaming,
									...(snapshots ? { snapshot: true } : {}),
								},
							});
							if (streaming) {
								peer.write(result);
								// Only the original live engine has a heartbeat.
								peer.data.heartbeat = setInterval(() => peer.write(status), 100);
								peer.data.heartbeat.unref();
							} else {
								peer.write(result + (snapshots && mode === true ? status : ""));
							}
							break;
						}
						case "start":
						case "stop":
						case "prepare-start":
						case "cancel-start":
							mutations.push(request.method);
							peer.write(frame({
								id: request.id,
								error: { code: -32601, message: "Unexpected mutation" },
							}));
							break;
						default:
							throw new Error(`Unexpected engine method: ${request.method}`);
					}
				}
			},
		},
	});
}

const received: unknown[] = [];
const pending = new Map<string, (value: unknown) => void>();
const server = Bun.serve<SocketData>({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, server) {
		if (server.upgrade(request, { data: initSocketData() })) return;
		return new Response(null, { status: 400 });
	},
	websocket: createWebSocketHandler(),
});
let engine = listen(true, false);
const opened = Promise.withResolvers<void>();
let closes = 0;
const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
ws.onopen = () => opened.resolve();
ws.onclose = () => { closes += 1; };
ws.onerror = () => opened.reject(new Error("Device WebSocket did not open"));
ws.onmessage = (event) => {
	const message: unknown = JSON.parse(String(event.data));
	if (
		typeof message === "object" && message !== null &&
		"id" in message && typeof message.id === "string"
	) {
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	} else received.push(message);
};
function call(id: string, path: readonly string[], input: object = {}) {
	const reply = Promise.withResolvers<unknown>();
	pending.set(id, reply.resolve);
	ws.send(JSON.stringify({ id, path, input }));
	return reply.promise;
}

function requireField(message: unknown, field: string, expected: unknown) {
	if (typeof message !== "object" || message === null ||
		!("result" in message) || typeof message.result !== "object" ||
		message.result === null || Reflect.get(message.result, field) !== expected
	) throw new Error(`Unexpected ${field} receipt: ${JSON.stringify(message)}`);
}

try {
	setPasswordHash(await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 }));
	await initEngineConnection({
		setTimer: (callback) => {
			const handle = setTimeout(() => undefined, 60_000);
			handle.unref();
			timers.set(handle, callback);
			return handle;
		},
		clearTimer: (handle) => {
			timers.delete(handle);
			clearTimeout(handle);
		},
	});
	if (await reconcileStreamSession() !== "streaming")
		throw new Error("Fixture did not adopt the original stream");
	await opened.promise;
	requireField(await call("login", ["auth", "login"], { password }), "success", true);
	await call("initial", ["status", "getStatus"]);
	const initial = received.splice(0);

	engine.stop(true);
	await cerastreamBackend.listDevicesIfActive();
	await settleEngineReconnect();
	const next = async () => {
		// The pre-#724 loss callback imports the reconnect owner asynchronously.
		const deadline = performance.now() + 1_000;
		while (timers.size === 0 && performance.now() < deadline)
			await Bun.sleep(5);
		const timer = timers.entries().next().value;
		if (timer === undefined) throw new Error("Expected an engine recovery timer");
		timers.delete(timer[0]);
		clearTimeout(timer[0]);
		timer[1]();
		await settleEngineReconnect();
	};
	await next();
	await call("outage", ["status", "getStatus"]);
	const outage = received.splice(0);

	engine = listen(false, process.argv[2] === "snapshot");
	await next();
	await call("replacement", ["status", "getStatus"]);
	console.log(`LIVE_RESTART ${JSON.stringify({
		initial, outage, replacement: received, mutations, modes, closes,
	})}`);
} finally {
	stopEngineReconnect();
	for (const handle of timers.keys()) clearTimeout(handle);
	ws.close();
	engine.stop(true);
	await server.stop(true);
}
