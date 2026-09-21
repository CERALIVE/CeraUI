/**
 * JSON-RPC 2.0 control client for the hard-forked `srtla_send`, over its
 * `--control-socket` Unix domain socket.
 *
 * THE DIALECT IS UPSTREAM'S, NOT THE RETIRED BINDING'S. The npm sender binding
 * this package absorbed spoke `hello` / `subscribe-events` / an `event`
 * notification. The hard-forked sender dispatches a different, frozen method
 * set (`src/control.rs`, `const METHODS`) and a topic-based push model
 * (`src/subscriptions.rs`). Neither `hello` nor `subscribe-events` exists on the
 * new binary — asking for either answers `-32601`, so the old client could not
 * even feature-detect. This module replaces it wholesale.
 *
 * WIRE SHAPES, verified live against `srtla_send 4.1.0`:
 *
 *   request   {"jsonrpc":"2.0","id":1,"method":"get_capabilities"}
 *   response  {"jsonrpc":"2.0","result":{...},"id":1}
 *   subscribe {"jsonrpc":"2.0","id":3,"method":"subscribe","params":{"topic":"stats"}}
 *             -> {"jsonrpc":"2.0","result":{"subscription_id":"sub-0"},"id":3}
 *   push      {"jsonrpc":"2.0","method":"stats.update",
 *              "params":{"subscription_id":"sub-0","data":{<StatsSnapshot>}}}
 *
 * Framing is newline-delimited JSON, one document per line, in both directions.
 *
 * FEATURE DETECTION IS `get_capabilities`, NEVER `hello`. A binary that predates
 * the hard fork answers `get_capabilities` with `-32601 Method not found`
 * (verified against the shipped `3.3.0` binary), and {@link ControlClient
 * .getCapabilities} turns exactly that into `null` rather than a rejection —
 * "this build cannot tell me what it supports" is an answer, not a fault, and a
 * throw on the telemetry start path would turn a graceful downgrade into a
 * failed stream.
 *
 * TELEMETRY SHAPE. `get_stats` and the `stats` topic both carry the sender's
 * `StatsSnapshot` (`src/stats.rs`), which is NOT the ADR-001 `--stats-file`
 * document: `conn_id` is a number, the rate field is `bitrate_bytes_per_sec`
 * (bytes/s, no x8), and `weight_percent` does not exist at all.
 * {@link senderStatsToTelemetry} projects one into the other, mirroring the
 * producer's own `conns_from_stats` (`src/telemetry_doc.rs`) so the subscription
 * path and the file-poll path hand the consumer byte-compatible snapshots.
 */
import { z } from "zod";
import {
	bindMapDispositionSchema,
	bindMapStatusSchema,
	type Telemetry,
	telemetrySchema,
} from "../telemetry/index";

// ---------------------------------------------------------------------------
// The frozen method + topic vocabulary (mirrors src/control.rs)
// ---------------------------------------------------------------------------

/**
 * Every method the sender's control plane dispatches, in the sender's own
 * order. Reproduced here so a caller can assert the live `methods` array
 * without a second round trip; the live array is still what feature detection
 * reads, because this constant describes the build we were written against.
 */
export const SENDER_CONTROL_METHODS = [
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
] as const;

export type SenderControlMethod = (typeof SENDER_CONTROL_METHODS)[number];

/** Per-link snapshot topic — fired once per housekeeping tick (~1 Hz). */
export const STATS_TOPIC = "stats";
/** Critical-window extension topic from the keyframe priority sidecar. */
export const PRIORITY_WINDOW_TOPIC = "priority.window";

/** Topics `subscribe` accepts (`src/control.rs::is_known_topic`). */
export const SENDER_CONTROL_TOPICS = [
	STATS_TOPIC,
	PRIORITY_WINDOW_TOPIC,
] as const;

/** Notification method a subscribed topic pushes: `<topic>.update`. */
export function topicNotificationMethod(topic: string): string {
	return `${topic}.update`;
}

/** JSON-RPC reserved error codes the sender emits. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** Client-side code for a request that never got an answer. */
export const CONTROL_TIMEOUT_CODE = -32000;

// ---------------------------------------------------------------------------
// Capability document (`get_capabilities` / `--capabilities-json` + `methods`)
// ---------------------------------------------------------------------------

/**
 * The frozen capability key set (`src/capabilities.rs::Capabilities`). Required,
 * not optional: the set is declared frozen upstream and may only GROW, so a
 * document missing one of these is not a newer build — it is a build whose
 * answer we should not trust, and the pessimistic read (no support, stay on the
 * file poll) is the safe one.
 */
