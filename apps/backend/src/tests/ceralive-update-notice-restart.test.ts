/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend, and a tab can stay open, or be offline, throughout. Each backend
 * below is a real fresh process (helpers/ceralive-update-session.ts) serving the
 * real WebSocket control server over the same device files; like production it
 * binds first and hydrates the notice afterwards. Each tab is a real
 * authenticated WebSocket client that keeps what it was shown across restarts,
 * records every CeraLive show and removal it receives, and decodes frames like
 * the current and main-era frontends (typed removals) or like v2026.7.2
 * (bare-name removals only).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";

import { OFFER_VERSION_LIMIT } from "../modules/system/ceralive-update-notice.ts";
import { ceralivePackageList } from "../modules/system/package-layer.ts";
import {
	APPLIED_MARKER,
	type AptPackage,
	type AptScript,
	CHECKED_MARKER,
	HYDRATED_MARKER,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RESTART_EXIT_CODE,
	SESSION_PASSWORD,
} from "./helpers/ceralive-update-apt.ts";
import type { SessionStep } from "./helpers/ceralive-update-session.ts";

const NOTICE = "ceralive_update";
// Bound for one awaited event (a marker, a frame answer, an exit); never a sleep.
const DEADLINE_MS = 30_000;
const budget = (backends: number) => (backends + 2) * DEADLINE_MS;
const SESSION = new URL("./helpers/ceralive-update-session.ts", import.meta.url)
	.pathname;
const SETUP = new URL("../../setup.json", import.meta.url).pathname;

let root: string;
let record: string;
let dismissals: string;
let live: { close(): Promise<void> }[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ceralive-update-restart-"));
	record = join(root, "ceralive_update_offer.json");
	dismissals = join(root, "dismissals.json");
	await mkdir(join(root, "cwd"));
	await mkdir(join(root, "run"));
	await copyFile(SETUP, join(root, "cwd", "setup.json"));
});

afterEach(async () => {
	await Promise.all(live.map((item) => item.close()));
	live = [];
	await rm(root, { recursive: true, force: true });
});

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`no ${what} within ${DEADLINE_MS} ms`)),
					DEADLINE_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// A child's output, read as it arrives so a full pipe never blocks the child.
class Lines {
	private readonly seen: string[] = [];
	private cursor = 0;
	private wake: (() => void) | undefined;
	private ended = false;

	constructor(stream: ReadableStream<Uint8Array>) {
		void this.pump(stream);
	}

	private async pump(stream: ReadableStream<Uint8Array>) {
		const decoder = new TextDecoder();
		let rest = "";
		for await (const chunk of stream) {
			const parts = (rest + decoder.decode(chunk, { stream: true })).split(
				"\n",
			);
			rest = parts.pop() ?? "";
			this.seen.push(...parts);
			this.wake?.();
		}
		this.seen.push(rest);
		this.ended = true;
		this.wake?.();
	}

	async next(match: (line: string) => boolean): Promise<string> {
		for (;;) {
			const at = this.seen.findIndex(
				(line, index) => index >= this.cursor && match(line),
			);
			if (at >= 0) {
				this.cursor = at + 1;
				return this.seen[at] ?? "";
			}
			if (this.ended) throw new Error(`output ended:\n${this.text()}`);
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}

	text(): string {
		return this.seen.join("\n");
	}
}

type Step = Omit<SessionStep, "record" | "scratch">;

class Backend {
	readonly port: number;
	private readonly out: Lines;
	private readonly err: Lines;

	private constructor(
		private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
		port: number,
		out: Lines,
		err: Lines,
	) {
		this.port = port;
		this.out = out;
		this.err = err;
	}

