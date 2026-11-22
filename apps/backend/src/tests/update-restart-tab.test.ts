/// <reference types="bun" />
/*
 * The owner's case end to end: one open tab across both restarts of a package
 * update. Every backend lifetime is a real fresh process (helpers/
 * update-restart-session.ts) sharing only the device's files; the detached
 * unit runs the real wrapper and its status file in its own session, so it keeps
 * running when the package's postinst kills the backend. The tab is a real
 * WebSocket client that sets the password, logs in, keeps its token, and
 * re-authenticates on every new process. The frames it receives are pinned in
 * the frontend fixtures that Layout.updating-overlay.test.ts renders.
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
const fixture = (name: string) =>
	new URL(`../../../frontend/src/tests/fixtures/${name}.json`, import.meta.url)
		.pathname;
const WAIT_MS = 20_000;

/** A deadline that a wait clears once it is answered, so it never fires later. */
async function within<T>(
	what: () => string,
	wait: (deadline: Promise<never>) => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(what())), WAIT_MS);
	});
	try {
		return await wait(deadline);
	} finally {
		clearTimeout(timer);
	}
}
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
	// Each wait starts after the previous match, so an old event never answers it.
	#from = 0;

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

	until(label: string, test: (seen: Seen) => boolean) {
		return within(
			() => `tab never saw: ${label}`,
			async (deadline) => {
				for (;;) {
					const index = this.seen.findIndex(
						(seen, i) => i >= this.#from && test(seen),
					);
					if (index >= 0) {
						this.#from = index + 1;
						return this.seen[index];
					}
					await Promise.race([this.#changed.promise, deadline]);
				}
			},
		);
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
});

afterEach(async () => {
	for (const child of sessions.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
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

function session(role: "first" | "after-postinst" | "after-outcome" | "boot") {
	const env: Record<string, string | undefined> = {
		...process.env,
		SCRATCH: scratch,
		NODE_ENV: "production",
		CERALIVE_STREAMING_MARKER: join(scratch, "streaming"),
		CERALIVE_EVENTS_DIR: join(scratch, "events"),
		CERALIVE_DISMISSALS_FILE: join(scratch, "dismissals.json"),
		DOCKER_HOST: "unix:///nonexistent/docker.sock",
	};
	delete env.MOCK_MODE;
	delete env.PORT;
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
	let stderr = "";
	let heard = Promise.withResolvers<void>();
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr)
			stderr += decoder.decode(chunk, { stream: true });
	})();
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
		// Output ended: wake waiters only once the exit is known, or they would spin.
		await child.exited;
		heard.resolve();
	})();
	const printed = (match: (line: string) => boolean, what: string) =>
		within(
			() => `${role} never printed ${what}: ${stderr}`,
			async (deadline) => {
				for (;;) {
					const hit = lines.find(match);
					if (hit !== undefined) return hit;
					await Promise.race([heard.promise, child.exited, deadline]);
					if (child.exitCode !== null && !lines.some(match))
						throw new Error(
							`${role} exited ${child.exitCode} before ${what}: ${stderr}`,
						);
				}
			},
		);
	return {
		child,
		output: () => `${lines.join("\n")}\n${stderr}`,
		async line(text: string) {
			await printed((line) => line === text, text);
		},
		async listening(): Promise<number> {
			const line = await printed(
				(entry) => entry.startsWith("session:listening "),
				"its port",
			);
			return Number(line.slice("session:listening ".length));
		},
		send(text: string) {
			try {
				child.stdin.write(`${text}\n`);
				child.stdin.flush();
			} catch (error) {
				// A session its own restart just ended has no stdin left to write.
				if (child.exitCode === null) throw error;
			}
		},
	};
}

async function release(barrier: string) {
	const writer = Bun.spawn(
		["sh", "-c", 'echo go > "$1"', "release", join(scratch, `${barrier}.fifo`)],
		{ timeout: WAIT_MS, killSignal: "SIGKILL" },
	);
	if ((await writer.exited) !== 0)
		throw new Error(`nothing waited on barrier ${barrier}`);
}

// The first lifetime launches the update; the postinst ends it during dpkg;
// the second recovers the same unit, which reaches Installing 80%.
async function signIn(tab: Tab, port: number): Promise<string> {
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
	return token;
}

async function toInstalling80(tab: Tab) {
	// The backend that starts the update.
	const first = session("first");
	const token = await signIn(tab, await first.listening());
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
	await tab.connect(await second.listening());
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
	return { second, token };
}

test("one open tab sees steady progress across the postinst restart and the completion restart", async () => {
	const tab = new Tab();
	const { second, token } = await toInstalling80(tab);
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
	await tab.connect(await third.listening());
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
	const pinned = JSON.parse(
		await readFile(fixture("update-restart-tab"), "utf8"),
	) as { seen: Seen[] };
	expect(seen).toEqual(pinned.seen);
}, 120_000);