export const senderCapabilitiesSchema = z.object({
	bind_map: z.boolean(),
	stats_file: z.boolean(),
	dry_run: z.boolean(),
	control_socket_jsonrpc: z.boolean(),
	conn_timeout_ms: z.boolean(),
	modes: z.array(z.string()),
});

/**
 * The runtime capability document. Identical to the `--capabilities-json`
 * pre-spawn probe's document plus the additive `methods` array — pinned on the
 * sender side by `get_capabilities_matches_the_pre_spawn_probe_document`, so
 * `methods` is optional here and only the runtime answer carries it.
 */
export const senderCapabilityDocumentSchema = z.object({
	schema_version: z.number().int(),
	binary: z.string(),
	version: z.string(),
	capabilities: senderCapabilitiesSchema,
	methods: z.array(z.string()).optional(),
});

export type SenderCapabilities = z.output<typeof senderCapabilitiesSchema>;
export type SenderCapabilityDocument = z.output<
	typeof senderCapabilityDocumentSchema
>;

/**
 * Does this build push per-link snapshots over the control socket?
 *
 * Read off the live `methods` array rather than a hand-maintained capability
 * string: the sender publishes the exact set it dispatches, so a build that
 * drops `subscribe` stops advertising it in the same commit.
 */
export function supportsStatsSubscription(
	doc: SenderCapabilityDocument | null,
): boolean {
	if (!doc) return false;
	const methods = doc.methods ?? [];
	return methods.includes("subscribe") && methods.includes("unsubscribe");
}

// ---------------------------------------------------------------------------
// `get_stats` / `stats` topic payload (src/stats.rs StatsSnapshot)
// ---------------------------------------------------------------------------

/**
 * One link of the sender's `StatsSnapshot`.
 *
 * Only the fields this client projects are declared; `StatsSnapshot` carries
 * ~35 per-link diagnostics (CC state, weak-link classifier, stall counters) and
 * Zod strips the undeclared ones. Declaring them all would make this schema a
 * second, drifting copy of a struct that is explicitly allowed to grow.
 */
export const senderLinkStatsSchema = z.object({
	conn_id: z.number().int().min(0),
	iface: z.string().min(1).optional(),
	link_id: z.string().min(1).optional(),
	connected: z.boolean(),
	timed_out: z.boolean(),
	window: z.number().int(),
	in_flight: z.number().int(),
	rtt_ms: z.number().int().min(0),
	nak_count: z.number().int(),
	/** Wire BYTES per second. The x8 to bits/s is this client's job. */
	bitrate_bytes_per_sec: z.number().int().min(0),
	bytes_sent_total: z.number().int().min(0).optional(),
	/** `window / (in_flight + 1)` — the classic capacity score. */
	base_score: z.number().int(),
	/** Enhanced-mode quality multiplier, ~0.35..1.1. */
	quality_multiplier: z.number(),
});

export const senderStatsSchema = z.object({
	mode: z.string(),
	quality_enabled: z.boolean().optional(),
	active_links: z.number().int().min(0).optional(),
	total_links: z.number().int().min(0).optional(),
	session_bytes_sent: z.number().int().min(0).optional(),
	links: z.array(senderLinkStatsSchema),
	bind_map_status: bindMapStatusSchema.optional(),
	disposition: bindMapDispositionSchema.optional(),
});

export type SenderLinkStats = z.output<typeof senderLinkStatsSchema>;
export type SenderStats = z.output<typeof senderStatsSchema>;

/** `get_status` — the live `ConfigSnapshot`. Everything past `mode` is additive. */
export const senderStatusSchema = z.object({
	mode: z.string(),
	quality_enabled: z.boolean().optional(),
	stall_deselect: z.boolean().optional(),
	stall_min_in_flight: z.number().optional(),
	stall_ack_stale_ms: z.number().optional(),
	conn_timeout_ms: z.number().optional(),
});

export type SenderStatus = z.output<typeof senderStatusSchema>;

