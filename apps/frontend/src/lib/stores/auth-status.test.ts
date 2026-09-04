/**
 * auth-status.svelte.ts — single-auth-mutation-path contract (Todo 9).
 *
 * The old flow had TWO writers for the auth message: the deprecated WS store's
 * `AuthStore._set` (fired both by the RPC path AND by the module-level onMessage
 * handler on any "auth" push) plus auth-status's own state. Layout/Auth reading
 * either was subject to a race depending on load order. This module is now the
 * single owner: `ingestAuth(message)` is the ONE writer, `getAuthMessage()` is
 * the reader, and `authenticate`/`createPassword` are the typed `rpc.auth.*`
 * dispatchers that route through `ingestAuth`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";

const login = vi.fn();
const setPassword = vi.fn();

let seedConnectionState: ConnectionState = "connected";
let onConnectionChangeHandler: ((state: ConnectionState) => void) | undefined;

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		auth: {
			login: (input: unknown) => login(input),
			setPassword: (input: unknown) => setPassword(input),
		},
	},
	rpcClient: {
		isConnected: () => seedConnectionState === "connected",
		onConnectionChange: (handler: (state: ConnectionState) => void) => {
			onConnectionChangeHandler = handler;
			return () => {
				onConnectionChangeHandler = undefined;
			};
		},
	},
}));

type AuthStatusModule = typeof import("./auth-status.svelte");

async function loadAuthStatus(): Promise<AuthStatusModule> {
	vi.resetModules();
	return await import("./auth-status.svelte");
}

beforeEach(() => {
	vi.useRealTimers();
	seedConnectionState = "connected";
	onConnectionChangeHandler = undefined;
	login.mockReset();
	setPassword.mockReset();
	localStorage.clear();
});

describe("auth-status — single mutation path", () => {
	it("reads back the last ingested LoginOutput via getAuthMessage()", async () => {
		const mod = await loadAuthStatus();
		expect(mod.getAuthMessage()).toBeUndefined();

		mod.ingestAuth({ success: true, auth_token: "abc" });
		expect(mod.getAuthMessage()).toEqual({
			success: true,
			auth_token: "abc",
		});

		mod.ingestAuth({ success: false });
		expect(mod.getAuthMessage()).toEqual({ success: false });
	});

	it("authenticate() drives ingestAuth exactly once on a successful login", async () => {
		const mod = await loadAuthStatus();
		login.mockResolvedValueOnce({ success: true, auth_token: "abc" });

		const attempt = await mod.authenticate("hunter2", true);

		expect(attempt).toEqual({ kind: "ok" });
		expect(login).toHaveBeenCalledTimes(1);
		expect(login).toHaveBeenCalledWith({
			password: "hunter2",
			persistent_token: true,
		});
		expect(mod.getAuthMessage()).toEqual({
			success: true,
			auth_token: "abc",
		});
	});

	it("authenticate() ingests {success:false} on a rejected login (no throw)", async () => {
		const mod = await loadAuthStatus();
		login.mockResolvedValueOnce({ success: false });

		localStorage.setItem("auth", "stale-password");
		const attempt = await mod.authenticate("wrong", false);

		expect(attempt).toEqual({ kind: "rejected" });
		expect(login).toHaveBeenCalledWith({
			password: "wrong",
			persistent_token: false,
		});
		expect(mod.getAuthMessage()).toEqual({ success: false });
	});

	it("returns unreachable/rpc-error without ingesting an auth rejection", async () => {
		const mod = await loadAuthStatus();
		login.mockRejectedValueOnce(new Error("boom"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const attempt = await mod.authenticate("hunter2", true);

		expect(attempt).toEqual({ kind: "unreachable", cause: "rpc-error" });
		expect(mod.getAuthMessage()).toBeUndefined();
		errorSpy.mockRestore();
	});

	it("returns unreachable/socket-not-ready after the bounded connection wait without ingesting a rejection", async () => {
		vi.useFakeTimers();
		seedConnectionState = "connecting";
		const mod = await loadAuthStatus();

		const inflight = mod.authenticate("hunter2", true);
		await vi.advanceTimersByTimeAsync(10_000);
		const attempt = await inflight;

		expect(attempt).toEqual({
			kind: "unreachable",
			cause: "socket-not-ready",
		});
		expect(login).not.toHaveBeenCalled();
		expect(mod.getAuthMessage()).toBeUndefined();
	});

	it("returns unreachable/timeout without ingesting an auth rejection", async () => {
		const mod = await loadAuthStatus();
		login.mockRejectedValueOnce(new Error("Request timeout: auth.login"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const attempt = await mod.authenticate("hunter2", true);

		expect(attempt).toEqual({ kind: "unreachable", cause: "timeout" });
		expect(mod.getAuthMessage()).toBeUndefined();
		errorSpy.mockRestore();
	});

	it("persists before successful auth flips the store", async () => {
		const mod = await loadAuthStatus();
		login.mockResolvedValueOnce({ success: true, auth_token: "abc" });
		const sequence: string[] = [];
		const setItem = vi
			.spyOn(localStorage, "setItem")
			.mockImplementation((key, value) => {
				sequence.push(`persist:${key}:${value}`);
			});
		const unsubscribe = mod.authStatusStore.subscribe((status) => {
			if (status) sequence.push("store:true");
		});

		await mod.authenticate("hunter2", true);

		expect(sequence).toEqual(["persist:auth:hunter2", "store:true"]);
		unsubscribe();
		setItem.mockRestore();
	});

	it("clears a stale saved credential when remember-me is unchecked", async () => {
		const mod = await loadAuthStatus();
		localStorage.setItem("auth", "stale-password");
		login.mockResolvedValueOnce({ success: true, auth_token: "abc" });
		const removeItem = vi.spyOn(localStorage, "removeItem");

		const attempt = await mod.authenticate("fresh-password", false);

		expect(attempt).toEqual({ kind: "ok" });
		expect(removeItem).toHaveBeenCalledExactlyOnceWith("auth");
		expect(localStorage.getItem("auth")).toBeNull();
		removeItem.mockRestore();
	});

	it("authenticate() waits for a not-yet-open socket, then dispatches", async () => {
		seedConnectionState = "connecting";
		const mod = await loadAuthStatus();
		login.mockResolvedValueOnce({ success: true, auth_token: "xyz" });

		const inflight = mod.authenticate("hunter2", true);
		expect(login).not.toHaveBeenCalled();

		onConnectionChangeHandler?.("connected");
		const attempt = await inflight;

		expect(attempt).toEqual({ kind: "ok" });
		expect(login).toHaveBeenCalledTimes(1);
		expect(mod.getAuthMessage()).toEqual({
			success: true,
			auth_token: "xyz",
		});
	});

	it("createPassword() dispatches rpc.auth.setPassword and stays out of authMessage", async () => {
		const mod = await loadAuthStatus();
		setPassword.mockResolvedValueOnce({ success: true });

		await mod.createPassword("brand-new");

		expect(setPassword).toHaveBeenCalledWith({ password: "brand-new" });
		// createPassword MUST NOT touch authMessage — that state belongs to the
		// login result exclusively (single mutation path invariant).
		expect(mod.getAuthMessage()).toBeUndefined();
	});

	it("createPassword() keeps password-change persistence inside the auth owner", async () => {
		const mod = await loadAuthStatus();
		setPassword.mockResolvedValueOnce({ success: true });

		await mod.createPassword("brand-new", true);

		expect(localStorage.getItem("auth")).toBe("brand-new");
	});

	it("authStatusStore boolean is not written by ingestAuth (orthogonal axes)", async () => {
		const mod = await loadAuthStatus();
		expect(mod.authStatusStore.value).toBe(false);

		mod.ingestAuth({ success: true, auth_token: "abc" });
		expect(mod.authStatusStore.value).toBe(false);

		mod.authStatusStore.set(true);
		expect(mod.authStatusStore.value).toBe(true);
		expect(mod.getAuthMessage()).toEqual({
			success: true,
			auth_token: "abc",
		});
	});
});
