/// <reference types="bun" />
/*
 * The owner's case end to end: one open tab across both restarts of a package
 * update. Every backend lifetime is a real fresh process (helpers/
 * update-restart-session.ts) sharing only the device's files; the detached
 * unit runs the real wrapper and status drain in its own session, so it keeps
 * running when the package's postinst kills the backend. The tab is a real
 * WebSocket client that sets the password, logs in, keeps its token, and
 * re-authenticates on every new process. The frames it receives are pinned in
 * the frontend fixture that Layout.update-restart-replay.test.ts renders.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESTART_EXIT_CODE } from "./helpers/update-restart-unit.ts";

const SESSION = new URL("./helpers/update-restart-session.ts", import.meta.url)
	.pathname;
const SETUP = new URL("../../setup.json", import.meta.url).pathname;
const FIXTURE = new URL(
	"../../../frontend/src/tests/fixtures/update-restart-tab.json",
	import.meta.url,
).pathname;
const WAIT_MS = 20_000;
const BARRIERS = [
	"download-10",
	"download-60",
	"dpkg-40",
	"second-read",
	"restarted",
	"finish",
];

// apt and dpkg as the unit runs them. Each barrier is a FIFO the test opens
// only after the tab showed the state before it; the postinst stops the
// backend that launched the unit, as the real package's restart does.
const FAKE_APT = `#!/bin/bash
trap '' PIPE
step() { read -r _ < "$SCRATCH/$1.fifo"; }
echo "Reading package lists..."
printf 'dlstatus:1:10.0000:Retrieving file 1 of 1\\n' >&3
step download-10
printf 'dlstatus:1:60.0000:Retrieving file 1 of 1\\n' >&3
step download-60
echo "Preparing to unpack .../cerastream_2_arm64.deb ..."
printf 'pmstatus:dpkg-exec:0.0000:Running dpkg\\npmstatus:cerastream:40.0000:Unpacking cerastream\\n' >&3
step dpkg-40
kill -TERM "$(cat "$SCRATCH/backend.pid")"
printf 'pmstatus:cerastream:60.0000:Setting up cerastream\\n' >&3
step restarted
printf 'pmstatus:cerastream:80.0000:Setting up cerastream\\n' >&3
step finish
echo "Setting up cerastream (2) ..."
exit 0
`;

type Status = Record<string, unknown>;
type Seen =
	| { readonly at: "connected" | "disconnected" }
	| { readonly at: "push" | "pull"; readonly status: Status }
	| { readonly at: "moment"; readonly name: string };

// The fields a tab's package views read; volatile stamps are dropped.
function packageFields(status: Status): Status | undefined {
	const picked: Status = {};
	if ("updating" in status) picked.updating = status.updating;
	if ("update_state" in status) {
		const {
			checked_at: _c,
			failure_id: _f,
			...state
		} = status.update_state as Status;
		picked.update_state = state;
	}
	return Object.keys(picked).length > 0 ? picked : undefined;
}

class Tab {
	readonly seen: Seen[] = [];
	#socket: WebSocket | undefined;
	#replies = new Map<string, PromiseWithResolvers<unknown>>();
	#changed = Promise.withResolvers<void>();
	#id = 0;

	#record(entry: Seen) {
		this.seen.push(entry);
		this.#changed.resolve();
		this.#changed = Promise.withResolvers<void>();
	}

	async connect(port: number) {
		const opened = Promise.withResolvers<void>();
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		socket.onopen = () => {
			this.#record({ at: "connected" });
			opened.resolve();
		};
		socket.onerror = () => opened.reject(new Error("tab could not connect"));
		socket.onclose = () => this.#record({ at: "disconnected" });
		socket.onmessage = ({ data }) => {
			const frame = JSON.parse(String(data)) as Record<string, unknown>;
			if (typeof frame.id === "string" && this.#replies.has(frame.id)) {
				const reply = this.#replies.get(frame.id);
				this.#replies.delete(frame.id);
				if (frame.error) reply?.reject(new Error(JSON.stringify(frame.error)));
				else reply?.resolve(frame.result);
				return;
			}
			if (frame.ping !== undefined)
				socket.send(JSON.stringify({ pong: frame.ping }));
			const status = frame.status as Status | undefined;
			const fields = status && packageFields(status);
			if (fields) this.#record({ at: "push", status: fields });
		};
		this.#socket = socket;
		await opened.promise;
	}

	call<T>(path: string[], input?: unknown): Promise<T> {
		const id = `tab-${++this.#id}`;
		const reply = Promise.withResolvers<unknown>();
		this.#replies.set(id, reply);
		this.#socket?.send(JSON.stringify({ id, path, input }));
		return reply.promise as Promise<T>;
	}

	async pull() {
		const status = await this.call<Status>(["status", "getStatus"]);
		this.#record({ at: "pull", status: packageFields(status) ?? {} });
	}

	moment(name: string) {
		this.#record({ at: "moment", name });
	}

	async until(label: string, test: (seen: Seen) => boolean) {
		const deadline = Bun.sleep(WAIT_MS).then(() => {
			throw new Error(`tab never saw: ${label}`);
		});
		for (let from = 0; ; ) {
			const hit = this.seen.slice(from).find(test);
			if (hit) return hit;
			from = this.seen.length;
			await Promise.race([this.#changed.promise, deadline]);
		}
	}

	close() {
		this.#socket?.close();
	}
}

const updatingOf = (seen: Seen) =>
	seen.at === "push" || seen.at === "pull" ? seen.status.updating : undefined;
const running = (percent: number, phase: "downloading" | "setting_up") => ({
	total: 1,
	downloading: phase === "downloading" ? 1 : 0,
	unpacking: 0,
	setting_up: phase === "setting_up" ? 1 : 0,
	percent,
});

let scratch: string;
let port: number;
const sessions: Bun.Subprocess[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "update-restart-tab-"));
	await mkdir(join(scratch, "cwd"));
	await copyFile(SETUP, join(scratch, "cwd", "setup.json"));
	await writeFile(join(scratch, "apt-get"), FAKE_APT);
	await chmod(join(scratch, "apt-get"), 0o755);
	await Bun.spawn([
		"mkfifo",
		...BARRIERS.map((b) => join(scratch, `${b}.fifo`)),
	]).exited;
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	port = probe.port ?? 0;
	await probe.stop(true);
});

afterEach(async () => {
	for (const child of sessions.splice(0)) child.kill("SIGKILL");
	const unit = await readFile(join(scratch, "unit.pid"), "utf8").catch(
		() => "",
	);
	if (unit)
		try {
			process.kill(-Number(unit), "SIGKILL");
		} catch {
			// The unit already exited with its session.
		}
	await rm(scratch, { recursive: true, force: true });
});

function session(role: "first" | "after-postinst" | "after-outcome") {
	const env: Record<string, string | undefined> = {
		...process.env,
		SCRATCH: scratch,
		PORT: String(port),
		NODE_ENV: "production",
		CERALIVE_STREAMING_MARKER: join(scratch, "streaming"),
		CERALIVE_EVENTS_DIR: join(scratch, "events"),
		CERALIVE_DISMISSALS_FILE: join(scratch, "dismissals.json"),
		DOCKER_HOST: "unix:///nonexistent/docker.sock",
	};
	delete env.MOCK_MODE;
	const child = Bun.spawn([process.execPath, SESSION, role], {
		cwd: join(scratch, "cwd"),
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 90_000,
		killSignal: "SIGKILL",
	});
	sessions.push(child);
	const lines: string[] = [];
	let heard = Promise.withResolvers<void>();
	const stderr = new Response(child.stderr).text();
	void (async () => {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of child.stdout) {
			pending += decoder.decode(chunk, { stream: true });
			const complete = pending.split("\n");
			pending = complete.pop() ?? "";
			lines.push(...complete);
			heard.resolve();
			heard = Promise.withResolvers<void>();
		}
		heard.resolve();
	})();
	return {
		child,
		async line(text: string) {
			const deadline = Bun.sleep(WAIT_MS).then(async () => {
				throw new Error(`${role} never printed ${text}: ${await stderr}`);
			});
			while (!lines.includes(text))
				await Promise.race([heard.promise, deadline]);
		},
		send(text: string) {
			child.stdin.write(`${text}\n`);
			child.stdin.flush();
		},
	};
}

async function release(barrier: string) {
	await Bun.spawn([
		"sh",
		"-c",
		'echo go > "$1"',
		"release",
		join(scratch, `${barrier}.fifo`),
	]).exited;
}

test("one open tab sees steady progress across the postinst restart and the completion restart", async () => {
	const tab = new Tab();

	// The backend that starts the update.
	const first = session("first");
	await first.line("session:listening");
	await tab.connect(port);
	expect(
		await tab.call(["auth", "setPassword"], { password: "restart-test" }),
	).toEqual({ success: true });
	const login = await tab.call<{ success: boolean; auth_token?: string }>(
		["auth", "login"],
		{ password: "restart-test", persistent_token: true },
	);
	expect(login.success).toBe(true);
	const token = login.auth_token ?? "";
	expect(token).not.toBe("");
	await tab.pull();
	tab.moment("signed in before the first recovery");
	first.send("recover");
	await first.line("session:recovered");
	await tab.until("no unit at boot", (s) => updatingOf(s) === null);
	tab.moment("idle");
	expect(await tab.call(["system", "startUpdate"])).toMatchObject({
		success: true,
	});
	await tab.until("download 10%", (s) =>
		Bun.deepEquals(updatingOf(s), running(10, "downloading")),
	);
	tab.moment("downloading 10%");
	await release("download-10");
	await tab.until("download 60%", (s) =>
		Bun.deepEquals(updatingOf(s), running(60, "downloading")),
	);
	tab.moment("downloading 60%");
	await release("download-60");
	await tab.until("installing 40%", (s) =>
		Bun.deepEquals(updatingOf(s), running(40, "setting_up")),
	);
	tab.moment("installing 40%");
	await release("dpkg-40");
	await tab.until("the postinst restart", (s) => s.at === "disconnected");
	tab.moment("postinst stopped the backend");
	expect(await first.child.exited).toBe(143);

	// The backend the postinst started; the same unit keeps running.
	const second = session("after-postinst");
	await second.line("session:listening");
	await tab.connect(port);
	expect(await tab.call(["auth", "login"], { token })).toEqual({
		success: true,
	});
	await tab.pull();
	tab.moment("re-authenticated before recovery");
	second.send("recover");
	// Both recovery calls returned; the unit's files are not read yet.
	await second.line("session:recovered");
	await tab.pull();
	tab.moment("attached, nothing read yet");
	await release("second-read");
	await tab.until("recovered installing 60%", (s) =>
		Bun.deepEquals(updatingOf(s), running(60, "setting_up")),
	);
	tab.moment("recovered at installing 60%");
	await release("restarted");
	await tab.until("installing 80%", (s) =>
		Bun.deepEquals(updatingOf(s), running(80, "setting_up")),
	);
	tab.moment("installing 80%");
	const exited = second.child.exited;
	await release("finish");
	await tab.until("the outcome", (s) => {
		const u = updatingOf(s) as { result?: unknown } | null | undefined;
		return typeof u === "object" && u?.result === 0;
	});
	tab.moment("outcome");
	await tab.until("the completion restart", (s) => s.at === "disconnected");
	expect(await exited).toBe(RESTART_EXIT_CODE);
	tab.moment("completion restart");

	// The backend after the outcome: no unit is left.
	const third = session("after-outcome");
	await third.line("session:listening");
	await tab.connect(port);
	expect(await tab.call(["auth", "login"], { token })).toEqual({
		success: true,
	});
	await tab.pull();
	tab.moment("re-authenticated after the outcome");
	third.send("recover");
	await third.line("session:recovered");
	await tab.until("no unit after the outcome", (s) => updatingOf(s) === null);
	tab.moment("no unit after the outcome");
	const seen = [...tab.seen];
	tab.close();
	const at = (name: string) =>
		seen.findIndex((s) => s.at === "moment" && s.name === name);
	const between = (from: string, to: string) =>
		seen.slice(at(from) + 1, at(to));
	const carries = (s: Seen) =>
		(s.at === "push" || s.at === "pull") &&
		("updating" in s.status || "update_state" in s.status);
	// Before any recovery a tab is told nothing about packages.
	expect(
		seen.slice(0, at("signed in before the first recovery")).some(carries),
	).toBe(false);
	// After each restart, nothing about packages until recovery has read the unit.
	expect(
		between("postinst stopped the backend", "attached, nothing read yet").some(
			carries,
		),
	).toBe(false);
	expect(
		between("completion restart", "re-authenticated after the outcome").some(
			carries,
		),
	).toBe(false);
	// The recovered process announces exactly the state the files reached.
	expect(
		between("attached, nothing read yet", "recovered at installing 60%")
			.filter(carries)
			.map(updatingOf),
	).toEqual([running(60, "setting_up")]);
	// From the first download frame to the outcome: never empty, never null,
	// never a lower phase or number.
	const rank = (u: {
		downloading: number;
		setting_up: number;
		percent?: number;
	}) =>
		(u.setting_up > 0 ? 2 : u.downloading > 0 ? 1 : 0) * 1000 +
		(u.percent ?? -1);
	type Frame = {
		downloading: number;
		setting_up: number;
		percent?: number;
		result?: unknown;
	} | null;
	const frames = between("idle", "outcome")
		.map(updatingOf)
		.filter((u) => u !== undefined) as Frame[];
	const started = frames.findIndex((u) =>
		Bun.deepEquals(u, running(10, "downloading")),
	);
	const ended = frames.findIndex((u) => u?.result !== undefined);
	// The outcome is the last frame, and only after the unit exited.
	expect(ended).toBe(frames.length - 1);
	const live = frames.slice(started, ended);
	expect(live.every((u) => u !== null)).toBe(true);
	for (let i = 1; i < live.length; i++)
		expect(rank(live[i] as never)).toBeGreaterThanOrEqual(
			rank(live[i - 1] as never),
		);
	// What this tab received is what the frontend replay renders.
	const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as {
		seen: Seen[];
	};
	expect(seen).toEqual(fixture.seen);
}, 120_000);
