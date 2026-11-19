import { createContext } from "../../rpc/context.ts";
import type { AppWebSocket, SocketData } from "../../rpc/types.ts";

/** Real Bun sockets keep RPC context and follow ownership on the same object. */
export async function logsSockets() {
	const waiting: Array<(ws: AppWebSocket) => void> = [];
	const peers: WebSocket[] = [];
	const server = Bun.serve<SocketData>({
		port: 0,
		fetch(request, srv) {
			return srv.upgrade(request, {
				data: {
					isAuthenticated: new URL(request.url).pathname === "/authed",
					lastActive: 0,
					senderId: "logs-viewer",
				},
			})
				? undefined
				: new Response(null, { status: 400 });
		},
		websocket: {
			open(ws) {
				waiting.shift()?.(ws);
			},
			message: () => undefined,
		},
	});
	async function connectPeer(authed = true) {
		const opened = Promise.withResolvers<AppWebSocket>();
		waiting.push(opened.resolve);
		const peer = new WebSocket(
			`ws://127.0.0.1:${server.port}/${authed ? "authed" : "guest"}`,
		);
		peer.addEventListener("error", opened.reject, { once: true });
		peers.push(peer);
		return { ws: await opened.promise, peer };
	}
	async function connect(authed = true): Promise<AppWebSocket> {
		return (await connectPeer(authed)).ws;
	}
	const { ws, peer: client } = await connectPeer();
	const guest = await connect(false);
	return {
		ws,
		client,
		context: createContext(ws),
		guestContext: createContext(guest),
		connect,
		connectPeer,
		close() {
			for (const peer of peers) peer.close();
			server.stop(true);
		},
	};
}