test("a tab offline through the outcome and the completion restart learns the outcome when it reconnects", async () => {
	const tab = new Tab();
	const { second, token } = await toInstalling80(tab);
	// The tab's network drops before the unit finishes.
	tab.close();
	await tab.until("the tab goes offline", (s) => s.at === "disconnected");
	tab.moment("offline through the outcome");
	const exited = second.child.exited;
	await release("finish");
	expect(await exited).toBe(RESTART_EXIT_CODE);

	const third = session("after-outcome");
	await tab.connect(await third.listening());
	expect(await tab.call(["auth", "login"], { token })).toEqual({
		success: true,
	});
	await tab.pull();
	tab.moment("re-authenticated after the outcome");
	third.send("recover");
	await third.line("session:recovered");
	await tab.until(
		"the recorded outcome",
		(s) =>
			s.at === "push" &&
			(s.status.update_state as Status | undefined)?.kind === "success",
	);
	tab.moment("outcome replayed");
	const seen = [...tab.seen];
	tab.close();
	const at = (name: string) =>
		seen.findIndex((s) => s.at === "moment" && s.name === name);
	const carries = (s: Seen) =>
		(s.at === "push" || s.at === "pull") &&
		("updating" in s.status || "update_state" in s.status);
	// Nothing about packages reaches the reconnected tab before recovery read the record.
	expect(
		seen
			.slice(
				at("offline through the outcome"),
				at("re-authenticated after the outcome"),
			)
			.some(carries),
	).toBe(false);
	// Then one frame: no install running, and the unit's recorded success.
	expect(
		seen
			.slice(at("re-authenticated after the outcome"), at("outcome replayed"))
			.filter(carries)
			.map((s) => (s.at === "push" || s.at === "pull" ? s.status : undefined)),
	).toEqual([{ updating: null, update_state: { kind: "success" } }]);
	const pinned = JSON.parse(
		await readFile(fixture("update-restart-tab-offline"), "utf8"),
	) as { seen: Seen[] };
	expect(seen).toEqual(pinned.seen);
}, 120_000);

test("a successful unit that can never be retired restarts CeraUI once over five boots", async () => {
	// A finished, successful unit no backend could retire: `systemctl stop` always fails.
	await writeFile(join(scratch, "unit.exit"), "0\n");
	for (const [file, text] of [
		["stdout", "Setting up cerastream (2) ...\n"],
		["stderr", ""],
		["status", "pmstatus:cerastream:90.0000:Setting up cerastream\n"],
	] as const)
		await writeFile(join(scratch, `unit.${file}`), text, { mode: 0o600 });
	const exits: (number | null)[] = [];
	let adoptions = 0;
	for (let boot = 1; boot <= 5; boot++) {
		const lifetime = session("boot");
		await lifetime.listening();
		lifetime.send("recover");
		const recovered = await Promise.race([
			lifetime.line("session:recovered").then(() => true),
			lifetime.child.exited.then(() => false),
		]);
		if (recovered) lifetime.send("exit");
		exits.push(await lifetime.child.exited);
		if (
			lifetime.output().includes("reattached to the detached apt transaction")
		)
			adoptions++;
	}
	expect(exits).toEqual([RESTART_EXIT_CODE, 0, 0, 0, 0]);
	expect(adoptions).toBe(1);
	// The unit was never retired, and its exit is recorded beside its logs.
	expect(await readFile(join(scratch, "unit.exit"), "utf8")).toBe("0\n");
	expect(
		JSON.parse(
			await readFile(join(scratch, "software-update.attempt"), "utf8"),
		),
	).toMatchObject({ schema: 2, phase: "launched", exitCode: 0 });
}, 120_000);

// apt and dpkg for an update that finishes at once.
const QUICK_APT = `#!/bin/bash
echo "Setting up cerastream (2) ..."
printf 'pmstatus:cerastream:90.0000:Setting up cerastream\\n' >&3 || exit 100
exit 0
`;
const outcomeOf = (seen: Seen) =>
	seen.at === "push" || seen.at === "pull"
		? (seen.status.update_state as Status | undefined)?.kind
		: undefined;

test.each([
	"reachability",
	"apt-update",
	"space",
	"prepare-output",
	"unit-start",
])(
	"a restart while a new update waits at %s never tells the tab the previous update's outcome",
	async (step) => {
		await writeFile(join(scratch, "apt-get"), QUICK_APT);
		const tab = new Tab();
		// Update A succeeds and restarts CeraUI once.
		const first = session("first");
		const token = await signIn(tab, await first.listening());
		first.send("recover");
		await first.line("session:recovered");
		await tab.until("no unit at boot", (s) => updatingOf(s) === null);
		const exitedA = first.child.exited;
		expect(await tab.call(["system", "startUpdate"])).toMatchObject({
			success: true,
		});
		await tab.until("A's outcome", (s) => outcomeOf(s) === "success");
		expect(await exitedA).toBe(RESTART_EXIT_CODE);

		// Update B is accepted; CeraUI dies while B waits at `step`.
		const second = session("first");
		await tab.connect(await second.listening());
		expect(await tab.call(["auth", "login"], { token })).toEqual({
			success: true,
		});
		second.send("recover");
		await second.line("session:recovered");
		await tab.until(
			"A's outcome told again",
			(s) => outcomeOf(s) === "success",
		);
		second.send(`park ${step}`);
		await second.line(`session:parking ${step}`);
		expect(await tab.call(["system", "startUpdate"])).toMatchObject({
			success: true,
		});
		await second.line(`session:parked ${step}`);
		second.child.kill("SIGKILL");
		await second.child.exited;
		await tab.until("B's backend died", (s) => s.at === "disconnected");
		tab.moment("killed during B");

		// The next lifetime knows only the device's files.
		const third = session("first");
		await tab.connect(await third.listening());
		expect(await tab.call(["auth", "login"], { token })).toEqual({
			success: true,
		});
		third.send("recover");
		await third.line("session:recovered");
		await tab.pull();
		const seen = [...tab.seen];
		tab.close();
		const told = seen
			.slice(
				seen.findIndex(
					(s) => s.at === "moment" && s.name === "killed during B",
				),
			)
			.filter((s) => outcomeOf(s) !== undefined);
		expect(told.length).toBeGreaterThan(0);
		// Neither A's success nor any failure is ever B's; B simply never ran.
		expect(told.map(outcomeOf)).toEqual(told.map(() => "available"));
		expect(
			told.some((s) => {
				const u = updatingOf(s) as { result?: unknown } | null | undefined;
				return typeof u === "object" && u !== null && "result" in u;
			}),
		).toBe(false);
	},
	120_000,
);