	static async start(
		step: Step = {},
		{ hydrate = true }: { hydrate?: boolean } = {},
	): Promise<Backend> {
		const input: SessionStep = { ...step, record, scratch: root };
		const child = Bun.spawn(
			[process.execPath, SESSION, JSON.stringify(input)],
			{
				cwd: join(root, "cwd"),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					PORT: "0",
					CERALIVE_RUN_DIR: join(root, "run"),
					CERALIVE_DISMISSALS_FILE: dismissals,
					CERALIVE_STREAMING_MARKER: join(root, "streaming"),
					CERALIVE_EVENTS_DIR: join(root, "events"),
					DOCKER_HOST: "unix:///nonexistent/docker.sock",
				},
			},
		);
		// Registered before readiness, so a child that never gets ready is still ended.
		live.push({
			close: async () => {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
				await within(child.exited, "child exit");
			},
		});
		const out = new Lines(child.stdout);
		const err = new Lines(child.stderr);
		const ready = await within(
			out.next((line) => line.startsWith(READY_PREFIX)),
			"backend ready",
		);
		const backend = new Backend(
			child,
			Number(ready.slice(READY_PREFIX.length)),
			out,
			err,
		);
		if (hydrate) await backend.hydrate();
		return backend;
	}

	private async command(text: string, marker: string, what: string) {
		this.child.stdin.write(`${text}\n`);
		this.child.stdin.flush();
		await within(
			this.out.next((line) => line === marker),
			what,
		);
	}

	hydrate(): Promise<void> {
		return this.command("hydrate", HYDRATED_MARKER, "hydration");
	}

	check(): Promise<void> {
		return this.command("check", CHECKED_MARKER, "check completion");
	}

	// The device's APT evidence changes while this backend keeps running.
	setApt(state: AptScript): Promise<void> {
		return this.command(
			`apt ${JSON.stringify(state)}`,
			APPLIED_MARKER,
			"APT state",
		);
	}

	// What the package script's restart does to the running backend: SIGTERM, nothing else.
	async close(): Promise<void> {
		this.child.kill("SIGTERM");
		await within(this.child.exited, "backend exit");
		if (this.child.signalCode !== "SIGTERM")
			throw new Error(
				`backend ended ${this.child.exitCode}/${this.child.signalCode}:\n${this.err.text()}`,
			);
	}

	async recover() {
		this.child.stdin.write("recover\n");
		this.child.stdin.flush();
		const exit = await within(this.child.exited, "recovery exit");
		return { exit, stdout: this.out.text(), stderr: this.err.text() };
	}
}

type Decoder = "typed" | "v2026.7.2";

class Tab {
	// What the tab shows, with the copy's revision and publisher (for dismissal).
	readonly shown = new Map<string, { revision?: number; publisher?: string }>();
	// Every CeraLive show and removal the tab received, in order.
	readonly history: ("show" | "remove")[] = [];
	private socket: WebSocket | undefined;
	private closed: Promise<void> = Promise.resolve();
	private readonly answers = new Map<string, (frame: unknown) => void>();
	private requests = 0;

	constructor(readonly decoder: Decoder) {
		live.push(this);
	}

	names(): string[] {
		return [...this.shown.keys()];
	}

	removals(): number {
		return this.history.filter((event) => event === "remove").length;
	}

