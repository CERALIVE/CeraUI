/**
 * Task 7 — reconnect re-authentication + safety hydrate.
 *
 * Exercises the pure {@link reauthenticateAndHydrate} handler with fully mocked
 * dependencies (no rpc client, no runes, no Svelte) so it runs under the plain
 * (node) vitest environment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type ReauthDeps, reauthenticateAndHydrate } from "./reconnect";

function makeDeps(overrides: Partial<ReauthDeps> = {}): {
	deps: ReauthDeps;
	dispatched: Array<[string, unknown]>;
} {
	const dispatched: Array<[string, unknown]> = [];
	const deps: ReauthDeps = {
		getStoredToken: vi.fn(() => "stored-secret"),
		clearStoredToken: vi.fn(),
		login: vi.fn(async () => ({ success: true })),
		getConfig: vi.fn(async () => ({ max_br: 6000 })),
		getStatus: vi.fn(async () => ({ is_streaming: true })),
		dispatch: vi.fn((type: string, data: unknown) => {
			dispatched.push([type, data]);
		}),
		routeToLogin: vi.fn(),
		onError: vi.fn(),
		...overrides,
	};
	return { deps, dispatched };
}

describe("reauthenticateAndHydrate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does nothing when no credential is stored", async () => {
		const { deps } = makeDeps({ getStoredToken: vi.fn(() => null) });

		const outcome = await reauthenticateAndHydrate(deps);

		expect(outcome).toBe("no-token");
		expect(deps.login).not.toHaveBeenCalled();
		expect(deps.getConfig).not.toHaveBeenCalled();
		expect(deps.getStatus).not.toHaveBeenCalled();
		expect(deps.routeToLogin).not.toHaveBeenCalled();
	});

	it("token present → re-auths then safety hydrates via the dispatch path", async () => {
		const { deps, dispatched } = makeDeps();

		const outcome = await reauthenticateAndHydrate(deps);

		expect(outcome).toBe("hydrated");
		expect(deps.login).toHaveBeenCalledExactlyOnceWith("stored-secret");
		expect(deps.getConfig).toHaveBeenCalledOnce();
		expect(deps.getStatus).toHaveBeenCalledOnce();
		expect(deps.routeToLogin).not.toHaveBeenCalled();
		expect(deps.clearStoredToken).not.toHaveBeenCalled();

		// Auth result + both hydrate payloads routed through handleMessage.
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["config", { max_br: 6000 }],
			["status", { is_streaming: true }],
		]);
	});

	it("invalid token → clears credential and routes to login (no hydrate)", async () => {
		const { deps, dispatched } = makeDeps({
			login: vi.fn(async () => ({ success: false })),
		});

		const outcome = await reauthenticateAndHydrate(deps);

		expect(outcome).toBe("expired");
		expect(deps.clearStoredToken).toHaveBeenCalledOnce();
		expect(deps.routeToLogin).toHaveBeenCalledOnce();
		expect(deps.getConfig).not.toHaveBeenCalled();
		expect(deps.getStatus).not.toHaveBeenCalled();
		expect(dispatched).toEqual([["auth", { success: false }]]);
	});

	it("invalid token does not loop: a second reconnect short-circuits at no-token", async () => {
		// Model the live wiring: clearing the credential mutates what the next
		// getStoredToken() read returns, so the follow-up reconnect is inert.
		let stored: string | null = "stale-secret";
		const login = vi.fn(async () => ({ success: false }));
		const deps = makeDeps({
			getStoredToken: vi.fn(() => stored),
			clearStoredToken: vi.fn(() => {
				stored = null;
			}),
			login,
		}).deps;

		const first = await reauthenticateAndHydrate(deps);
		const second = await reauthenticateAndHydrate(deps);

		expect(first).toBe("expired");
		expect(second).toBe("no-token");
		// login attempted exactly once across both reconnects — no auth loop.
		expect(login).toHaveBeenCalledOnce();
		expect(deps.routeToLogin).toHaveBeenCalledOnce();
	});

	it("a transport error during re-auth preserves the credential for retry", async () => {
		const { deps, dispatched } = makeDeps({
			login: vi.fn(async () => {
				throw new Error("WebSocket not connected");
			}),
		});

		const outcome = await reauthenticateAndHydrate(deps);

		expect(outcome).toBe("unreachable");
		expect(deps.onError).toHaveBeenCalledOnce();
		expect(deps.clearStoredToken).not.toHaveBeenCalled();
		expect(deps.routeToLogin).not.toHaveBeenCalled();
		expect(deps.getConfig).not.toHaveBeenCalled();
		expect(dispatched).toEqual([]);
	});

	it("keeps the authed session when the safety hydrate fails", async () => {
		const { deps, dispatched } = makeDeps({
			getConfig: vi.fn(async () => {
				throw new Error("getConfig timeout");
			}),
		});

		const outcome = await reauthenticateAndHydrate(deps);

		// Re-auth succeeded; a hydrate failure is non-fatal (backend push still feeds the stores).
		expect(outcome).toBe("hydrated");
		expect(deps.routeToLogin).not.toHaveBeenCalled();
		expect(deps.clearStoredToken).not.toHaveBeenCalled();
		expect(deps.onError).toHaveBeenCalledOnce();
		// The status answer was received on the authenticated link; a failed
		// config read does not withhold it (FIX-16-F5, F4-R1).
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["status", { is_streaming: true }],
		]);
	});
});

/** A reply the test answers when it chooses. */
function reply<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let every queued continuation run (no timers involved). */
async function drain(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("each hydrate answer is consumed at its own receipt (FIX-16-F5)", () => {
	it("dispatches the status answer while the config reply is still awaited", async () => {
		const config = reply<unknown>();
		const status = reply<unknown>();
		const { deps, dispatched } = makeDeps({
			getConfig: vi.fn(() => config.promise),
			getStatus: vi.fn(() => status.promise),
		});
		let outcome: string | undefined;
		const run = reauthenticateAndHydrate(deps).then((o) => {
			outcome = o;
		});

		await drain();
		status.resolve({ stream_lifecycle: "idle" });
		await drain();
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["status", { stream_lifecycle: "idle" }],
		]);
		expect(outcome).toBeUndefined();

		config.resolve({ max_br: 6000 });
		await run;
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["status", { stream_lifecycle: "idle" }],
			["config", { max_br: 6000 }],
		]);
		expect(outcome).toBe("hydrated");
	});

	it("dispatches the config answer while the status reply is still awaited", async () => {
		const status = reply<unknown>();
		const { deps, dispatched } = makeDeps({
			getStatus: vi.fn(() => status.promise),
		});
		const run = reauthenticateAndHydrate(deps);

		await drain();
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["config", { max_br: 6000 }],
		]);

		status.resolve({ stream_lifecycle: "stopping" });
		expect(await run).toBe("hydrated");
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["config", { max_br: 6000 }],
			["status", { stream_lifecycle: "stopping" }],
		]);
	});

	it("a failed status read dispatches no status, reports once and keeps the session", async () => {
		const status = reply<unknown>();
		const { deps, dispatched } = makeDeps({
			getStatus: vi.fn(() => status.promise),
		});
		const run = reauthenticateAndHydrate(deps);
		await drain();
		status.reject(new Error("ConnectionResetError"));

		expect(await run).toBe("hydrated");
		expect(dispatched).toEqual([
			["auth", { success: true }],
			["config", { max_br: 6000 }],
		]);
		expect(deps.onError).toHaveBeenCalledOnce();
		expect(deps.routeToLogin).not.toHaveBeenCalled();
		expect(deps.clearStoredToken).not.toHaveBeenCalled();
	});
});
