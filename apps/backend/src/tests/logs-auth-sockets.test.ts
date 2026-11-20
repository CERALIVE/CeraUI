import { expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import * as config from "../modules/config.ts";
import { createContext, socketSessionSignal } from "../rpc/context.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { appRouter } from "../rpc/router.ts";
import { getPasswordHash, setPasswordHash } from "../rpc/state/password.ts";
import { authTokenDirectory } from "./helpers/auth-token-directory.ts";
import { bounded } from "./helpers/history-clear.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

test.each(["logout", "revoke own", "revoke all", "change password"] as const)(
	"%s closes revoked peer sockets and leaves the caller transport open",
	async (operation) => {
		using _tokens = authTokenDirectory();
		const priorPassword = getPasswordHash();
		const sockets = await logsSockets();
		const { context } = sockets;
		const same = await sockets.connectPeer();
		const other = await sockets.connectPeer();
		const ownToken = crypto.randomUUID();
		const otherToken = crypto.randomUUID();
		context.authenticate(ownToken);
		createContext(same.ws).authenticate(ownToken);
		createContext(other.ws).authenticate(otherToken);
		addClient(same.ws);
		addClient(other.ws);
		const callerSession = socketSessionSignal(sockets.ws);
		const sameClosed = Promise.withResolvers<CloseEvent>();
		const otherClosed = Promise.withResolvers<CloseEvent>();
		same.peer.addEventListener("close", sameClosed.resolve, { once: true });
		other.peer.addEventListener("close", otherClosed.resolve, { once: true });
		const password = "fixture-replacement-password";
		try {
			const auth = appRouter.auth;
			const result = await (async () => {
				switch (operation) {
					case "logout":
						return call(auth.logout, undefined, { context });
					case "revoke own":
						return call(auth.revokeToken, { scope: "token" }, { context });
					case "revoke all":
						return call(auth.revokeToken, { scope: "all" }, { context });
					case "change password": {
						const read = spyOn(config, "getConfig").mockReturnValue({});
						const save = spyOn(config, "saveConfig").mockImplementation(
							() => {},
						);
						try {
							return await call(auth.setPassword, { password }, { context });
						} finally {
							save.mockRestore();
							read.mockRestore();
						}
					}
				}
			})();
			expect(result.success).toBe(true);
			expect((await bounded(sameClosed.promise)).code).toBe(1008);
			expect(createContext(same.ws).isAuthenticated()).toBe(false);
			if (operation === "revoke all" || operation === "change password") {
				expect((await bounded(otherClosed.promise)).code).toBe(1008);
				expect(createContext(other.ws).isAuthenticated()).toBe(false);
			} else {
				expect(other.peer.readyState).toBe(WebSocket.OPEN);
				expect(createContext(other.ws).isAuthenticated()).toBe(true);
			}
			expect(sockets.client.readyState).toBe(WebSocket.OPEN);
			expect(callerSession.aborted).toBe(true);
			expect(context.isAuthenticated()).toBe(operation === "change password");
			if (operation === "change password") {
				const replacement = sockets.ws.data.authToken;
				if (!replacement) throw new Error("missing replacement token");
				expect(replacement).not.toBe(ownToken);
				expect(socketSessionSignal(sockets.ws).aborted).toBe(false);
				expect(
					await call(
						auth.login,
						{
							token: replacement,
							persistent_token: false,
						},
						{ context: sockets.guestContext },
					),
				).toEqual({ success: true });
				await call(auth.logout, undefined, { context: sockets.guestContext });
			}
		} finally {
			removeClient(same.ws);
			removeClient(other.ws);
			sockets.close();
			setPasswordHash(priorPassword);
		}
	},
);