	async connect(backend: Backend): Promise<void> {
		const socket = new WebSocket(`ws://127.0.0.1:${backend.port}/ws`);
		this.socket = socket;
		this.closed = new Promise((resolve) =>
			socket.addEventListener("close", () => resolve()),
		);
		socket.addEventListener("message", (event) =>
			this.receive(JSON.parse(String(event.data))),
		);
		await within(
			new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve());
				socket.addEventListener("error", () =>
					reject(new Error("socket error")),
				);
			}),
			"socket open",
		);
		const login = await this.request(["auth", "login"], {
			password: SESSION_PASSWORD,
		});
		expect(login).toMatchObject({ result: { success: true } });
		await this.sync();
	}

	// Answered only after every frame the server queued before it on this socket.
	async sync(): Promise<void> {
		await this.request(["notifications", "getPersistent"]);
	}

	async dismiss(name: string): Promise<void> {
		await this.request(["notifications", "dismiss"], {
			name,
			...this.shown.get(name),
		});
	}

	// The socket drops when its backend exits; the tab keeps what it shows.
	async dropped(): Promise<void> {
		await within(this.closed, "socket close");
	}

	async close(): Promise<void> {
		this.socket?.close();
		await within(this.closed, "socket close");
	}

	private request(path: string[], input?: unknown): Promise<unknown> {
		const id = `r${++this.requests}`;
		const answer = new Promise<unknown>((resolve) =>
			this.answers.set(id, resolve),
		);
		this.socket?.send(
			JSON.stringify({ id, path, ...(input === undefined ? {} : { input }) }),
		);
		return within(answer, path.join("."));
	}

	private receive(frame: Record<string, unknown>): void {
		if ("ping" in frame) {
			this.socket?.send(JSON.stringify({ pong: true }));
			return;
		}
		const answer = typeof frame.id === "string" && this.answers.get(frame.id);
		if (answer) {
			this.answers.delete(String(frame.id));
			answer(frame);
			return;
		}
		if (!("notification" in frame)) return;
		if (this.decoder === "typed") {
			const parsed = notificationsMessageSchema.safeParse(frame.notification);
			if (!parsed.success) return;
			for (const { name, revision, publisher } of parsed.data.show ?? [])
				this.show(name, { revision, publisher });
			for (const { id } of parsed.data.remove ?? []) this.remove(id);
			return;
		}
		// v2026.7.2: no validation, and `remove` entries go to the store by value.
		const message = frame.notification as {
			show?: { name: string }[];
			remove?: unknown[];
		};
		for (const { name } of message.show ?? []) this.show(name, {});
		for (const entry of message.remove ?? [])
			if (typeof entry === "string") this.remove(entry);
	}

	private show(name: string, copy: { revision?: number; publisher?: string }) {
		if (name === NOTICE) this.history.push("show");
		this.shown.set(name, copy);
	}

	private remove(name: string): void {
		if (name === NOTICE) this.history.push("remove");
		this.shown.delete(name);
	}
}

const cerastream = (
	installed: string,
	candidate = installed,
	more: Partial<AptPackage> = {},
): AptPackage => ({ name: "cerastream", installed, candidate, ...more });
// The device's APT state: an offer pending, or installed with nothing pending.
const pending = (installed: string, candidate: string): AptScript => ({
	upgradable: [cerastream(installed, candidate)],
});
const settled = (
	installed: string,
	more: Partial<AptPackage> = {},
): AptScript => ({
	installed: [cerastream(installed, installed, more)],
});
const failing = (state: AptScript): AptScript => ({
	...state,
	refresh: { exitCode: 100, stderr: "E: Could not get lock\n" },
});

async function tabs(
	backend: Backend,
	decoders: Decoder[] = ["typed", "v2026.7.2"],
) {
	const opened = decoders.map((decoder) => new Tab(decoder));
	for (const tab of opened) await tab.connect(backend);
	return opened;
}

async function reconnect(backend: Backend, opened: readonly Tab[]) {
	for (const tab of opened) await tab.connect(backend);
}

async function sync(opened: readonly Tab[]) {
	for (const tab of opened) await tab.sync();
}

const names = (opened: readonly Tab[]) => opened.map((tab) => tab.names());
const removals = (opened: readonly Tab[]) =>
	opened.map((tab) => tab.removals());
const histories = (opened: readonly Tab[]) => opened.map((tab) => tab.history);

// Tabs that show the offer the way main's backend raised it (no record written).
async function olderBackendTabs(state: AptScript = pending("1", "2")) {
	const older = await Backend.start({ olderBackend: true, apt: state });
	const opened = await tabs(older);
	expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
	await older.close();
	return opened;
}

// A conclusive "nothing pending" proof at cerastream 2, recorded by a real check.
async function proveNothingPending(state: AptScript = settled("2")) {
	const proof = await Backend.start({ apt: state });
	await proof.check();
	await proof.close();
}

