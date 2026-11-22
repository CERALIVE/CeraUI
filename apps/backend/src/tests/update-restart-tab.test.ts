/// <reference types="bun" />
/*
 * The owner's case end to end: one open tab across both restarts of a package
 * update, with main's unit handling. Every backend lifetime is a real fresh
 * process (helpers/update-restart-session.ts) sharing only the device's files;
 * the detached unit runs the real released command in its own session, so it
 * keeps running when the package's postinst kills the backend. The tab is a
 * real WebSocket client that sets the password, logs in, keeps its token and
 * re-authenticates on every new process. When the install it showed ends
 * without its result reaching it, it asks what the frontend asks: whether
 * the versions the device offered are installed. The frames and answers it
 * receives are pinned in the frontend fixtures Layout.updating-overlay.test.ts
 * renders.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { watch } from "node:fs";
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
const PACKAGES = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
// What the device offered: every package at version 2 (it runs version 1).
const OFFER = PACKAGES.map((name) => ({
	name,
	version: "2",
	layer: "app",
	actionable: true,
}));

// apt and dpkg as the unit runs them. Each barrier is a FIFO the test opens
// only after the tab showed the state before it; the postinst stops the
// backend that launched the unit, as the real package's restart does. The
// last step installs version 2 of every package, or fails with 100 when
// `fail` exists.
const FAKE_APT = `#!/bin/bash
trap '' PIPE
step() { read -r _ < "$SCRATCH/$1.fifo"; }
# APT's transcript for a ten-package plan. Each moment is one printf, one
# write, so the observer never reads half of it.
echo "Reading package lists..."
printf '%s\\n' "The following packages will be upgraded:" "  p1 p2 p3 p4 p5 p6 p7 p8 p9 p10" "10 upgraded, 0 newly installed, 0 to remove and 0 not upgraded." "Get:"{1..2}" https://apt.invalid trixie/main arm64 p 2 [4 kB]"
step download-10
printf '%s\\n' "Get:"{3..7}" https://apt.invalid trixie/main arm64 p 2 [4 kB]"
step download-60
printf '%s\\n' "Fetched 40 kB in 7s (6 kB/s)" "Preparing to unpack .../p1_2_arm64.deb ..." "Unpacking p"{1..9}" (2) over (1) ..."
step dpkg-40
kill -TERM "$(cat "$SCRATCH/backend.pid")"
printf '%s\\n' "Unpacking p10 (2) over (1) ..." "Setting up p"{1..3}" (2) ..."
step restarted
printf '%s\\n' "Setting up p"{4..7}" (2) ..."
step finish
if [ -e "$SCRATCH/fail" ]; then echo "E: Sub-process /usr/bin/dpkg returned an error code (1)" >&2; exit 100; fi
printf 'p%s\\t2\\n' {1..10} > "$SCRATCH/installed"
exit 0
`;
// dpkg-query -W -f=<Package\tStatus\tVersion> -- names: what is installed,
// exit 1 for a name it does not list; exit 2 while `dpkg-query.fail` exists.
const FAKE_DPKG_QUERY = `#!/bin/bash
[ -e "$SCRATCH/dpkg-query.fail" ] && { echo "dpkg-query: error" >&2; exit 2; }
while [ "$1" != "--" ]; do shift; done; shift
missing=0
for name in "$@"; do
  version=$(awk -F '\\t' -v n="$name" '$1 == n { print $2 }' "$SCRATCH/installed")
  if [ -n "$version" ]; then printf '%s\\tii \\t%s\\n' "$name" "$version"; else missing=1; fi
done
exit $missing
`;
// dpkg --compare-versions A ge B, for this test's integer versions.
const FAKE_DPKG = `#!/bin/bash
[ "$1" = --compare-versions ] && [ "$3" = ge ] && { [ "$2" -ge "$4" ]; exit $?; }
exit 2
`;

type Status = Record<string, unknown>;
type Seen =
	| { readonly at: "connected" | "disconnected" }
	| { readonly at: "push" | "pull"; readonly status: Status }
	| { readonly at: "moment"; readonly name: string }
	| { readonly at: "asked"; readonly outcome: unknown };

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

	// What the frontend asks once the install it showed ended without its result.
	async ask() {
		const outcome = await this.call(["system", "updateOutcome"], {
			packages: OFFER,
		});
		this.#record({ at: "asked", outcome });
		return outcome;
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
const running = (percent: number) => ({
	total: 1,
	downloading: 0,
	unpacking: 0,
	setting_up: 1,
	percent,
});
// APT prints `Get:` as each archive starts, never when one is done: the
// download shows its phase, and no number.
const downloadingPhase = {
	total: 1,
	downloading: 1,
	unpacking: 0,
	setting_up: 0,
};
const preparing = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };

let scratch: string;
const sessions: Bun.Subprocess[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "update-restart-tab-"));
	await mkdir(join(scratch, "cwd"));
	await mkdir(join(scratch, "bin"));
	await copyFile(SETUP, join(scratch, "cwd", "setup.json"));
	for (const [name, script] of [
		["apt-get", FAKE_APT],
		["bin/dpkg-query", FAKE_DPKG_QUERY],
		["bin/dpkg", FAKE_DPKG],
	] as const) {
		await writeFile(join(scratch, name), script);
		await chmod(join(scratch, name), 0o755);
	}
	await writeFile(
		join(scratch, "installed"),
		PACKAGES.map((name) => `${name}\t1\n`).join(""),
	);
	await Bun.spawn([
		"mkfifo",
		...BARRIERS.map((b) => join(scratch, `${b}.fifo`)),
	]).exited;
});

afterEach(async () => {
	const children = sessions.splice(0);
	for (const child of children) child.kill("SIGKILL");
	await Promise.all(children.map((child) => child.exited));
	// Only a unit still running is signalled: a finished one's pid may name another process by now.
	const unit = await readFile(join(scratch, "unit.pid"), "utf8").catch(
		() => "",
	);
	if (unit && !(await Bun.file(join(scratch, "unit.exit")).exists()))
		try {
			process.kill(-Number(unit), "SIGKILL");
		} catch {
			// The unit exited between the check and the signal.
		}
	await rm(scratch, { recursive: true, force: true });
}, 60_000);

function session(
	role: "first" | "after-postinst" | "after-outcome" | "refused",
) {
	const env: Record<string, string | undefined> = {
		...process.env,
		// dpkg as the device answers it, from the versions the fake unit installed.
		PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}`,
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

/** Resolves once the unit's exit status is written, watched before it can happen. */
function unitExited(): Promise<void> {
	const exit = join(scratch, "unit.exit");
	return within(
		() => "the unit never exited",
		async (deadline) => {
			const written = Promise.withResolvers<void>();
			const watcher = watch(scratch, () => {
				void Bun.file(exit)
					.exists()
					.then((exists) => exists && written.resolve());
			});
			try {
				if (await Bun.file(exit).exists()) return;
				await Promise.race([written.promise, deadline]);
			} finally {
				watcher.close();
			}
		},
	);
}

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

