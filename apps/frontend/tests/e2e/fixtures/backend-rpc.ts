interface RpcResponse {
	id: string;
	result?: unknown;
	error?: { message?: string };
}

interface PendingCall {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

const E2E_WORKER_SECRET_HEADER = "x-ceraui-worker-secret";
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface BackendRpcSocket {
	readonly readyState: number;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	close(): void;
	send(message: string): void;
}

type BackendRpcSocketFactory = (
	url: string,
	headers: Readonly<Record<string, string>>,
) => BackendRpcSocket;

interface BackendRpcConnectOptions {
	readonly proxySecret?: string;
	readonly createSocket?: BackendRpcSocketFactory;
}

function createBackendRpcSocket(
	url: string,
	headers: Readonly<Record<string, string>>,
): BackendRpcSocket {
	return new WebSocket(url, { headers });
}

export class BackendRpc {
	private readonly pending = new Map<string, PendingCall>();
	private nextId = 0;

	private constructor(private readonly socket: BackendRpcSocket) {
		socket.addEventListener("message", (event) => {
			if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
			const response = JSON.parse(event.data) as RpcResponse;
			const pending = this.pending.get(response.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(response.id);
			if (response.error) {
				pending.reject(new Error(response.error.message ?? "RPC request failed"));
			} else {
				pending.resolve(response.result);
			}
		});
		socket.addEventListener("close", () => {
			this.rejectPending("RPC socket closed");
		});
		socket.addEventListener("error", () => {
			this.rejectPending("RPC socket failed");
		});
	}

	static async connect(
		port: number,
		options: BackendRpcConnectOptions = {},
	): Promise<BackendRpc> {
		const headers =
			options.proxySecret === undefined
				? {}
				: { [E2E_WORKER_SECRET_HEADER]: options.proxySecret };
		const socket = (options.createSocket ?? createBackendRpcSocket)(
			`ws://127.0.0.1:${port}/ws`,
			headers,
		);
		try {
			await new Promise<void>((resolve, reject) => {
				let settled = false;
				const cleanup = () => {
					clearTimeout(timeout);
					socket.removeEventListener("open", onOpen);
					socket.removeEventListener("error", onError);
					socket.removeEventListener("close", onClose);
				};
				const settle = (error?: Error) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (error === undefined) resolve();
					else reject(error);
				};
				const onOpen = () => settle();
				const onError = () =>
					settle(new Error(`RPC socket failed on :${port}`));
				const onClose = () =>
					settle(new Error(`RPC socket closed before open on :${port}`));
				const timeout = setTimeout(() => {
					settle(new Error(`RPC socket handshake timed out on :${port}`));
				}, HANDSHAKE_TIMEOUT_MS);

				socket.addEventListener("open", onOpen);
				socket.addEventListener("error", onError);
				socket.addEventListener("close", onClose);
				if (socket.readyState === WebSocket.OPEN) onOpen();
				else if (socket.readyState > WebSocket.OPEN) onClose();
			});
		} catch (error) {
			socket.close();
			throw error;
		}
		const client = new BackendRpc(socket);
		try {
			const login = await client.call<{ success: boolean }>(["auth", "login"], {
				password: process.env.E2E_PASSWORD ?? "12345678",
				persistent_token: false,
			});
			if (login.success) return client;
			throw new Error(`RPC authentication failed on :${port}`);
		} catch (error) {
			client.close();
			throw error;
		}
	}

	call<T>(path: string[], input?: unknown): Promise<T> {
		const id = `e2e_${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			if (this.socket.readyState !== WebSocket.OPEN) {
				reject(new Error("RPC socket is not open"));
				return;
			}
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC request timed out: ${path.join(".")}`));
			}, 10_000);
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timeout,
			});
			try {
				this.socket.send(JSON.stringify({ id, path, input }));
			} catch (error) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private rejectPending(message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(message));
		}
		this.pending.clear();
	}

	close(): void {
		this.rejectPending("RPC socket closed");
		this.socket.close();
	}
}
