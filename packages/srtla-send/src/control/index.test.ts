import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import {
	createControlClient,
	JSON_RPC_METHOD_NOT_FOUND,
	SENDER_CONTROL_METHODS,
	STATS_TOPIC,
	senderStatsToTelemetry,
	supportsStatsSubscription,
	topicNotificationMethod,
} from "./index";

/*
  These tests drive the client against a scripted Unix JSON-RPC server that
  replays the EXACT frames `srtla_send 4.1.0` emits (captured live via
  `socat - UNIX-CONNECT:<sock>`), not a paraphrase of them. The retired
  binding's own `control-client.test.ts` was deliberately left behind at the
  absorption because it pinned the `hello` / `subscribe-events` dialect the hard
  fork removed; this file is its replacement, written against the dialect the
  shipped binary actually speaks.
*/

const sockets: string[] = [];
const servers: Array<{ stop: () => void }> = [];

function socketPath(tag: string): string {
	const path = `/tmp/ceraui-srtla-control-${process.pid}-${sockets.length}-${tag}.sock`;
	sockets.push(path);
	return path;
}

type Responder = (frame: {
	id?: number;
	method?: string;
	params?: unknown;
}) => string[] | null;

/**
 * A newline-delimited JSON-RPC server over a Unix socket. `respond` returns the
 * lines to write back (possibly several, so a subscribe ACK can be followed by
 * pushes), or null to stay silent — which is how the timeout path is exercised.
 */
async function startServer(
	path: string,
	respond: Responder,
): Promise<{ path: string; push: (line: string) => void }> {
	try {
		unlinkSync(path);
	} catch {
		// first run for this path
	}
	const live = new Set<{ write: (data: string) => void }>();
	const server = Bun.listen<{ buffer: string }>({
		unix: path,
		socket: {
			open(socket) {
				socket.data = { buffer: "" };
				live.add(socket);
			},
			close(socket) {
				live.delete(socket);
			},
			data(socket, chunk) {
				socket.data.buffer += new TextDecoder().decode(chunk);
				let nl = socket.data.buffer.indexOf("\n");
				while (nl !== -1) {
					const line = socket.data.buffer.slice(0, nl);
					socket.data.buffer = socket.data.buffer.slice(nl + 1);
					if (line.trim().length > 0) {
						const parsed = JSON.parse(line) as {
							id?: number;
							method?: string;
							params?: unknown;
						};
						const out = respond(parsed);
						if (out) for (const reply of out) socket.write(`${reply}\n`);
					}
					nl = socket.data.buffer.indexOf("\n");
				}
			},
		},
	});
	servers.push({ stop: () => server.stop(true) });
	return {
		path,
		push: (line: string) => {
			for (const socket of live) socket.write(`${line}\n`);
		},
	};
}

/** The live `get_capabilities` result from `srtla_send 4.1.0`, verbatim. */
function capabilitiesResult(): unknown {
	return {
		binary: "srtla_send",
		capabilities: {
			bind_map: true,
			conn_timeout_ms: true,
			control_socket_jsonrpc: true,
			dry_run: true,
			modes: ["classic", "enhanced"],
			stats_file: true,
		},
		methods: [...SENDER_CONTROL_METHODS],
		schema_version: 1,
		version: "4.1.0",
	};
}

function statsResult(): unknown {
	return {
		active_links: 2,
		bind_map_status: { state: "active" },
		disposition: { state: "mapped" },
		links: [
			{
				conn_id: 0,
				ip: "192.168.8.100",
				iface: "wwan0",
				link_id: "modem-a",
				label: "rec:5000 via 192.168.8.100",
				connected: true,
				timed_out: false,
				window: 8192,
				in_flight: 100,
				rtt_ms: 42,
				nak_count: 3,
				bitrate_bytes_per_sec: 312_500,
				bytes_sent_total: 812_000_000,
				base_score: 81,
				quality_multiplier: 1,
				// Diagnostics the projection must ignore rather than choke on.
				cc_state: "climbing",
				weak: false,
				weak_reason: "healthy",
			},
			{
				conn_id: 1,
				ip: "192.168.8.100",
				iface: "wwan1",
				link_id: "modem-b",
				label: "rec:5000 via 192.168.8.100",
				connected: true,
				timed_out: false,
				window: 4096,
				in_flight: 40,
				rtt_ms: 137,
				nak_count: 0,
				bitrate_bytes_per_sec: 125_000,
				bytes_sent_total: 400_000_000,
				base_score: 99,
				quality_multiplier: 1,
			},
		],
		mode: "enhanced",
		quality_enabled: true,
		session_bytes_sent: 1_620_000_000,
		total_in_flight: 140,
		total_links: 2,
		total_window: 12_288,
	};
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	for (const path of sockets.splice(0)) {
		try {
			unlinkSync(path);
		} catch {
			// already gone
		}
	}
});