for (const capable of [false, true])
	test(
		`an update's restarts clear the offer in open tabs, live and after a missed proof, and a fresh tab never shows it (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given tabs of both decoders showing the offer before the install.
			const before = await Backend.start({ apt: pending("1", "2"), capable });
			const connected = await tabs(before);
			const missing = await tabs(before);
			await before.check();
			await sync([...connected, ...missing]);
			expect(histories([...connected, ...missing])).toEqual([
				["show"],
				["show"],
				["show"],
				["show"],
			]);
			// When the package script restarts the backend: the new process recovers
			// the finished install and exits through exactly the update's own restart.
			await before.close();
			const recovering = await Backend.start({ apt: settled("2"), capable });
			await reconnect(recovering, connected);
			const restart = await recovering.recover();
			expect(restart.exit).toBe(RESTART_EXIT_CODE);
			expect(restart.stdout).toContain(RECOVERY_RESTART_MARKER);
			expect(restart.stderr).not.toContain(RECOVERY_FAILED_MARKER);
			for (const tab of connected) await tab.dropped();
			// An install result is not evidence: nothing was removed through the recovery exit.
			expect(removals(connected)).toEqual([0, 0]);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			// When the completion restart's conclusive check finds nothing pending,
			// the tabs connected to it drop the offer from the live frames.
			const completion = await Backend.start({ apt: settled("2"), capable });
			await reconnect(completion, connected);
			expect(removals(connected)).toEqual([0, 0]);
			await completion.check();
			await sync(connected);
			expect(names(connected)).toEqual([[], []]);
			expect(removals(connected)).toEqual([1, 1]);
			await completion.close();
			// Then tabs that missed that process drop it when they re-authenticate to
			// the next one, even though its own refresh fails.
			const next = await Backend.start({ apt: failing(settled("2")), capable });
			await reconnect(next, missing);
			expect(names(missing)).toEqual([[], []]);
			expect(removals(missing)).toEqual([1, 1]);
			await next.check();
			await sync(missing);
			expect(names(missing)).toEqual([[], []]);
			// And a freshly opened tab never receives a show, only the recorded withdrawal.
			const fresh = await tabs(next);
			expect(histories(fresh)).toEqual([["remove"], ["remove"]]);
			// When a later check concludes again, connected tabs hear the removal again.
			await next.setApt(settled("2"));
			await next.check();
			await sync([...missing, ...fresh]);
			expect(removals(missing)).toEqual([2, 2]);
			expect(removals(fresh)).toEqual([2, 2]);
			// When a newer release appears, it is shown and nothing removes it.
			await next.setApt(pending("2", "3"));
			await next.check();
			await sync(missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([2, 2]);
			await next.close();
			// And a healthy restart that runs no check neither shows nor removes it.
			const idle = await Backend.start({ apt: pending("2", "3"), capable });
			await reconnect(idle, missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([2, 2]);
			expect(histories(await tabs(idle))).toEqual([[], []]);
		},
		budget(5),
	);

test(
	"a recovery that fails is never taken for the update's restart",
	async () => {
		const backend = await Backend.start({ recoverFails: true });
		const failed = await backend.recover();
		expect(failed.exit).not.toBe(RESTART_EXIT_CODE);
		expect(failed.stdout).not.toContain(RECOVERY_RESTART_MARKER);
		expect(failed.stderr).toContain(RECOVERY_FAILED_MARKER);
	},
	budget(1),
);

for (const capable of [false, true])
	test(
		`an update from a backend before this notice clears tabs that missed the proof (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given main's backend showing its offer in a main-era and a v2026.7.2 tab.
			const opened = await olderBackendTabs();
			// When the package restart recovers the install while the tabs are connected.
			const recovering = await Backend.start({ apt: settled("2"), capable });
			await reconnect(recovering, opened);
			const restart = await recovering.recover();
			expect(restart.exit).toBe(RESTART_EXIT_CODE);
			expect(restart.stdout).toContain(RECOVERY_RESTART_MARKER);
			for (const tab of opened) await tab.dropped();
			expect(removals(opened)).toEqual([0, 0]);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			// And the completion process proves nothing pending while both are offline.
			const completion = await Backend.start({ apt: settled("2"), capable });
			await completion.check();
			await completion.close();
			// Then the next backend, whose own refresh fails, clears both on re-auth.
			const next = await Backend.start({ apt: failing(settled("2")), capable });
			await reconnect(next, opened);
			expect(names(opened)).toEqual([[], []]);
			expect(removals(opened)).toEqual([1, 1]);
			// And a later conclusive check repeats it to the connected tabs.
			await next.setApt(settled("2"));
			await next.check();
			await sync(opened);
			expect(removals(opened)).toEqual([2, 2]);
		},
		budget(5),
	);