/**
 * Project a `StatsSnapshot` into the ADR-001 telemetry shape the `--stats-file`
 * poll produces.
 *
 * The arithmetic MIRRORS the producer's `conns_from_stats`
 * (`src/telemetry_doc.rs`) deliberately, field for field, so the two telemetry
 * sources are interchangeable:
 *
 *  - `conn_id` is the link's POSITION in the snapshot array, stringified — the
 *    same transient, IP-list-order identity the file document publishes (and the
 *    same reason a UI must key on `link_id`);
 *  - `weight_percent` does not exist in `StatsSnapshot`; it is
 *    `base_score x quality_multiplier` normalized across links that are both
 *    connected and not timed out. An inactive link reports 0. A group with no
 *    capacity signal yet falls back to an equal share, so a freshly-registered
 *    bond is not reported as all-zero;
 *  - `bitrate_bps` applies the mandated x8, because the snapshot's field is
 *    bytes/s and the telemetry contract's is bits/s;
 *  - `bytes_sent_total` gets NO x8 — it is a byte count, not a rate — and the
 *    bond total is forwarded from the sender's own accumulator rather than
 *    summed from the live links, which would regress on a reload.
 *
 * Returns `null` if the projection does not validate against
 * {@link telemetrySchema}, so a shape drift surfaces as "no snapshot" instead of
 * as a malformed one leaking into the UI.
 */
export function senderStatsToTelemetry(
	stats: SenderStats,
	lastUpdatedMs: number = Date.now(),
): Telemetry | null {
	const isActive = (link: SenderLinkStats): boolean =>
		link.connected && !link.timed_out;

	const weights = stats.links.map((link) =>
		isActive(link) ? Math.max(link.base_score, 0) * link.quality_multiplier : 0,
	);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const activeCount = stats.links.filter(isActive).length;
	const equalShare =
		activeCount > 0 ? Math.min(Math.floor(100 / activeCount), 100) : 0;

	const connections = stats.links.map((link, index) => {
		const weight = weights[index] ?? 0;
		const weightPercent = !isActive(link)
			? 0
			: total > 0
				? Math.min(Math.max(Math.round((weight / total) * 100), 0), 100)
				: equalShare;
		return {
			conn_id: String(index),
			rtt_ms: link.rtt_ms,
			nak_count: Math.max(link.nak_count, 0),
			weight_percent: weightPercent,
			window: link.window,
			in_flight: link.in_flight,
			// The mandated bytes/s -> bits/s conversion, applied exactly once.
			bitrate_bps: link.bitrate_bytes_per_sec * 8,
			// A byte COUNT: deliberately NOT multiplied, unlike the field above.
			...(link.bytes_sent_total === undefined
				? {}
				: { bytes_sent_total: link.bytes_sent_total }),
			...(link.iface === undefined ? {} : { iface: link.iface }),
			...(link.link_id === undefined ? {} : { link_id: link.link_id }),
		};
	});

	const parsed = telemetrySchema.safeParse({
		schema_version: 1,
		last_updated_ms: lastUpdatedMs,
		connections,
		...(stats.session_bytes_sent === undefined
			? {}
			: { bytes_sent_total: stats.session_bytes_sent }),
		...(stats.bind_map_status === undefined
			? {}
			: { bind_map_status: stats.bind_map_status }),
		...(stats.disposition === undefined
			? {}
			: { disposition: stats.disposition }),
	});
	return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface ControlClientOptions {
	socketPath: string;
	/** Per-request timeout in ms (default: 5000). */
	timeoutMs?: number;
}

export class ControlRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = "ControlRpcError";
		this.code = code;
	}
}

/**
 * The slice of the control surface the telemetry path needs.
 *
 * Split out so a consumer (and its test doubles) depends on the three calls it
 * actually makes rather than on the whole method table; {@link ControlClient}
 * remains assignable to it.
 */
export interface TelemetryControlClient {
	getCapabilities(): Promise<SenderCapabilityDocument | null>;
	subscribeStats(onEvent: (snapshot: Telemetry | null) => void): () => void;
	close(): void;
}

export interface ControlClient extends TelemetryControlClient {
	getStats(): Promise<SenderStats | null>;
	getStatus(): Promise<SenderStatus | null>;
	getSubscriptionCount(): Promise<number>;
	setMode(mode: string): Promise<string>;
	setQuality(enabled: boolean): Promise<boolean>;
	setStallDeselect(enabled: boolean): Promise<boolean>;
	/** Returns the APPLIED value — the sender clamps to 1000..=60000. */
	setConnTimeout(ms: number): Promise<number>;
	subscribe(topic: string): Promise<string>;
	unsubscribe(subscriptionId: string): Promise<boolean>;
	rawRequest(method: string, params?: unknown): Promise<unknown>;
}

