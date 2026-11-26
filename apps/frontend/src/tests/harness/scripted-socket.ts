/**
 * A tab on a scripted socket: the REAL client, session and subscription code,
 * with every request recorded and every answer or push made by the test. The
 * test file mocks `$lib/env`'s `getRpcSocketUrl` and stubs `WebSocket`.
 */
import { expect, vi } from "vitest";

type Request = {
	readonly id: string;
	readonly path: string[];
	readonly input?: unknown;
};

export class ScriptedSocket {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	static readonly CLOSED = 3;
	static instances: ScriptedSocket[] = [];
	readyState = ScriptedSocket.CONNECTING;
	onopen?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: string }) => void;
	readonly sent: Request[] = [];

	constructor() {
		ScriptedSocket.instances.push(this);
	}

	open() {
		this.readyState = ScriptedSocket.OPEN;
		this.onopen?.();
	}

	close() {
		this.readyState = ScriptedSocket.CLOSED;
		this.onclose?.();
	}

	send(data: string) {
		const request: Request = JSON.parse(data);
		if (request.path) this.sent.push(request);
	}

	request(path: string): Request {
		const request = this.sent.findLast((item) => item.path.join(".") === path);
		if (!request) throw new Error(`No ${path} request on this socket`);
		return request;
	}

	reply(path: string, result: unknown) {
		this.onmessage?.({
			data: JSON.stringify({ id: this.request(path).id, result }),
		});
	}

	push(message: object) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
}

export const TOKEN = "issued-session-token";
export const RESTORE = { token: TOKEN, persistent_token: true };

function openLatest() {
	const socket = ScriptedSocket.instances.at(-1);
	if (!socket) throw new Error("No pending WebSocket");
	socket.open();
	return socket;
}

export async function flushReplies() {
	await vi.advanceTimersByTimeAsync(0);
}

async function tabModules() {
	return {
		subscriptions: await import("$lib/rpc/subscriptions.svelte"),
		session: await import("$lib/rpc/session-epoch.svelte"),
		auth: await import("$lib/stores/auth-status.svelte"),
		client: await import("$lib/rpc/client"),
	};
}

/**
 * `beforeAll(compileTab, COMPILE_MS)`: a cold compile of the tab's modules must
 * not be paid out of the first test's time budget.
 */
export const COMPILE_MS = 120_000;
export async function compileTab(): Promise<void> {
	await tabModules();
}

export async function start() {
	const {
		subscriptions,
		session,
		auth,
		client: { rpcClient },
	} = await tabModules();
	subscriptions.initSubscriptions();
	const first = openLatest();
	const replace = (old: ScriptedSocket) => {
		old.close();
		rpcClient.connect();
		return openLatest();
	};
	const setupPassword = async (success: boolean) => {
		first.push({ status: { set_password: true } });
		const pending = auth.createPassword("disposable-password");
		await flushReplies();
		first.reply("auth.setPassword", { success });
		expect(await pending).toBe(success);
	};
	const signIn = async (remember = true) => {
		const pending = auth.authenticate("disposable-password", remember);
		await flushReplies();
		first.reply("auth.login", { success: true, auth_token: TOKEN });
		expect(await pending).toEqual({ kind: "ok" });
	};
	return {
		auth,
		first,
		replace,
		session,
		setupPassword,
		signIn,
		subscriptions,
	};
}

export function resetTab() {
	vi.resetModules();
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", ScriptedSocket);
	ScriptedSocket.instances = [];
	localStorage.clear();
}