test(
	"after a rollback, the offer an older backend shows survives the restored backend",
	async () => {
		await proveNothingPending();
		for (const [label, state] of [
			["downgraded", pending("1", "2")],
			["re-upgraded, newer release published", pending("2", "3")],
		] as const) {
			// When a rollback runs an older backend that shows a valid offer.
			const opened = await olderBackendTabs(state);
			// And the restored backend restarts before any check, and the tabs re-authenticate.
			const restored = await Backend.start({ apt: state });
			await reconnect(restored, opened);
			// Then both decoders still show it, and nothing was sent to remove it.
			expect([label, names(opened)]).toEqual([label, [[NOTICE], [NOTICE]]]);
			expect([label, removals(opened)]).toEqual([label, [0, 0]]);
			// And the restored backend's own check shows it to a fresh tab.
			await restored.check();
			expect([label, names(await tabs(restored))]).toEqual([
				label,
				[[NOTICE], [NOTICE]],
			]);
			await restored.close();
		}
		// Control: back at exactly the proven state, a tab still showing the offer drops it.
		await proveNothingPending();
		const opened = await olderBackendTabs();
		const restored = await Backend.start({ apt: settled("2") });
		await reconnect(restored, opened);
		expect(names(opened)).toEqual([[], []]);
	},
	budget(10),
);

test(
	"a restored older record is ignored under other evidence and never erases a newer offer",
	async () => {
		await proveNothingPending();
		const stale = await readFile(record, "utf8");
		// Given a newer release found later and shown.
		const newer = await Backend.start({ apt: pending("2", "3") });
		const opened = await tabs(newer);
		await newer.check();
		await sync(opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await newer.close();
		// When the earlier record is restored and a backend starts before any check.
		await writeFile(record, stale);
		const restored = await Backend.start({ apt: pending("2", "3") });
		await reconnect(restored, opened);
		// Then nothing is replayed and the newer offer stays.
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(opened)).toEqual([0, 0]);
	},
	budget(3),
);

test(
	"a released hold with unchanged versions is new evidence: an older record cannot erase the offer",
	async () => {
		// Given a proof taken while cerastream 2 was held back (nothing actionable).
		const held: AptScript = {
			keptBack: [cerastream("1", "2")],
			holds: ["cerastream"],
		};
		await proveNothingPending(held);
		const stale = await readFile(record, "utf8");
		// When the hold is released, the same versions become an offer that is shown.
		const unheld = await Backend.start({ apt: pending("1", "2") });
		const opened = await tabs(unheld);
		await unheld.check();
		await sync(opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await unheld.close();
		// And the earlier record is restored before the next start.
		await writeFile(record, stale);
		const restarted = await Backend.start({ apt: pending("1", "2") });
		await reconnect(restarted, opened);
		// Then neither decoder is told to remove the valid offer.
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(opened)).toEqual([0, 0]);
	},
	budget(4),
);

test(
	"a pin or origin change with unchanged version strings is new evidence: nothing replays",
	async () => {
		for (const [label, moved] of [
			["pin", settled("2", { pin: 500 })],
			["origin", settled("2", { source: "debian" })],
		] as const) {
			await proveNothingPending(settled("2", { pin: 990 }));
			const opened = await olderBackendTabs();
			const restarted = await Backend.start({ apt: moved });
			await reconnect(restarted, opened);
			expect([label, names(opened)]).toEqual([label, [[NOTICE], [NOTICE]]]);
			expect([label, removals(opened)]).toEqual([label, [0, 0]]);
			await restarted.close();
		}
	},
	budget(8),
);

test(
	"a verdict whose evidence moved before the snapshot was read is not recorded or sent",
	async () => {
		const opened = await olderBackendTabs();
		// Discovery reads "nothing pending"; the state moves to an offer before the snapshot.
		const moving = await Backend.start({
			apt: { ...settled("2"), thenState: pending("2", "3") },
		});
		await reconnect(moving, opened);
		await moving.check();
		await sync(opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(opened)).toEqual([0, 0]);
		expect(await Bun.file(record).exists()).toBe(false);
	},
	budget(3),
);

