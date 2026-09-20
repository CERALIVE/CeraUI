// TODO(41): REWRITE PENDING — this file is the LEGACY control client, moved
// verbatim from the retired npm sender binding so the absorption is a pure move. It speaks the OLD sender's dialect (`hello`,
// `subscribe-events`, an `event` notification). The hard-forked sender speaks
// upstream's JSON-RPC methods instead (`get_stats`, `subscribe`, `unsubscribe`,
// `set_mode`, `get_capabilities`), so NOTHING here is known to work against the
// new binary.
//
// Plan `upstream-rebase-hard-fork` todo 41 replaces this module wholesale and
// re-points `apps/backend/src/modules/streaming/link-telemetry.ts` at it. Until
// then the file is EXCLUDED from this package's own build/typecheck
// (`tsconfig.json` -> `exclude: ["src/control/**/*"]`) and must not be treated
// as a live contract. Do not extend it; todo 41 deletes it.

/**
 * JSON-RPC 2.0 control client for srtla_send over the Unix --control-socket.
 *
 * TODO(41): superseded by upstream's dialect; see the banner above.
 *
 * Modelled on the @ceralive/cerastream client shape: connect, hello, rawRequest,
 * subscribeStats. Bun-native (Bun.connect); no node:child_process.
 */
import { type Telemetry, telemetrySchema } from "../telemetry/index";

export const STATS_SUBSCRIPTION_CAPABILITY = "stats-subscription";

export interface HelloResult {
	schema_version: number;
	engine: string;
	capabilities: string[];
}

export function supportsStatsSubscription(hello: HelloResult): boolean {
	return hello.capabilities.includes(STATS_SUBSCRIPTION_CAPABILITY);
}

export interface ControlClientOptions {
	socketPath: string;
	/** Timeout in ms for hello + subscribe-events (default: 5000). */
	timeoutMs?: number;
}

export interface ControlClient {
	hello(): Promise<HelloResult>;
	rawRequest(method: string, params?: unknown): Promise<unknown>;
	subscribeStats(onEvent: (snapshot: Telemetry | null) => void): () => void;
	close(): void;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
	method?: string;
	params?: unknown;
}

class ControlRpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = "ControlRpcError";
		this.code = code;
	}
}

// A Bun.connect Unix socket whose `data` callback delivers raw bytes; the
// framing is newline-delimited JSON-RPC, so we buffer and split on '\n'.
type UnixSocket = Awaited<ReturnType<typeof Bun.connect>>;

/**
 * One pending request keyed by id, or a line consumer for the subscription
 * stream. The reader pumps complete lines to whichever is active.
 */
class LineConnection {
	private readonly socket: UnixSocket;
	private buffer = "";
	private lineHandler: ((line: string) => void) | null = null;
	private disconnectHandler: (() => void) | null = null;
	private closed = false;

	constructor(socket: UnixSocket) {
		this.socket = socket;
	}

	onData(chunk: Uint8Array): void {
		this.buffer += new TextDecoder().decode(chunk);
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.length > 0) {
				this.lineHandler?.(line);
			}
			nl = this.buffer.indexOf("\n");
		}
	}

	/** Called by the Bun socket close/error callbacks to signal disconnection. */
	onDisconnect(): void {
		const handler = this.disconnectHandler;
		this.lineHandler = null;
		this.disconnectHandler = null;
		handler?.();
	}

	setLineHandler(handler: ((line: string) => void) | null): void {
		this.lineHandler = handler;
	}

	/** Register a one-shot callback invoked when the socket closes or errors. */
	setDisconnectHandler(handler: (() => void) | null): void {
		this.disconnectHandler = handler;
	}

	write(frame: string): void {
		this.socket.write(`${frame}\n`);
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.lineHandler = null;
		this.disconnectHandler = null;
		this.socket.end();
	}

	get isClosed(): boolean {
		return this.closed;
	}
}

interface JsonRpcCall {
	id: number;
	method: string;
	params: unknown;
}

/**
 * Send one JSON-RPC request and resolve with the matching response line.
 *
 * Rejects on the socket closing, on the configured timeout, or on a JSON-RPC
 * `error` member in the reply.
 */
function request(
	conn: LineConnection,
	call: JsonRpcCall,
	timeoutMs: number,
): Promise<unknown> {
	const { id, method, params } = call;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			conn.setLineHandler(null);
			reject(
				new ControlRpcError(-32000, `control request '${method}' timed out`),
			);
		}, timeoutMs);

		conn.setLineHandler((line) => {
			let parsed: JsonRpcResponse;
			try {
				parsed = JSON.parse(line) as JsonRpcResponse;
			} catch {
				return;
			}
			if (parsed.id !== id) {
				return;
			}
			clearTimeout(timer);
			conn.setLineHandler(null);
			if (parsed.error) {
				reject(new ControlRpcError(parsed.error.code, parsed.error.message));
				return;
			}
			resolve(parsed.result);
		});

		const frame =
			params === undefined
				? JSON.stringify({ jsonrpc: "2.0", method, id })
				: JSON.stringify({ jsonrpc: "2.0", method, id, params });
		conn.write(frame);
	});
}

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

	return {
		async hello(): Promise<HelloResult> {
			const result = await request(
				open,
				{ id: nextId++, method: "hello", params: undefined },
				timeoutMs,
			);
			return result as HelloResult;
		},
		rawRequest(method: string, params?: unknown): Promise<unknown> {
			return request(open, { id: nextId++, method, params }, timeoutMs);
		},
		subscribeStats(onEvent: (snapshot: Telemetry | null) => void): () => void {
			// The first line after subscribe-events is NOT an ack — it is the
			// replayed "event" notification (T4). Treat the response as a stream
			// of "event" notifications immediately.
			open.setLineHandler((line) => {
				let parsed: JsonRpcResponse;
				try {
					parsed = JSON.parse(line) as JsonRpcResponse;
				} catch {
					onEvent(null);
					return;
				}
				if (parsed.method !== "event") {
					return;
				}
				const snapshot = telemetrySchema.safeParse(parsed.params);
				onEvent(snapshot.success ? snapshot.data : null);
			});
			// Signal onEvent(null) on socket disconnect so CeraUI can re-arm
			// the file-poll fallback (link-telemetry.ts:411 guard).
			open.setDisconnectHandler(() => {
				onEvent(null);
			});
			open.write(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "subscribe-events",
					id: nextId++,
				}),
			);
			return () => {
				open.setDisconnectHandler(null);
				open.close();
			};
		},
		close(): void {
			open.close();
		},
	};
}
