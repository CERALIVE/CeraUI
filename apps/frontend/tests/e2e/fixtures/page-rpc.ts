import type { Page, WebSocketRoute } from "@playwright/test";

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

export interface RpcServerRoute {
	send(message: string | Buffer): void;
	close(options?: { code?: number; reason?: string }): void;
	onClose(handler: (code?: number, reason?: string) => void): void;
}

interface ServerWaiter {
	resolve(server: RpcServerRoute): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

interface PushWaiter {
	type: string;
	resolve(): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

export class PageRpc {
	private readonly pending = new Map<string, PendingCall>();
	private readonly serverWaiters = new Set<ServerWaiter>();
	private readonly pushWaiters = new Set<PushWaiter>();
	/** Broadcast types observed on the CURRENT server connection. */
	private readonly seenPushTypes = new Set<string>();
	private nextId = 0;
	private server: RpcServerRoute | null = null;

	async install(page: Page): Promise<void> {
		await page.routeWebSocket(
			/:(3002|31\d\d|6173|8090|8091)\/ws(?:\?|$)/,
			(socket) => {
				const server = socket.connectToServer();
				this.bindConnectionLifecycle(socket, server);
				socket.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					socket.send(message);
					this.acceptServerMessage(message);
				});
			},
		);
	}

	bindConnectionLifecycle(
		browser: RpcServerRoute,
		server: RpcServerRoute,
	): void {
		this.attachServer(server);
		let closed = false;
		const closeRoutes = (
			peer: RpcServerRoute,
			code: number | undefined,
			reason: string | undefined,
		) => {
			if (closed) return;
			closed = true;
			this.disconnectServer(server);
			peer.close({
				...(code === undefined ? {} : { code }),
				...(reason === undefined ? {} : { reason }),
			});
		};
		browser.onClose((code, reason) => closeRoutes(server, code, reason));
		server.onClose((code, reason) => closeRoutes(browser, code, reason));
	}

	attachServer(server: RpcServerRoute): void {
		if (this.server && this.server !== server) {
			this.rejectPending("page RPC connection replaced");
		}
		this.seenPushTypes.clear();
		this.server = server;
		for (const waiter of this.serverWaiters) {
			clearTimeout(waiter.timeout);
			waiter.resolve(server);
		}
		this.serverWaiters.clear();
	}

	disconnectServer(server: RpcServerRoute): void {
		if (this.server !== server) return;
		this.server = null;
		this.seenPushTypes.clear();
		this.rejectPending("page RPC connection closed");
	}

	acceptServerMessage(message: string | Buffer): void {
		if (typeof message !== "string") return;
		let envelope: RpcResponse & Record<string, unknown>;
		try {
			envelope = JSON.parse(message) as RpcResponse & Record<string, unknown>;
		} catch {
			return;
		}
		const pending = this.pending.get(envelope.id);
		if (!pending) {
			this.notePushedEvent(envelope);
			return;
		}
		clearTimeout(pending.timeout);
		this.pending.delete(envelope.id);
		if (envelope.error) {
			pending.reject(new Error(envelope.error.message ?? "RPC request failed"));
		} else {
			pending.resolve(envelope.result);
		}
	}

	private notePushedEvent(envelope: Record<string, unknown>): void {
		// An RPC reply the app made on its own socket still reaches this route
		// with no matching pending call. It carries an `id`; a broadcast never
		// does, so that is the discriminator — without it a reply's `result` key
		// would be recorded as a broadcast type.
		if (envelope.id !== undefined) return;
		for (const type of Object.keys(envelope)) {
			if (type === "seq") continue;
			this.seenPushTypes.add(type);
			for (const waiter of [...this.pushWaiters]) {
				if (waiter.type !== type) continue;
				this.pushWaiters.delete(waiter);
				clearTimeout(waiter.timeout);
				waiter.resolve();
			}
		}
	}

	/**
	 * Resolve once the backend has PUSHED a `type` broadcast on the current page
	 * socket — immediately when one already arrived since that socket attached.
	 *
	 * A broadcast envelope is `{ [type]: data, seq }` with no request id, so
	 * `acceptServerMessage` has nothing to correlate it with and drops it. This is
	 * the opt-in seam for a spec that must order its own `dev.emit` injections
	 * against a SERVER-INITIATED frame.
	 */
	waitForPushedEvent(type: string, timeoutMs = 15_000): Promise<void> {
		if (this.seenPushTypes.has(type)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const waiter: PushWaiter = {
				type,
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.pushWaiters.delete(waiter);
					reject(new Error(`timed out waiting for a pushed "${type}" event`));
				}, timeoutMs),
			};
			this.pushWaiters.add(waiter);
		});
	}

	private waitForServer(): Promise<RpcServerRoute> {
		if (this.server) return Promise.resolve(this.server);
		return new Promise((resolve, reject) => {
			const waiter: ServerWaiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.serverWaiters.delete(waiter);
					reject(new Error("page WebSocket is not connected"));
				}, 10_000),
			};
			this.serverWaiters.add(waiter);
		});
	}

	async call<T>(path: string[], input?: unknown): Promise<T> {
		const server = await this.waitForServer();
		const id = `e2e_page_${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC request timed out: ${path.join(".")}`));
			}, 10_000);
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timeout,
			});
			if (this.server !== server) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(new Error("page RPC connection closed"));
				return;
			}
			try {
				server.send(JSON.stringify({ id, path, input }));
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
		this.server = null;
		this.seenPushTypes.clear();
		this.rejectPending("page RPC route closed");
		for (const waiter of this.serverWaiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(new Error("page RPC route closed"));
		}
		this.serverWaiters.clear();
		for (const waiter of this.pushWaiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(new Error("page RPC route closed"));
		}
		this.pushWaiters.clear();
	}
}