async function reconnect(tab: Tab, port: number, token: string) {
	await tab.connect(port);
	expect(await tab.call(["auth", "login"], { token })).toEqual({
		success: true,
	});
	await tab.pull();
}

// The first lifetime launches the update; the postinst ends it during dpkg.
async function toPostinst(tab: Tab): Promise<string> {
	const first = session("first");
	const token = await signIn(tab, await first.listening());
	await tab.pull();
	first.send("recover");
	await first.line("session:recovered");
	await tab.pull();
	tab.moment("idle");
	expect(await tab.call(["system", "startUpdate"])).toMatchObject({
		success: true,
	});
	await tab.until("downloading", (s) =>
		Bun.deepEquals(updatingOf(s), downloadingPhase),
	);
	tab.moment("downloading");
	// More archives start: nothing proves any done, so the frame stays.
	await release("download-10");
	await release("download-60");
	await tab.until("installing 40%", (s) =>
		Bun.deepEquals(updatingOf(s), running(40)),
	);
	tab.moment("installing 40%");
	await release("dpkg-40");
	await tab.until("the postinst restart", (s) => s.at === "disconnected");
	tab.moment("postinst stopped the backend");
	expect(await first.child.exited).toBe(143);
	return token;
}

// The backend the postinst started recovers the same unit, which reaches 80%.
async function toInstalling80(tab: Tab) {
	const token = await toPostinst(tab);
	const second = session("after-postinst");
	await reconnect(tab, await second.listening(), token);
	tab.moment("re-authenticated before recovery");
	// main's first status says nothing is updating: the tab asks, and is told
	// this process will report the unit itself.
	expect(await tab.ask()).toEqual({ kind: "running" });
	second.send("recover");
	await second.line("session:recovered");
	await tab.pull();
	tab.moment("attached, nothing read yet");
	await release("second-read");
	await tab.until("recovered installing 60%", (s) =>
		Bun.deepEquals(updatingOf(s), running(60)),
	);
	tab.moment("recovered at installing 60%");
	await release("restarted");
	await tab.until("installing 80%", (s) =>
		Bun.deepEquals(updatingOf(s), running(80)),
	);
	tab.moment("installing 80%");
	return { second, token };
}

