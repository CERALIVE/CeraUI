/**
 * A device served over a real socket: the backend's shipped entrypoint in a
 * child process, carrying the build identity an install stamped (none for
 * `undefined`). A page reaches it with its own client; an operator's other page
 * is `operator`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PASSWORD = "correct-password";
const CHILD = resolve("../backend/src/tests/helpers/ui-build-server.ts");

export interface ServedDevice {
	readonly port: number;
	stop(): Promise<void>;
}

/** `beforeAll(async () => { device = await serveDevice(...); }, SERVE_MS)`. */
export const SERVE_MS = 180_000;
export async function serveDevice(
	build: string | undefined,
	config: Record<string, unknown>,
): Promise<ServedDevice> {
	const cwd = mkdtempSync(join(tmpdir(), "served-device-"));
	const { CERAUI_BUILD_ID: _inherited, ...inherited } = process.env;
	const child: ChildProcess = spawn("bun", [CHILD], {
		cwd,
		env: {
			...inherited,
			NODE_ENV: "development",
			TEST_CONFIG: JSON.stringify(config),
			...(build === undefined ? {} : { TEST_BUILD_STAMP: build }),
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	const port = await new Promise<number>((ready, fail) => {
		child.once("message", (message) =>
			ready((message as { port: number }).port),
		);
		child.once("exit", (code) =>
			fail(new Error(`device exited ${code} before it was ready`)),
		);
	});
	return {
		port,
		stop: async () => {
			child.kill("SIGKILL");
			await exited;
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/** The URL a page asked for, on `device` instead of the page's own origin. */
export function servedUrl(device: ServedDevice, asked: string | URL): string {
	const { search } = new URL(asked, "ws://page.invalid");
	return `ws://127.0.0.1:${device.port}/ws${search}`;
}

/** Another page of the same operator, on the device's own build. */
export async function operator(
	device: ServedDevice,
	build: string,
	Socket: typeof WebSocket,
) {
	const socket = new Socket(
		servedUrl(device, `ws://page/ws?ui_build=${build}`),
	);
	const waiting = new Map<string, (result: unknown) => void>();
	socket.onmessage = ({ data }) => {
		const { id, result, ping } = JSON.parse(String(data));
		// Like a page's client: the device drops a socket that stays silent.
		if (ping) socket.send(JSON.stringify({ pong: true }));
		waiting.get(id)?.(result);
	};
	await new Promise<void>((open, fail) => {
		socket.onopen = () => open();
		socket.onerror = () => fail(new Error("operator socket refused"));
	});
	const call = (path: string, input?: unknown) =>
		new Promise<unknown>((answer, fail) => {
			const dropped = () => fail(new Error(`${path}: operator socket closed`));
			if (socket.readyState !== socket.OPEN) return dropped();
			socket.addEventListener("close", dropped);
			const id = `${path}-${waiting.size}`;
			waiting.set(id, answer);
			socket.send(JSON.stringify({ id, path: path.split("."), input }));
		});
	await call("auth.login", { password: PASSWORD, persistent_token: false });
	return { call, close: () => socket.close() };
}
