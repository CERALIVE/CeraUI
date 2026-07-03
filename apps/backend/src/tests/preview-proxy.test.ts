/*
 * Task 20 — backend `/preview` WebSocket proxy.
 *
 * Proves the single-origin proxy pipes frames from a (fake) engine loopback
 * socket to the browser after validating+consuming a single-use token on open,
 * and closes with the pinned codes on every failure: 4401 (invalid/reused token),
 * 4502 (upstream unreachable), 4503 (preview unavailable). The upgrade ALWAYS
 * succeeds on a pathname match; auth is enforced AFTER the upgrade.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	PREVIEW_CLOSE_UNAUTHORIZED,
	PREVIEW_CLOSE_UPSTREAM_DOWN,
	PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import type { Server } from "bun";

import {
	createPreviewWebSocketHandler,
	defaultPreviewProxyDeps,
	type PreviewProxyDeps,
} from "../modules/ui/preview-proxy.ts";
import {
	consumePreviewToken,
	mintPreviewToken,
	resetPreviewTokens,
} from "../modules/ui/preview-token.ts";
import { mintPreviewTokenProcedure } from "../rpc/procedures/system.procedure.ts";
import type { PreviewSocketData, RPCContext } from "../rpc/types.ts";

const teardown: Array<() => void> = [];

afterEach(() => {
	for (const stop of teardown.splice(0)) {
		stop();
	}
	resetPreviewTokens();
});

function track<T extends Server>(server: T): T {
	teardown.push(() => server.stop(true));
	return server;
}

/** A fake engine preview upstream: on the forwarded `start`, replies with a
 *  codec-config text frame then one binary access unit. */
function startFakeUpstream(): string {
	const server = track(
		Bun.serve({
			port: 0,
			fetch(req, s) {
				if (s.upgrade(req)) {
					return undefined as unknown as Response;
				}
				return new Response("no", { status: 400 });
			},
			websocket: {
				message(ws, msg) {
					if (typeof msg === "string") {
						ws.send(JSON.stringify({ type: "codec-config", from: "upstream" }));
						ws.send(new Uint8Array([1, 2, 3, 4]).buffer);
					}
				},
			},
		}),
	);
	return `ws://127.0.0.1:${server.port}`;
}

function startProxy(deps: PreviewProxyDeps): number {
	const handler = createPreviewWebSocketHandler(deps);
	const server = track(
		Bun.serve<PreviewSocketData>({
			port: 0,
			fetch(req, s) {
				const url = new URL(req.url);
				if (url.pathname === "/preview") {
					const token = url.searchParams.get("token") ?? "";
					if (s.upgrade(req, { data: { kind: "preview", token } })) {
						return undefined as unknown as Response;
					}
					return new Response("upgrade failed", { status: 500 });
				}
				return new Response("not found", { status: 404 });
			},
			websocket: handler,
		}),
	);
	return server.port;
}

/** A definitely-closed loopback port (bind then release). */
function deadPort(): number {
	const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
	const port = s.port;
	s.stop(true);
	return port;
}

interface DialedSocket {
	ws: WebSocket;
	texts: Record<string, unknown>[];
	binaries: ArrayBuffer[];
	closed: Promise<number>;
}

function dial(port: number, token: string): DialedSocket {
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/preview?token=${encodeURIComponent(token)}`,
	);
	ws.binaryType = "arraybuffer";
	const texts: Record<string, unknown>[] = [];
	const binaries: ArrayBuffer[] = [];
	ws.onopen = () =>
		ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
	ws.onmessage = (event) => {
		if (typeof event.data === "string") {
			texts.push(JSON.parse(event.data));
		} else if (event.data instanceof ArrayBuffer) {
			binaries.push(event.data);
		}
	};
	const closed = new Promise<number>((resolve) => {
		ws.onclose = (event) => resolve(event.code);
	});
	return { ws, texts, binaries, closed };
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 15));
	}
}

function fakeContext(authenticated: boolean): RPCContext {
	return {
		ws: {} as RPCContext["ws"],
		isAuthenticated: () => authenticated,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

describe("preview proxy — happy path", () => {
	it("pipes upstream frames after a valid single-use token", async () => {
		resetPreviewTokens();
		const upstream = startFakeUpstream();
		const port = startProxy({
			consumeToken: consumePreviewToken,
			resolveUpstreamUrl: () => upstream,
		});
		const { token } = mintPreviewToken();
		const c = dial(port, token);

		await waitFor(
			() =>
				c.texts.some((t) => t.type === "codec-config") &&
				c.binaries.length >= 1,
		);
		expect(c.texts[0]?.from).toBe("upstream");
		expect(c.binaries[0]?.byteLength).toBe(4);
		c.ws.close();
	});
});

describe("preview proxy — 4401 unauthorized", () => {
	it("closes 4401 when the token was already consumed (reuse)", async () => {
		resetPreviewTokens();
		const upstream = startFakeUpstream();
		const port = startProxy({
			consumeToken: consumePreviewToken,
			resolveUpstreamUrl: () => upstream,
		});
		const { token } = mintPreviewToken();

		const first = dial(port, token);
		await waitFor(() => first.texts.length + first.binaries.length >= 1);
		first.ws.close();

		// The token is spent — a second dial upgrades then closes 4401.
		const second = dial(port, token);
		expect(await second.closed).toBe(PREVIEW_CLOSE_UNAUTHORIZED);
	});

	it("closes 4401 for a missing/invalid token", async () => {
		const port = startProxy({
			consumeToken: () => false,
			resolveUpstreamUrl: () => "ws://127.0.0.1:1",
		});
		const c = dial(port, "");
		expect(await c.closed).toBe(PREVIEW_CLOSE_UNAUTHORIZED);
	});
});

describe("preview proxy — upstream failure codes", () => {
	it("closes 4502 when the engine loopback socket is unreachable", async () => {
		resetPreviewTokens();
		const port = startProxy({
			consumeToken: consumePreviewToken,
			resolveUpstreamUrl: () => `ws://127.0.0.1:${deadPort()}`,
		});
		const { token } = mintPreviewToken();
		const c = dial(port, token);
		expect(await c.closed).toBe(PREVIEW_CLOSE_UPSTREAM_DOWN);
	});

	it("closes 4503 when preview is unavailable (resolver returns null)", async () => {
		resetPreviewTokens();
		const port = startProxy({
			consumeToken: consumePreviewToken,
			resolveUpstreamUrl: () => null,
		});
		const { token } = mintPreviewToken();
		const c = dial(port, token);
		expect(await c.closed).toBe(PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE);
	});

	it("default resolver reports unavailable with no engine snapshot and no mocks", () => {
		// bound=false / absent preview snapshot both resolve to null → 4503.
		expect(defaultPreviewProxyDeps().resolveUpstreamUrl()).toBeNull();
	});
});

describe("system.mintPreviewToken — authed only", () => {
	it("rejects an unauthenticated RPC context", async () => {
		await expect(
			call(mintPreviewTokenProcedure, undefined, {
				context: fakeContext(false),
			}),
		).rejects.toThrow();
	});

	it("mints a token for an authenticated RPC context", async () => {
		const out = await call(mintPreviewTokenProcedure, undefined, {
			context: fakeContext(true),
		});
		expect(typeof out.token).toBe("string");
		expect(out.token.length).toBeGreaterThan(0);
		expect(out.ttlMs).toBeGreaterThan(0);
		// The minted token is live and single-use in the shared store.
		expect(consumePreviewToken(out.token)).toBe(true);
		expect(consumePreviewToken(out.token)).toBe(false);
	});
});