test(
	"a startup match does not stay eligible after the evidence changes",
	async () => {
		await proveNothingPending();
		const first = await olderBackendTabs();
		const second = await olderBackendTabs();
		const backend = await Backend.start({ apt: settled("2") });
		// While the evidence matches, a reconnecting tab is told.
		await reconnect(backend, first);
		expect(names(first)).toEqual([[], []]);
		// When the evidence changes while the backend keeps running.
		await backend.setApt(pending("2", "3"));
		// Then a tab that reconnects afterwards is not told.
		await reconnect(backend, second);
		expect(names(second)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(second)).toEqual([0, 0]);
	},
	budget(5),
);

test(
	"tabs that authenticate before hydration see nothing wrong, then the right outcome",
	async () => {
		await proveNothingPending();
		// Matching evidence: early tabs get no frame until hydration, then the removal.
		const early = await olderBackendTabs();
		const matching = await Backend.start(
			{ apt: settled("2") },
			{ hydrate: false },
		);
		await reconnect(matching, early);
		expect(histories(early)).toEqual([["show"], ["show"]]);
		await matching.hydrate();
		await sync(early);
		expect(names(early)).toEqual([[], []]);
		expect(removals(early)).toEqual([1, 1]);
		await matching.close();
		// Rollback evidence: early tabs keep the offer before and after hydration.
		const rolledBack = await olderBackendTabs(pending("1", "2"));
		const restored = await Backend.start(
			{ apt: pending("1", "2") },
			{ hydrate: false },
		);
		await reconnect(restored, rolledBack);
		await restored.hydrate();
		await sync(rolledBack);
		expect(names(rolledBack)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(rolledBack)).toEqual([0, 0]);
	},
	budget(6),
);

test(
	"a fresh backend that finds an already-dismissed successor withdraws the predecessor",
	async () => {
		const first = await Backend.start({ apt: pending("1", "2") });
		const connected = await tabs(first);
		const missing = await tabs(first);
		await first.check();
		await sync([...connected, ...missing]);
		expect(names([...connected, ...missing])).toEqual([
			[NOTICE],
			[NOTICE],
			[NOTICE],
			[NOTICE],
		]);
		await first.close();
		// Given the operator dismissed release 3 elsewhere.
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [{ key: "update:cerastream=3", dismissedAt: 1 }],
			}),
		);
		// When a fresh process conclusively finds release 3, connected tabs drop the offer.
		const successor = await Backend.start({ apt: pending("1", "3") });
		await reconnect(successor, connected);
		await successor.check();
		await sync(connected);
		expect(names(connected)).toEqual([[], []]);
		expect(removals(connected)).toEqual([1, 1]);
		await successor.close();
		// Then the withdrawal also reaches tabs that missed it, after a restart.
		const idle = await Backend.start({ apt: pending("1", "3") });
		await reconnect(idle, missing);
		expect(names(missing)).toEqual([[], []]);
		expect(removals(missing)).toEqual([1, 1]);
		await idle.close();
		// And a release that was never dismissed is offered again.
		const later = await Backend.start({ apt: pending("1", "4") });
		await later.check();
		expect(names(await tabs(later))).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(4),
);