interface JsonRpcFrame {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
	method?: string;
	params?: unknown;
}

type UnixSocket = Awaited<ReturnType<typeof Bun.connect>>;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Newline-delimited JSON-RPC demultiplexer over one Unix socket.
 *
 * Responses are routed by `id` and notifications by `method`, CONCURRENTLY: the
 * subscription occupies the connection for the rest of its life, so a
 * single-slot line handler (what the retired binding used) would make every
 * later request unanswerable. Nothing here assumes request/response is the only
 * traffic on the wire.
 */
class LineConnection {
	private readonly socket: UnixSocket;
	private readonly decoder = new TextDecoder();
	private buffer = "";
	private readonly pending = new Map<number, Pending>();
	private notificationHandler:
		| ((method: string, params: unknown) => void)
		| null = null;
	private disconnectHandler: (() => void) | null = null;
	private closed = false;

	constructor(socket: UnixSocket) {
		this.socket = socket;
	}

	onData(chunk: Uint8Array): void {
		this.buffer += this.decoder.decode(chunk, { stream: true });
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.trim().length > 0) this.handleLine(line);
			nl = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let frame: JsonRpcFrame;
		try {
			frame = JSON.parse(line) as JsonRpcFrame;
		} catch {
			return;
		}
		if (typeof frame.id === "number") {
			const waiter = this.pending.get(frame.id);
			if (!waiter) return;
			this.pending.delete(frame.id);
			clearTimeout(waiter.timer);
			if (frame.error) {
				waiter.reject(
					new ControlRpcError(frame.error.code, frame.error.message),
				);
				return;
			}
			waiter.resolve(frame.result);
			return;
		}
		if (typeof frame.method === "string") {
			this.notificationHandler?.(frame.method, frame.params);
		}
	}

	/** Called by Bun's socket close/error callbacks. Fails every waiter. */
	onDisconnect(): void {
		const handler = this.disconnectHandler;
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(new ControlRpcError(CONTROL_TIMEOUT_CODE, "socket closed"));
		}
		this.pending.clear();
		this.notificationHandler = null;
		this.disconnectHandler = null;
		handler?.();
	}

	setNotificationHandler(
		handler: ((method: string, params: unknown) => void) | null,
	): void {
		this.notificationHandler = handler;
	}

	setDisconnectHandler(handler: (() => void) | null): void {
		this.disconnectHandler = handler;
	}

	request(id: number, frame: string, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new ControlRpcError(CONTROL_TIMEOUT_CODE, "socket closed"));
				return;
			}
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new ControlRpcError(
						CONTROL_TIMEOUT_CODE,
						`control request timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.write(`${frame}\n`);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.reject(new ControlRpcError(CONTROL_TIMEOUT_CODE, "socket closed"));
		}
		this.pending.clear();
		this.notificationHandler = null;
		this.disconnectHandler = null;
		this.socket.end();
	}
}

function isMethodNotFound(error: unknown): boolean {
	return (
		error instanceof ControlRpcError && error.code === JSON_RPC_METHOD_NOT_FOUND
	);
}

/**
 * Connect to a running sender's control socket.
 *
 * Resolves `null` when the socket cannot be reached at all (not running, path
 * absent, permission denied) — the caller's fallback is the `--stats-file`
 * poll, and a connect failure is not an error condition worth throwing over.
 */
export async function createControlClient(
	options: ControlClientOptions,
): Promise<ControlClient | null> {
	const { socketPath, timeoutMs = 5000 } = options;

	let conn: LineConnection | null = null;
	try {
		const socket = await Bun.connect({
			unix: socketPath,
			socket: {
				data(_socket, chunk) {
					conn?.onData(chunk);
				},
				close() {
					conn?.onDisconnect();
				},
				error() {
					conn?.onDisconnect();
				},
			},
		});
		conn = new LineConnection(socket);
	} catch {
		return null;
	}

	const open = conn;
	let nextId = 1;

	const call = (method: string, params?: unknown): Promise<unknown> => {
		const id = nextId++;
		const frame =
			params === undefined
				? JSON.stringify({ jsonrpc: "2.0", id, method })
				: JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return open.request(id, frame, timeoutMs);
	};

	return {
		/**
		 * NEVER rejects on "this build does not know the method". A pre-hard-fork
		 * binary answers `-32601`, which is a definitive "no capability support",
		 * and the caller must be able to read it as one without a try/catch on the
		 * stream start path. Genuine transport failures (timeout, closed socket)
		 * still reject.
		 */
		async getCapabilities(): Promise<SenderCapabilityDocument | null> {
			let raw: unknown;
			try {
				raw = await call("get_capabilities");
			} catch (error) {
				if (isMethodNotFound(error)) return null;
				throw error;
			}
			const parsed = senderCapabilityDocumentSchema.safeParse(raw);
			return parsed.success ? parsed.data : null;
		},

		async getStats(): Promise<SenderStats | null> {
			const parsed = senderStatsSchema.safeParse(await call("get_stats"));
			return parsed.success ? parsed.data : null;
		},

		async getStatus(): Promise<SenderStatus | null> {
			const parsed = senderStatusSchema.safeParse(await call("get_status"));
			return parsed.success ? parsed.data : null;
		},

		async getSubscriptionCount(): Promise<number> {
			const result = (await call("get_subscription_count")) as {
				count?: number;
			};
			return typeof result?.count === "number" ? result.count : 0;
		},

		async setMode(mode: string): Promise<string> {
			const result = (await call("set_mode", { mode })) as { mode?: string };
			return result?.mode ?? mode;
		},

		async setQuality(enabled: boolean): Promise<boolean> {
			const result = (await call("set_quality", { enabled })) as {
				enabled?: boolean;
			};
			return result?.enabled ?? enabled;
		},

		async setStallDeselect(enabled: boolean): Promise<boolean> {
			const result = (await call("set_stall_deselect", { enabled })) as {
				enabled?: boolean;
			};
			return result?.enabled ?? enabled;
		},

		async setConnTimeout(ms: number): Promise<number> {
			// The sender clamps to 1000..=60000 and echoes what it applied; trust
			// the response, never the input.
			const result = (await call("set_conn_timeout", { ms })) as {
				ms?: number;
			};
			return typeof result?.ms === "number" ? result.ms : ms;
		},

		async subscribe(topic: string): Promise<string> {
			const result = (await call("subscribe", { topic })) as {
				subscription_id?: string;
			};
			if (typeof result?.subscription_id !== "string") {
				throw new ControlRpcError(
					JSON_RPC_INTERNAL_ERROR,
					`subscribe('${topic}') returned no subscription_id`,
				);
			}
			return result.subscription_id;
		},

		async unsubscribe(subscriptionId: string): Promise<boolean> {
			const result = (await call("unsubscribe", {
				subscription_id: subscriptionId,
			})) as { removed?: boolean };
			return result?.removed === true;
		},

		rawRequest(method: string, params?: unknown): Promise<unknown> {
			return call(method, params);
		},

		/**
		 * Subscribe to the `stats` topic and surface each push as an ADR-001
		 * snapshot.
		 *
		 * `onEvent(null)` means "this source is not delivering": a push that does
		 * not project cleanly, a failed subscribe, or a socket disconnect. The
		 * consumer re-arms its file poll on that signal, so it must fire on the
		 * failure paths too — not only on a parse error.
		 */
		subscribeStats(onEvent: (snapshot: Telemetry | null) => void): () => void {
			let stopped = false;
			let subscriptionId: string | null = null;

			open.setNotificationHandler((method, params) => {
				if (method !== topicNotificationMethod(STATS_TOPIC)) return;
				const envelope = params as { data?: unknown } | undefined;
				const parsed = senderStatsSchema.safeParse(envelope?.data);
				onEvent(parsed.success ? senderStatsToTelemetry(parsed.data) : null);
			});
			open.setDisconnectHandler(() => {
				if (!stopped) onEvent(null);
			});

			void call("subscribe", { topic: STATS_TOPIC })
				.then((result) => {
					const id = (result as { subscription_id?: string })?.subscription_id;
					if (typeof id === "string") {
						subscriptionId = id;
						return;
					}
					if (!stopped) onEvent(null);
				})
				.catch(() => {
					if (!stopped) onEvent(null);
				});

			return () => {
				if (stopped) return;
				stopped = true;
				open.setNotificationHandler(null);
				open.setDisconnectHandler(null);
				if (subscriptionId !== null) {
					// Best effort: the close below drops the connection anyway, which
					// is what actually retires the subscription server-side.
					void call("unsubscribe", {
						subscription_id: subscriptionId,
					}).catch(() => {
						// The close() below retires the subscription regardless.
					});
				}
				open.close();
			};
		},

		close(): void {
			open.close();
		},
	};
}