describe("method vocabulary", () => {
	test("mirrors the sender's frozen METHODS array exactly, in order", () => {
		expect([...SENDER_CONTROL_METHODS]).toEqual([
			"get_capabilities",
			"get_stats",
			"get_status",
			"get_subscription_count",
			"set_conn_timeout",
			"set_mode",
			"set_quality",
			"set_stall_deselect",
			"subscribe",
			"unsubscribe",
		]);
	});

	test("carries none of the retired dialect's method names", () => {
		const retired = ["hello", "subscribe-events", "get-capabilities"];
		for (const name of retired) {
			expect(SENDER_CONTROL_METHODS as readonly string[]).not.toContain(name);
		}
	});

	test("a topic's push method is <topic>.update", () => {
		expect(topicNotificationMethod(STATS_TOPIC)).toBe("stats.update");
	});
});

describe("createControlClient — connect", () => {
	test("returns null when the socket does not exist (never throws)", async () => {
		const client = await createControlClient({
			socketPath: `/tmp/ceraui-srtla-control-absent-${process.pid}.sock`,
			timeoutMs: 200,
		});
		expect(client).toBeNull();
	});
});

describe("get_capabilities", () => {
	test("parses the live 4.1.0 document and reports bind_map support", async () => {
		const { path } = await startServer(socketPath("caps"), (frame) =>
			frame.method === "get_capabilities"
				? [
						JSON.stringify({
							jsonrpc: "2.0",
							result: capabilitiesResult(),
							id: frame.id,
						}),
					]
				: null,
		);
		const client = await createControlClient({
			socketPath: path,
			timeoutMs: 2000,
		});
		expect(client).not.toBeNull();
		const doc = await client?.getCapabilities();
		expect(doc?.capabilities.bind_map).toBe(true);
		expect(doc?.version).toBe("4.1.0");
		expect(doc?.methods).toEqual([...SENDER_CONTROL_METHODS]);
		expect(supportsStatsSubscription(doc ?? null)).toBe(true);
		client?.close();
	});

	/*
	  THE LEGACY-BINARY PATH. The shipped 3.3.0 sender answers `get_capabilities`
	  (underscore) with exactly this frame — captured live. Feature detection must
	  read it as "no capability support" and RESOLVE, because the caller runs it on
	  the stream-start path where a rejection becomes a failed stream.
	*/
	test("method-not-found resolves to null instead of throwing", async () => {
		const { path } = await startServer(socketPath("legacy"), (frame) => [
			JSON.stringify({
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: "Method not found" },
				id: frame.id,
				jsonrpc: "2.0",
			}),
		]);
		const client = await createControlClient({
			socketPath: path,
			timeoutMs: 2000,
		});
		const doc = await client?.getCapabilities();
		expect(doc).toBeNull();
		expect(supportsStatsSubscription(doc ?? null)).toBe(false);
		client?.close();
	});

	test("a document missing a frozen capability key is refused (pessimistic)", async () => {
		const { path } = await startServer(socketPath("partial"), (frame) => [
			JSON.stringify({
				jsonrpc: "2.0",
				result: {
					schema_version: 1,
					binary: "srtla_send",
					version: "9.9.9",
					capabilities: { bind_map: true },
				},
				id: frame.id,
			}),
		]);
		const client = await createControlClient({
			socketPath: path,
			timeoutMs: 2000,
		});
		expect(await client?.getCapabilities()).toBeNull();
		client?.close();
	});

	test("a build advertising no subscribe method is not subscribable", () => {
		expect(
			supportsStatsSubscription({
				schema_version: 1,
				binary: "srtla_send",
				version: "4.1.0",
				capabilities: {
					bind_map: true,
					stats_file: true,
					dry_run: true,
					control_socket_jsonrpc: true,
					conn_timeout_ms: true,
					modes: ["classic", "enhanced"],
				},
				methods: ["get_capabilities", "get_stats"],
			}),
		).toBe(false);
	});
});