test(
	"a dismissal reaches other tabs live and after a restart, and covers that release only",
	async () => {
		const backend = await Backend.start({ apt: pending("1", "2") });
		const [dismissing, other] = await tabs(backend, ["typed", "typed"]);
		const missing = await tabs(backend);
		await backend.check();
		const all = [dismissing as Tab, other as Tab, ...missing];
		await sync(all);
		expect(names(all)).toEqual([[NOTICE], [NOTICE], [NOTICE], [NOTICE]]);
		// When one tab dismisses it while the others are offline.
		for (const tab of missing) await tab.close();
		await (dismissing as Tab).dismiss(NOTICE);
		await (other as Tab).sync();
		expect(names([dismissing as Tab, other as Tab])).toEqual([[], []]);
		expect((other as Tab).removals()).toBe(1);
		await backend.close();
		const restarted = await Backend.start({ apt: pending("1", "2") });
		await reconnect(restarted, missing);
		expect(names(missing)).toEqual([[], []]);
		expect(removals(missing)).toEqual([1, 1]);
		await restarted.check();
		expect(histories(await tabs(restarted))).toEqual([["remove"], ["remove"]]);
		await restarted.close();
		const newer = await Backend.start({ apt: pending("1", "3") });
		await newer.check();
		expect(names(await tabs(newer))).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(3),
);

test(
	"a matching withdrawal reaches missed tabs across several restarts",
	async () => {
		const first = await Backend.start({ apt: pending("1", "2") });
		const groups = [await tabs(first), await tabs(first)];
		await first.check();
		await sync(groups.flat());
		await first.close();
		await proveNothingPending();
		for (const group of groups) {
			const restarted = await Backend.start({ apt: failing(settled("2")) });
			await reconnect(restarted, group);
			expect(names(group)).toEqual([[], []]);
			expect(removals(group)).toEqual([1, 1]);
			// And this process's own conclusive check repeats it.
			await restarted.setApt(settled("2"));
			await restarted.check();
			await sync(group);
			expect(removals(group)).toEqual([2, 2]);
			await restarted.close();
		}
	},
	budget(5),
);

test(
	"startup derives nothing without a readable, current-schema record and acknowledgement store",
	async () => {
		// Given no record, or a directory where it should be: no removal at all.
		for (const prepare of [
			async () => undefined,
			async () => {
				await mkdir(record);
			},
		]) {
			await prepare();
			const opened = await olderBackendTabs();
			const backend = await Backend.start({ apt: settled("2") });
			await reconnect(backend, opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
			await backend.close();
			await rm(record, { recursive: true, force: true });
		}
		// The real record of a proof, then refused variants of it under the same evidence.
		await proveNothingPending();
		const valid = JSON.parse(await readFile(record, "utf8"));
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [{ key: "update:cerastream=2,srtla=3", dismissedAt: 1 }],
			}),
		);
		const refused: Record<string, string> = {
			corrupt: "{",
			"prior v2": JSON.stringify({ version: 2, offer: [], withdrawn: [] }),
			"prior v3": JSON.stringify({ ...valid, version: 3 }),
			"prior v4": JSON.stringify({ ...valid, version: 4 }),
			future: JSON.stringify({ ...valid, version: 6 }),
			duplicate: `{"version":5,"inputs":"${"0".repeat(64)}","offer":null,"inputs":"${valid.inputs}"}`,
			oversized: JSON.stringify(valid).padEnd(5000, " "),
			inputs: JSON.stringify({ ...valid, inputs: "not-a-fingerprint" }),
			// A forged multi-package key, whose acknowledgement is present, cannot be smuggled in.
			forged: JSON.stringify({
				...valid,
				offer: [{ name: "cerastream", version: "2,srtla=3" }],
			}),
		};
		for (const [kind, text] of Object.entries(refused)) {
			await writeFile(record, text);
			const opened = await olderBackendTabs();
			const backend = await Backend.start({ apt: settled("2") });
			await reconnect(backend, opened);
			expect([kind, names(opened), removals(opened)]).toEqual([
				kind,
				[[NOTICE], [NOTICE]],
				[0, 0],
			]);
			await backend.close();
		}
		// Control: the valid record under the same evidence does clear both tabs.
		await writeFile(record, JSON.stringify(valid));
		const control = await olderBackendTabs();
		const backend = await Backend.start({ apt: settled("2") });
		await reconnect(backend, control);
		expect(names(control)).toEqual([[], []]);
		await backend.close();
		await rm(record);
		await rm(dismissals);
		// Given an offer whose dismissal state cannot be read.
		const offering = await Backend.start({ apt: pending("1", "2") });
		const holding = await tabs(offering);
		await offering.check();
		await sync(holding);
		await offering.close();
		await mkdir(dismissals);
		// A fresh positive check then neither shows nor removes, and nor does the next start.
		const unreadable = await Backend.start({ apt: pending("1", "3") });
		await reconnect(unreadable, holding);
		await unreadable.check();
		await sync(holding);
		expect(histories(holding)).toEqual([["show"], ["show"]]);
		await unreadable.close();
		const following = await Backend.start({ apt: pending("1", "3") });
		await reconnect(following, holding);
		expect(histories(holding)).toEqual([["show"], ["show"]]);
		await following.close();
		// A proven absence needs no acknowledgement store, live and on later re-auth.
		const absent = await Backend.start({ apt: settled("3") });
		await reconnect(absent, holding);
		await absent.check();
		await sync(holding);
		expect(names(holding)).toEqual([[], []]);
		await absent.close();
		const late = await olderBackendTabs();
		const after = await Backend.start({ apt: failing(settled("3")) });
		await reconnect(after, late);
		expect(names(late)).toEqual([[], []]);
	},
	budget(34),
);

