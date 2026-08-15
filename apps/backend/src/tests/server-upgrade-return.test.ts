import { describe, expect, test } from "bun:test";

import type { ServerSocketData } from "../rpc/types.ts";

/**
 * `rpc/server.ts` answers a successful `server.upgrade()` by returning nothing —
 * Bun then writes the 101 itself. That return used to be laundered through
 * `undefined as unknown as Response`, which asserted a Response that never
 * existed. This pins the shape it really is: a fetch handler that returns
 * `undefined` on upgrade and a real `Response` otherwise still serves both.
 */
describe("the websocket upgrade return needs no Response assertion", () => {
	test("returning undefined upgrades; returning a Response still answers HTTP", async () => {
		const server = Bun.serve<ServerSocketData>({
			port: 0,
			fetch(req, srv) {
				if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
					const upgraded = srv.upgrade(req, {
						data: { isAuthenticated: false, lastActive: Date.now() },
					});
					if (upgraded) return undefined;
					return new Response("upgrade failed", { status: 500 });
				}
				return new Response("http", { status: 200 });
			},
			websocket: {
				open(ws) {
					ws.send("open");
				},
				message() {},
			},
		});

		try {
			const http = await fetch(`http://localhost:${server.port}/`);
			expect(http.status).toBe(200);
			expect(await http.text()).toBe("http");

			const opened = await new Promise<string>((resolve, reject) => {
				const ws = new WebSocket(`ws://localhost:${server.port}/`);
				ws.onmessage = (event) => {
					ws.close();
					resolve(String(event.data));
				};
				ws.onerror = () => reject(new Error("socket errored"));
			});
			expect(opened).toBe("open");
		} finally {
			server.stop(true);
		}
	});
});