describe("get_stats and the stats-topic projection", () => {
	test("get_stats parses the snapshot and keeps the ADR-003 pair", async () => {
		const { path } = await startServer(socketPath("stats"), (frame) => [
			JSON.stringify({ jsonrpc: "2.0", result: statsResult(), id: frame.id }),
		]);
		const client = await createControlClient({
			socketPath: path,
			timeoutMs: 2000,
		});
		const stats = await client?.getStats();
		expect(stats?.links).toHaveLength(2);
		expect(stats?.bind_map_status?.state).toBe("active");
		expect(stats?.disposition?.state).toBe("mapped");
		client?.close();
	});

	test("the projection applies the x8 to the rate and NOT to the byte count", () => {
		const stats = {
			mode: "enhanced",
			session_bytes_sent: 1_620_000_000,
			links: [
				{
					conn_id: 0,
					connected: true,
					timed_out: false,
					window: 8192,
					in_flight: 100,
					rtt_ms: 42,
					nak_count: 3,
					bitrate_bytes_per_sec: 312_500,
					bytes_sent_total: 812_000_000,
					base_score: 81,
					quality_multiplier: 1,
				},
			],
		};
		const telemetry = senderStatsToTelemetry(stats, 1_749_556_546_000);
		const conn = telemetry?.connections[0];
		expect(conn?.bitrate_bps).toBe(2_500_000);
		expect(conn?.bitrate_bps).toBe(312_500 * 8);
		expect(conn?.bytes_sent_total).toBe(812_000_000);
		expect(telemetry?.bytes_sent_total).toBe(1_620_000_000);
		expect(telemetry?.schema_version).toBe(1);
		expect(telemetry?.last_updated_ms).toBe(1_749_556_546_000);
	});

	test("weight_percent is the normalized base_score x quality share", () => {
		const link = (base: number, quality: number) => ({
			conn_id: 0,
			connected: true,
			timed_out: false,
			window: 0,
			in_flight: 0,
			rtt_ms: 0,
			nak_count: 0,
			bitrate_bytes_per_sec: 0,
			base_score: base,
			quality_multiplier: quality,
		});
		const telemetry = senderStatsToTelemetry(
			{ mode: "enhanced", links: [link(75, 1), link(25, 1)] },
			0,
		);
		expect(telemetry?.connections[0]?.weight_percent).toBe(75);
		expect(telemetry?.connections[1]?.weight_percent).toBe(25);
	});

	test("an inactive link reports 0 and never dilutes the active share", () => {
		const telemetry = senderStatsToTelemetry(
			{
				mode: "enhanced",
				links: [
					{
						conn_id: 0,
						connected: true,
						timed_out: false,
						window: 0,
						in_flight: 0,
						rtt_ms: 0,
						nak_count: 0,
						bitrate_bytes_per_sec: 0,
						base_score: 50,
						quality_multiplier: 1,
					},
					{
						conn_id: 1,
						connected: true,
						timed_out: true,
						window: 0,
						in_flight: 0,
						rtt_ms: 0,
						nak_count: 0,
						bitrate_bytes_per_sec: 0,
						base_score: 50,
						quality_multiplier: 1,
					},
				],
			},
			0,
		);
		expect(telemetry?.connections[0]?.weight_percent).toBe(100);
		expect(telemetry?.connections[1]?.weight_percent).toBe(0);
	});

	test("a freshly-registered bond with no capacity signal falls back to an equal share", () => {
		const fresh = (id: number) => ({
			conn_id: id,
			connected: true,
			timed_out: false,
			window: 0,
			in_flight: 0,
			rtt_ms: 0,
			nak_count: 0,
			bitrate_bytes_per_sec: 0,
			base_score: 0,
			quality_multiplier: 1,
		});
		const telemetry = senderStatsToTelemetry(
			{ mode: "enhanced", links: [fresh(0), fresh(1)] },
			0,
		);
		expect(telemetry?.connections.map((conn) => conn.weight_percent)).toEqual([
			50, 50,
		]);
	});

	test("iface/link_id are echoed and an unmapped link materializes neither key", () => {
		const telemetry = senderStatsToTelemetry(
			{
				mode: "enhanced",
				links: [
					{
						conn_id: 0,
						iface: "wwan0",
						link_id: "modem-a",
						connected: true,
						timed_out: false,
						window: 1,
						in_flight: 0,
						rtt_ms: 1,
						nak_count: 0,
						bitrate_bytes_per_sec: 0,
						base_score: 1,
						quality_multiplier: 1,
					},
					{
						conn_id: 1,
						connected: true,
						timed_out: false,
						window: 1,
						in_flight: 0,
						rtt_ms: 1,
						nak_count: 0,
						bitrate_bytes_per_sec: 0,
						base_score: 1,
						quality_multiplier: 1,
					},
				],
			},
			0,
		);
		expect(telemetry?.connections[0]?.iface).toBe("wwan0");
		expect(telemetry?.connections[0]?.link_id).toBe("modem-a");
		const unmapped = telemetry?.connections[1];
		expect(unmapped && "iface" in unmapped).toBe(false);
		expect(unmapped && "link_id" in unmapped).toBe(false);
	});
});