test(
	"a record too large for the reader is ignored and the next conclusive check replaces it",
	async () => {
		// Given a current-schema record padded past the reader's limit.
		await proveNothingPending();
		const padded = (await readFile(record, "utf8")).padEnd(5000, " ");
		expect(Buffer.byteLength(padded)).toBeGreaterThan(4096);
		await writeFile(record, padded);
		const opened = await olderBackendTabs();
		const ignoring = await Backend.start({ apt: settled("2") });
		await reconnect(ignoring, opened);
		expect(removals(opened)).toEqual([0, 0]);
		await ignoring.check();
		await ignoring.close();
		const after = await Backend.start({ apt: failing(settled("2")) });
		await reconnect(after, opened);
		expect(names(opened)).toEqual([[], []]);
	},
	budget(5),
);

test(
	"the largest record a check can commit is read back at restart",
	async () => {
		const longest = (extra: number) =>
			`2026.${"1".repeat(OFFER_VERSION_LIMIT - 5 + extra)}`;
		const every = (version: string): AptScript => ({
			upgradable: ceralivePackageList.map((name) => ({
				name,
				installed: "1",
				candidate: version,
			})),
		});
		// Given every roster package offered at the longest admitted version, then dismissed.
		const backend = await Backend.start({ apt: every(longest(0)) });
		const [dismissing, other] = await tabs(backend, ["typed", "v2026.7.2"]);
		const missing = await tabs(backend);
		await backend.check();
		const all = [dismissing as Tab, other as Tab, ...missing];
		await sync(all);
		expect(names(all)).toEqual([[NOTICE], [NOTICE], [NOTICE], [NOTICE]]);
		for (const tab of missing) await tab.close();
		await (dismissing as Tab).dismiss(NOTICE);
		await (other as Tab).sync();
		expect((other as Tab).removals()).toBe(1);
		expect((await readFile(record)).byteLength).toBeLessThanOrEqual(4096);
		await backend.close();
		// Then a restart reads it back and still withdraws it from tabs that missed it.
		const restarted = await Backend.start({ apt: every(longest(0)) });
		await reconnect(restarted, missing);
		expect(names(missing)).toEqual([[], []]);
		expect(removals(missing)).toEqual([1, 1]);
		await restarted.close();
		// A version past the limit is not committed: neither shown, removed nor recorded.
		await rm(record);
		const refusing = await Backend.start({ apt: every(longest(1)) });
		const watching = await tabs(refusing);
		await refusing.check();
		await sync(watching);
		expect(histories(watching)).toEqual([[], []]);
		expect(await Bun.file(record).exists()).toBe(false);
	},
	budget(3),
);

test(
	"a verdict that cannot be written changes nothing, in either direction",
	async () => {
		// Given a durable "nothing pending".
		await proveNothingPending();
		// When a newer offer is found but cannot be persisted, nothing is sent.
		const unwritten = await Backend.start({
			apt: pending("2", "3"),
			failWrites: true,
		});
		const watching = await tabs(unwritten);
		await unwritten.check();
		await sync(watching);
		expect(histories(watching)).toEqual([[], []]);
		await unwritten.close();
		// Given the offer is durable and shown.
		const shown = await Backend.start({ apt: pending("2", "3") });
		const opened = await tabs(shown);
		await shown.check();
		await sync(opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await shown.close();
		// When "nothing pending" cannot be persisted, no removal is sent.
		const kept = await Backend.start({ apt: settled("3"), failWrites: true });
		await reconnect(kept, opened);
		await kept.check();
		await sync(opened);
		expect(removals(opened)).toEqual([0, 0]);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await kept.close();
		// And the next process still trusts the durable offer, not the lost verdict.
		const next = await Backend.start({ apt: settled("3") });
		await reconnect(next, opened);
		expect(removals(opened)).toEqual([0, 0]);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(5),
);
