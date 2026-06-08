/**
 * ORPC Client for CeraUI Frontend
 *
 * Provides type-safe RPC calls to the backend via WebSocket.
 * Uses the AppContract from @ceraui/rpc for end-to-end type safety.
 */
import type {
	BitrateInput,
	BitrateOutput,
	ClaimCodeOutput,
	CompletePairingInput,
	CompletePairingOutput,
	HotspotConfigInput,
	HotspotToggleInput,
	LoginInput,
	LoginOutput,
	LogoutOutput,
	ModemConfigInput,
	ModemScanInput,
	ModemScanOutput,
	NetifConfigInput,
	NetifConfigOutput,
	RelayValidateInput,
	RelayValidateOutput,
	RemoteConfigInput,
	SetPasswordInput,
	SimUnlockInput,
	SimUnlockOutput,
	StreamingConfigInput,
	StreamingStartOutput,
	StreamingStopOutput,
	SuccessResponse,
	WifiConnectInput,
	WifiDisconnectInput,
	WifiForgetInput,
	WifiNewInput,
	WifiOperationOutput,
	WifiScanInput,
} from "@ceraui/rpc/schemas";

import { ENV_VARIABLES } from "../env";
import { nextBackoffDelay } from "./backoff";
import { parseServerPing, shouldForceCloseHalfOpen } from "./half-open";
import { createHeartbeatTracker, HEARTBEAT_THRESHOLD_MS } from "./heartbeat";

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
type MessageHandler = (type: string, data: unknown, seq?: number) => void;
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
	/** Base reconnect delay (ms) — first retry waits ~this, jittered. */
	private reconnectDelay = 1000;
	/** Hard ceiling (ms ≈ 30s) for the exponential term before jitter. */
	private reconnectCap = 30000;
	private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
	/** Tracks last inbound frame time; drives half-open force-close (Task 14). */
	private heartbeatTracker = createHeartbeatTracker();

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
				this.heartbeatTracker.recordTraffic(Date.now());
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
	 * Handle reconnection.
	 *
	 * The transport retries FOREVER with jittered, capped exponential backoff —
	 * it never permanently gives up, so a device reboot or transient network blip
	 * always self-heals once connectivity returns. The "failed" banner is purely a
	 * UI affordance (connection-ux.svelte.ts) and does NOT halt this loop.
	 */
	private handleReconnect(): void {
		const delay = nextBackoffDelay(
			this.reconnectAttempts,
			this.reconnectDelay,
			this.reconnectCap,
		);
		this.reconnectAttempts++;

		setTimeout(() => {
			console.log(`Reconnecting... attempt ${this.reconnectAttempts}`);
			this.connect();
		}, delay);
	}

	/**
	 * Start keep-alive interval
	 */
	private startKeepAlive(): void {
		this.keepAliveInterval = setInterval(() => {
			if (
				shouldForceCloseHalfOpen(
					this.heartbeatTracker,
					Date.now(),
					this.socket?.readyState,
				)
			) {
				console.warn(
					`Half-open socket: no inbound traffic for >${HEARTBEAT_THRESHOLD_MS}ms, forcing reconnect`,
				);
				this.socket?.close();
				return;
			}
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

			// Any inbound frame proves liveness, refuting half-open (Task 14).
			this.heartbeatTracker.recordTraffic(Date.now());

			// Server→client heartbeat ping: ack with a pong, never echo a ping.
			if (parsed && typeof parsed === "object" && "ping" in parsed) {
				if (parseServerPing((parsed as { ping: unknown }).ping)) {
					this.sendLegacy("pong", true);
					return;
				}
			}

			// Check if it's an RPC response
			if (parsed.id && (parsed.result !== undefined || parsed.error)) {
				this.handleRPCResponse(parsed as RPCResponse);
				return;
			}

			// Handle as legacy message. The broadcast envelope is
			// `{ [type]: data, seq?: N }` — `seq` is transport metadata, not a
			// message type, so it is lifted out and forwarded alongside each
			// type→data pair. Per-type drop-stale lives in the subscription layer
			// (subscriptions.svelte.ts → seq-guard); messages without `seq`
			// forward `undefined` and bypass the guard (backward-additive).
			const seq =
				typeof (parsed as { seq?: unknown }).seq === "number"
					? (parsed as { seq: number }).seq
					: undefined;
			for (const [type, value] of Object.entries(parsed)) {
				if (type === "id" || type === "seq") continue;
				for (const handler of this.messageHandlers) {
					handler(type, value, seq);
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

			this.socket?.send(JSON.stringify(request));
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
 *
 * Creates a proxy that allows both property access (for nested routers)
 * and function calls (for procedures).
 *
 * Example:
 *   rpc.auth.login({ password: "xxx" }) - calls ['auth', 'login'] procedure
 *   rpc.system.reboot() - calls ['system', 'reboot'] procedure
 */
function createRPCProxy<T extends object>(
	client: RPCClient,
	path: string[] = [],
): T {
	// Create a callable function that also supports property access
	const handler: ProxyHandler<(...args: unknown[]) => Promise<unknown>> = {
		// Handle function calls: rpc.auth.login(input)
		apply(_target, _thisArg, args) {
			const input = args[0];
			return client.call(path, input);
		},

		// Handle property access: rpc.auth or rpc.auth.login
		get(_target, prop: string | symbol) {
			if (typeof prop === "symbol") {
				return undefined;
			}

			// Special properties that shouldn't be proxied
			if (prop === "then" || prop === "catch" || prop === "finally") {
				return undefined;
			}

			// Create a nested proxy for the new path
			return createRPCProxy<object>(client, [...path, prop]);
		},
	};

	// Use a function as the proxy target so it can be called
	// biome-ignore lint/complexity/useArrowFunction: needs to be function for proxy apply
	const target = function () {} as unknown as T;
	return new Proxy(target, handler as unknown as ProxyHandler<T>);
}

// Singleton client instance
export const rpcClient = new RPCClient();

/**
 * Type-safe RPC interface definition
 * Maps contract structure to callable async functions
 */
export interface TypedRPC {
	auth: {
		login: (input: LoginInput) => Promise<LoginOutput>;
		setPassword: (input: SetPasswordInput) => Promise<SuccessResponse>;
		logout: () => Promise<LogoutOutput>;
	};
	streaming: {
		start: (input: StreamingConfigInput) => Promise<StreamingStartOutput>;
		stop: () => Promise<StreamingStopOutput>;
		setBitrate: (input: BitrateInput) => Promise<BitrateOutput>;
		getPipelines: () => Promise<unknown>;
		getAudioCodecs: () => Promise<unknown>;
		getConfig: () => Promise<unknown>;
		setConfig: (input: StreamingConfigInput) => Promise<StreamingStopOutput>;
		// Dev-only mock hardware switcher
		setMockHardware: (input: {
			hardware: "jetson" | "n100" | "rk3588" | "generic";
		}) => Promise<{
			success: boolean;
			hardware?: "jetson" | "n100" | "rk3588" | "generic";
			error?: string;
		}>;
		getMockHardware: () => Promise<{
			hardware: "jetson" | "n100" | "rk3588" | "generic" | null;
			effectiveHardware: string;
			availableHardware: ("jetson" | "n100" | "rk3588" | "generic")[];
		}>;
	};
	modems: {
		getAll: () => Promise<unknown>;
		configure: (input: ModemConfigInput) => Promise<SuccessResponse>;
		scan: (input: ModemScanInput) => Promise<ModemScanOutput>;
		unlockSim: (input: SimUnlockInput) => Promise<SimUnlockOutput>;
	};
	wifi: {
		getStatus: () => Promise<unknown>;
		connect: (input: WifiConnectInput) => Promise<WifiOperationOutput>;
		disconnect: (input: WifiDisconnectInput) => Promise<WifiOperationOutput>;
		connectNew: (input: WifiNewInput) => Promise<WifiOperationOutput>;
		forget: (input: WifiForgetInput) => Promise<SuccessResponse>;
		scan: (input: WifiScanInput) => Promise<SuccessResponse>;
		hotspotStart: (input: HotspotToggleInput) => Promise<SuccessResponse>;
		hotspotStop: (input: HotspotToggleInput) => Promise<SuccessResponse>;
		hotspotConfigure: (input: HotspotConfigInput) => Promise<SuccessResponse>;
	};
	network: {
		getInterfaces: () => Promise<unknown>;
		configure: (input: NetifConfigInput) => Promise<NetifConfigOutput>;
	};
	system: {
		getRevisions: () => Promise<unknown>;
		getSensors: () => Promise<unknown>;
		getLog: () => Promise<unknown>;
		getSyslog: () => Promise<unknown>;
		poweroff: () => Promise<SuccessResponse>;
		reboot: () => Promise<SuccessResponse>;
		startUpdate: () => Promise<SuccessResponse>;
		sshStart: () => Promise<SuccessResponse>;
		sshStop: () => Promise<SuccessResponse>;
		sshResetPassword: () => Promise<{ success: boolean; password?: string }>;
		getCloudProviders: () => Promise<unknown>;
		setRemoteConfig: (input: RemoteConfigInput) => Promise<SuccessResponse>;
		setAutostart: (input: { autostart: boolean }) => Promise<SuccessResponse>;
	};
	status: {
		getStatus: () => Promise<unknown>;
		getRelays: () => Promise<unknown>;
	};
	relay: {
		validate: (input: RelayValidateInput) => Promise<RelayValidateOutput>;
	};
	notifications: {
		getPersistent: () => Promise<unknown>;
		dismiss: (input: { name: string }) => Promise<SuccessResponse>;
	};
	pairing: {
		generateClaimCode: () => Promise<ClaimCodeOutput>;
		completePairing: (
			input: CompletePairingInput,
		) => Promise<CompletePairingOutput>;
	};
	// Dev-only: registered on the backend ONLY when NODE_ENV !== "production".
	// Absent in production builds — guard usage with the optional chain.
	dev?: {
		emit: (input: {
			type: string;
			payload: unknown;
		}) => Promise<{ success: boolean }>;
	};
}

/**
 * Type-safe RPC interface
 * Usage: await rpc.auth.login({ password: "xxx" })
 */
export const rpc: TypedRPC = createRPCProxy<TypedRPC>(rpcClient);

/**
 * Initialize the RPC client
 */
export function initRPC(): void {
	rpcClient.connect();
}

/**
 * Export types
 */
export type { ConnectionHandler, ConnectionState, MessageHandler };