describe("subscribeStats", () => {
	test("subscribes to the stats topic and projects each stats.update push", async () => {
		let subscribeParams: unknown;
		const server = await startServer(socketPath("sub"), (frame) => {
			if (frame.method !== "subscribe") return null;
			subscribeParams = frame.params;
			return [
				JSON.stringify({
					jsonrpc: "2.0",
					result: { subscription_id: "sub-0" },
					id: frame.id,
				}),
			];
		});
		const client = await createControlClient({
			socketPath: server.path,
			timeoutMs: 2000,
		});
		const seen: Array<number | null> = [];
		const stop = client?.subscribeStats((snapshot) => {
			seen.push(snapshot?.connections[0]?.bitrate_bps ?? null);
		});
		await Bun.sleep(30);
		expect(subscribeParams).toEqual({ topic: "stats" });

		server.push(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "stats.update",
				params: { subscription_id: "sub-0", data: statsResult() },
			}),
		);
		await Bun.sleep(30);
		expect(seen).toEqual([2_500_000]);
		stop?.();
	});

	test("an unparseable push surfaces null rather than a malformed snapshot", async () => {
		const server = await startServer(socketPath("badpush"), (frame) =>
			frame.method === "subscribe"
				? [
						JSON.stringify({
							jsonrpc: "2.0",
							result: { subscription_id: "sub-0" },
							id: frame.id,
						}),
					]
				: null,
		);
		const client = await createControlClient({
			socketPath: server.path,
			timeoutMs: 2000,
		});
		const seen: Array<unknown> = [];
		const stop = client?.subscribeStats((snapshot) => seen.push(snapshot));
		await Bun.sleep(30);
		server.push(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "stats.update",
				params: { subscription_id: "sub-0", data: { links: "not-an-array" } },
			}),
		);
		await Bun.sleep(30);
		expect(seen).toEqual([null]);
		stop?.();
	});

	test("a refused subscribe reports null so the caller can keep its file poll", async () => {
		const server = await startServer(socketPath("refused"), (frame) => [
			JSON.stringify({
				jsonrpc: "2.0",
				error: { code: JSON_RPC_METHOD_NOT_FOUND, message: "Method not found" },
				id: frame.id,
			}),
		]);
		const client = await createControlClient({
			socketPath: server.path,
			timeoutMs: 2000,
		});
		const seen: Array<unknown> = [];
		const stop = client?.subscribeStats((snapshot) => seen.push(snapshot));
		await Bun.sleep(40);
		expect(seen).toEqual([null]);
		stop?.();
	});

	/*
	  The demultiplexer's reason to exist: the subscription holds the connection
	  open for the rest of its life, so a later request must still be answerable.
	  A single-slot line handler (the retired binding's shape) loses this.
	*/
	test("a request still resolves while a subscription is streaming", async () => {
		const server = await startServer(socketPath("mux"), (frame) => {
			if (frame.method === "subscribe") {
				return [
					JSON.stringify({
						jsonrpc: "2.0",
						result: { subscription_id: "sub-0" },
						id: frame.id,
					}),
				];
			}
			if (frame.method === "get_status") {
				return [
					JSON.stringify({
						jsonrpc: "2.0",
						result: { mode: "enhanced", conn_timeout_ms: 15000 },
						id: frame.id,
					}),
				];
			}
			return null;
		});
		const client = await createControlClient({
			socketPath: server.path,
			timeoutMs: 2000,
		});
		const stop = client?.subscribeStats(() => {});
		await Bun.sleep(30);
		server.push(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "stats.update",
				params: { subscription_id: "sub-0", data: statsResult() },
			}),
		);
		const status = await client?.getStatus();
		expect(status?.mode).toBe("enhanced");
		expect(status?.conn_timeout_ms).toBe(15000);
		stop?.();
	});
});

describe("setters echo the APPLIED value", () => {
	test("set_conn_timeout returns the sender's clamped value, not the input", async () => {
		const { path } = await startServer(socketPath("clamp"), (frame) => [
			// The sender clamps to 1000..=60000; ask for 999999, get 60000.
			JSON.stringify({ jsonrpc: "2.0", result: { ms: 60000 }, id: frame.id }),
		]);
		const client = await createControlClient({
			socketPath: path,
			timeoutMs: 2000,
		});
		expect(await client?.setConnTimeout(999_999)).toBe(60_000);
		client?.close();
	});
});