const pushedUpdating = (seen: readonly Seen[]) =>
	seen.flatMap((s) =>
		s.at === "push" && "updating" in s.status ? [s.status.updating] : [],
	);
const between = (seen: readonly Seen[], from: string, to: string) => {
	const at = (name: string) =>
		seen.findIndex((s) => s.at === "moment" && s.name === name);
	return seen.slice(at(from) + 1, at(to));
};

test("one open tab across the postinst restart and the completion restart: the device's own frames, then the installed versions", async () => {
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

	// The backend after the outcome: no unit is left, and version 2 is installed.
	const third = session("after-outcome");
	await reconnect(tab, await third.listening(), token);
	tab.moment("re-authenticated after the outcome");
	expect(await tab.ask()).toEqual({ kind: "success" });
	const seen = [...tab.seen];
	tab.close();

	// The device's own frames: the recovered process announces the unit it
	// attached before reading it, then exactly what its files reached.
	expect(
		pushedUpdating(between(seen, "idle", "postinst stopped the backend")),
	).toEqual([preparing, downloadingPhase, running(40)]);
	expect(
		pushedUpdating(
			between(seen, "re-authenticated before recovery", "installing 80%"),
		),
	).toEqual([preparing, running(60), running(80)]);
	const outcome = pushedUpdating(between(seen, "installing 80%", "outcome"));
	expect(outcome).toHaveLength(1);
	expect(outcome[0]).toMatchObject({ result: 0 });
	// main's first status after each restart: nothing is updating.
	for (const moment of [
		"re-authenticated before recovery",
		"re-authenticated after the outcome",
	]) {
		const pulled =
			seen[seen.findIndex((s) => s.at === "moment" && s.name === moment) - 1];
		expect(pulled?.at === "pull" && pulled.status.updating).toBeNull();
	}
	expect(seen.filter((s) => s.at === "asked")).toEqual([
		{ at: "asked", outcome: { kind: "running" } },
		{ at: "asked", outcome: { kind: "success" } },
	]);
	// What this tab received is what the frontend replay renders.
	const pinned = JSON.parse(
		await readFile(fixture("update-restart-tab"), "utf8"),
	) as { seen: Seen[] };
	expect(seen).toEqual(pinned.seen);
}, 120_000);

test("a tab offline through the outcome and the completion restart learns it from the installed versions, and nothing while dpkg cannot answer", async () => {
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
	await reconnect(tab, await third.listening(), token);
	tab.moment("re-authenticated after the outcome");
	// The device kept no outcome: the restarted process says nothing is updating.
	expect(tab.seen.at(-2)).toEqual({
		at: "pull",
		status: expect.objectContaining({ updating: null }),
	});
	expect(await tab.ask()).toEqual({ kind: "success" });
	// The same question while dpkg cannot answer proves nothing.
	await writeFile(join(scratch, "dpkg-query.fail"), "");
	expect(await tab.ask()).toEqual({ kind: "unknown" });
	const seen = [...tab.seen];
	tab.close();
	const pinned = JSON.parse(
		await readFile(fixture("update-restart-tab-offline"), "utf8"),
	) as { seen: Seen[] };
	expect(seen).toEqual(pinned.seen);
}, 120_000);

test("after a refused boot the unit is reported by nobody: not confirmed while it runs, its failure exit as the hint once it ends below the offer", async () => {
	const tab = new Tab();
	const token = await toPostinst(tab);
	const refused = session("refused");
	await reconnect(tab, await refused.listening(), token);
	// No process will report this unit: decided now, and nothing is proven.
	expect(await tab.ask()).toEqual({ kind: "unknown" });
	await writeFile(join(scratch, "fail"), "");
	const exited = unitExited();
	await release("restarted");
	await release("finish");
	await exited;
	expect(await tab.ask()).toEqual({
		kind: "failed",
		reason: "apt-get exited with code 100",
	});
	// The refused boot never retired, restarted or reported anything itself:
	// its only word about packages is main's first status, nothing updating.
	expect(refused.child.exitCode).toBeNull();
	expect(
		pushedUpdating(
			tab.seen.slice(
				tab.seen.findIndex(
					(s) => s.at === "moment" && s.name === "postinst stopped the backend",
				),
			),
		),
	).toEqual([null]);
	expect(await readFile(join(scratch, "unit-events.log"), "utf8")).toBe(
		"start\n",
	);
	tab.close();
}, 120_000);
