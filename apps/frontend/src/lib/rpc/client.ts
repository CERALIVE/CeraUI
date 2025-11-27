/**
 * ORPC Client for CeraUI Frontend
 *
 * Provides type-safe RPC calls to the backend via WebSocket.
 * Supports both ORPC-style calls and legacy message format for gradual migration.
 */
import type { AppContract } from "@ceraui/rpc/contracts";

import { ENV_VARIABLES } from "../env";

/**
 * WebSocket connection state
 */
type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * RPC message types
 */
interface RPCRequest {
	id: string;
	path: string[];
	input?: unknown;
}

interface RPCResponse {
	id: string;
	result?: unknown;
	error?: {
		message: string;
		code: string;
	};
}

/**
 * Pending request tracker
 */
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

/**
 * Event handler types
 */
type MessageHandler = (type: string, data: unknown) => void;
type ConnectionHandler = (state: ConnectionState) => void;

/**
 * RPC Client class
 */
class RPCClient {
	private socket: WebSocket | null = null;
	private connectionState: ConnectionState = "disconnected";
	private pendingRequests = new Map<string, PendingRequest>();
	private messageHandlers = new Set<MessageHandler>();
	private connectionHandlers = new Set<ConnectionHandler>();
	private requestIdCounter = 0;
	private reconnectAttempts = 0;
	private maxReconnectAttempts = 5;
	private reconnectDelay = 1000;
	private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * Get WebSocket URL
	 */
	private getUrl(): string {
		return `${ENV_VARIABLES.SOCKET_ENDPOINT}:${ENV_VARIABLES.SOCKET_PORT}`;
	}

	/**
	 * Generate unique request ID
	 */
	private generateId(): string {
		return `req_${++this.requestIdCounter}_${Date.now()}`;
	}

	/**
	 * Connect to WebSocket server
	 */
	connect(): void {
		if (
			this.socket?.readyState === WebSocket.OPEN ||
			this.socket?.readyState === WebSocket.CONNECTING
		) {
			return;
		}

		this.setConnectionState("connecting");

		try {
			this.socket = new WebSocket(this.getUrl());

			this.socket.onopen = () => {
				this.setConnectionState("connected");
				this.reconnectAttempts = 0;
				this.startKeepAlive();
			};

			this.socket.onclose = () => {
				this.setConnectionState("disconnected");
				this.stopKeepAlive();
				this.handleReconnect();
			};

			this.socket.onerror = () => {
				this.setConnectionState("error");
			};

			this.socket.onmessage = (event) => {
				this.handleMessage(event.data);
			};
		} catch (error) {
			console.error("WebSocket connection error:", error);
			this.setConnectionState("error");
		}
	}

	/**
	 * Disconnect from WebSocket server
	 */
	disconnect(): void {
		this.stopKeepAlive();
		this.socket?.close();
		this.socket = null;
		this.setConnectionState("disconnected");
	}

	/**
	 * Set connection state and notify handlers
	 */
	private setConnectionState(state: ConnectionState): void {
		this.connectionState = state;
		for (const handler of this.connectionHandlers) {
			handler(state);
		}
	}

	/**
	 * Handle reconnection
	 */
	private handleReconnect(): void {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error("Max reconnection attempts reached");
			return;
		}

		this.reconnectAttempts++;
		const delay = this.reconnectDelay * 2 ** (this.reconnectAttempts - 1);

		setTimeout(() => {
			console.log(
				`Reconnecting... attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
			);
			this.connect();
		}, delay);
	}

	/**
	 * Start keep-alive interval
	 */
	private startKeepAlive(): void {
		this.keepAliveInterval = setInterval(() => {
			this.sendLegacy("keepalive", null);
		}, 10000);
	}

	/**
	 * Stop keep-alive interval
	 */
	private stopKeepAlive(): void {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
			this.keepAliveInterval = null;
		}
	}

	/**
	 * Handle incoming message
	 */
	private handleMessage(data: string): void {
		try {
			const parsed = JSON.parse(data);

			// Check if it's an RPC response
			if (parsed.id && (parsed.result !== undefined || parsed.error)) {
				this.handleRPCResponse(parsed as RPCResponse);
				return;
			}

			// Handle as legacy message
			for (const [type, value] of Object.entries(parsed)) {
				if (type === "id") continue;
				for (const handler of this.messageHandlers) {
					handler(type, value);
				}
			}
		} catch (error) {
			console.error("Failed to parse message:", error);
		}
	}

	/**
	 * Handle RPC response
	 */
	private handleRPCResponse(response: RPCResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			console.warn("Received response for unknown request:", response.id);
			return;
		}

		clearTimeout(pending.timeout);
		this.pendingRequests.delete(response.id);

		if (response.error) {
			pending.reject(new Error(response.error.message));
		} else {
			pending.resolve(response.result);
		}
	}

	/**
	 * Call an RPC procedure
	 */
	async call<T>(path: string[], input?: unknown, timeout = 30000): Promise<T> {
		if (this.socket?.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		const id = this.generateId();
		const request: RPCRequest = { id, path, input };

		return new Promise<T>((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request timeout: ${path.join(".")}`));
			}, timeout);

			this.pendingRequests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timeout: timeoutHandle,
			});

			this.socket!.send(JSON.stringify(request));
		});
	}

	/**
	 * Send a legacy-style message
	 */
	sendLegacy(type: string, data: unknown): void {
		if (this.socket?.readyState !== WebSocket.OPEN) {
			console.warn("WebSocket not connected, message not sent:", type);
			return;
		}

		const message = { [type]: data };
		this.socket.send(JSON.stringify(message));
	}

	/**
	 * Add message handler
	 */
	onMessage(handler: MessageHandler): () => void {
		this.messageHandlers.add(handler);
		return () => this.messageHandlers.delete(handler);
	}

	/**
	 * Add connection state handler
	 */
	onConnectionChange(handler: ConnectionHandler): () => void {
		this.connectionHandlers.add(handler);
		return () => this.connectionHandlers.delete(handler);
	}

	/**
	 * Get current connection state
	 */
	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.connectionState === "connected";
	}

	/**
	 * Get raw socket (for backward compatibility)
	 */
	getSocket(): WebSocket | null {
		return this.socket;
	}
}

/**
 * Create a type-safe RPC proxy
 */
function createRPCProxy<T extends object>(
	client: RPCClient,
	path: string[] = [],
): T {
	return new Proxy({} as T, {
		get(_, prop: string) {
			const newPath = [...path, prop];

			// Return a callable function for procedure calls
			return new Proxy(
				async (input?: unknown) => {
					return client.call(newPath, input);
				},
				{
					get(_, nestedProp: string) {
						// Allow nested router access
						return createRPCProxy(client, [...newPath, nestedProp]);
					},
				},
			);
		},
	});
}

// Singleton client instance
export const rpcClient = new RPCClient();

/**
 * Type-safe RPC interface
 * Usage: await rpc.auth.login({ password: "xxx" })
 */
// biome-ignore lint/suspicious/noExplicitAny: Dynamic proxy type
export const rpc: any = createRPCProxy<AppContract>(rpcClient);

/**
 * Initialize the RPC client
 */
export function initRPC(): void {
	rpcClient.connect();
}

/**
 * Export types
 */
export type { ConnectionState, MessageHandler, ConnectionHandler };
