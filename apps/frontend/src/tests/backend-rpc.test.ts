import { afterEach, describe, expect, it, vi } from "vitest";

import {
	BackendRpc,
	type BackendRpcSocket,
} from "../../tests/e2e/fixtures/backend-rpc";

class FakeBackendRpcSocket extends EventTarget implements BackendRpcSocket {
	readyState: number = WebSocket.CONNECTING;
	closed = false;
	respondToLogin = false;
	private readonly activeListeners = new Map<
		string,
		Set<EventListenerOrEventListenerObject>
	>();

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		super.addEventListener(type, listener, options);
		if (listener === null) return;
		const listeners = this.activeListeners.get(type) ?? new Set();
		listeners.add(listener);
		this.activeListeners.set(type, listeners);
	}

	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		super.removeEventListener(type, listener, options);
		if (listener === null) return;
		this.activeListeners.get(type)?.delete(listener);
	}

	listenerCount(type: string): number {
		return this.activeListeners.get(type)?.size ?? 0;
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	send(message: string): void {
		const request: unknown = JSON.parse(message);
		if (typeof request !== "object" || request === null || !("id" in request)) {
			throw new TypeError("RPC request id is required");
		}
		if (!this.respondToLogin) {
			queueMicrotask(() => {
				this.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({
							id: request.id,
							error: { message: "authentication setup rejected" },
						}),
					}),
				);
			});
			return;
		}
		if (!("path" in request) || !Array.isArray(request.path)) return;
		if (request.path.join(".") !== "auth.login") return;
		queueMicrotask(() => {
			this.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						id: request.id,
						result: { success: true },
					}),
				}),
			);
		});
	}

	close(): void {
		this.closed = true;
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	fail(): void {
		this.dispatchEvent(new Event("error"));
	}
}

describe("BackendRpc connection ownership", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("rejects promptly when the socket closes before opening", async () => {
		const socket = new FakeBackendRpcSocket();
		const connection = BackendRpc.connect(3100, {
			createSocket: () => {
				queueMicrotask(() => socket.close());
				return socket;
			},
		});
		const outcome = await Promise.race([
			connection.then(
				() => "resolved",
				(error: Error) => error.message,
			),
			new Promise<string>((resolve) => {
				setTimeout(() => resolve("still pending"), 25);
			}),
		]);

		expect(outcome).toBe("RPC socket closed before open on :3100");
		expect(socket.closed).toBe(true);
		expect(socket.listenerCount("open")).toBe(0);
		expect(socket.listenerCount("error")).toBe(0);
		expect(socket.listenerCount("close")).toBe(0);
	});

	it("bounds a handshake that emits no terminal event", async () => {
		vi.useFakeTimers();
		const socket = new FakeBackendRpcSocket();
		let outcome = "still pending";
		void BackendRpc.connect(3100, {
			createSocket: () => socket,
		}).then(
			() => {
				outcome = "resolved";
			},
			(error: Error) => {
				outcome = error.message;
			},
		);

		await vi.advanceTimersByTimeAsync(10_000);

		expect(outcome).toBe("RPC socket handshake timed out on :3100");
		expect(socket.closed).toBe(true);
		expect(socket.listenerCount("open")).toBe(0);
		expect(socket.listenerCount("error")).toBe(0);
		expect(socket.listenerCount("close")).toBe(0);
	});

	it("clears the handshake timer after opening", async () => {
		vi.useFakeTimers();
		const socket = new FakeBackendRpcSocket();
		socket.respondToLogin = true;
		const connection = BackendRpc.connect(3100, {
			createSocket: () => {
				queueMicrotask(() => socket.open());
				return socket;
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		const client = await connection;

		await vi.advanceTimersByTimeAsync(10_000);

		expect(socket.closed).toBe(false);
		expect(socket.listenerCount("open")).toBe(0);
		client.close();
	});

	it("closes the socket when authentication setup rejects", async () => {
		const socket = new FakeBackendRpcSocket();
		const connection = BackendRpc.connect(3100, {
			createSocket: () => {
				queueMicrotask(() => socket.open());
				return socket;
			},
		});

		await expect(connection).rejects.toThrow("authentication setup rejected");
		expect(socket.closed).toBe(true);
	});

	for (const terminalEvent of ["close", "error"] as const) {
		it(`rejects a pending call immediately on socket ${terminalEvent}`, async () => {
			const socket = new FakeBackendRpcSocket();
			socket.respondToLogin = true;
			const clientPromise = BackendRpc.connect(3100, {
				createSocket: () => {
					queueMicrotask(() => socket.open());
					return socket;
				},
			});
			const client = await clientPromise;
			const pending = client.call(["streaming", "setMockDeviceAttached"], {
				input_id: "usb",
				attached: false,
			});

			if (terminalEvent === "close") socket.close();
			else socket.fail();

			await expect(pending).rejects.toThrow(
				terminalEvent === "close" ? "RPC socket closed" : "RPC socket failed",
			);
			client.close();
		});
	}
});
