/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend, and a tab can stay open, or be offline, throughout. Each backend
 * below is a real fresh process (helpers/ceralive-update-session.ts) serving the
 * real WebSocket control server over the same device files. Each tab is a real
 * authenticated WebSocket client that keeps what it was shown across restarts
 * and decodes frames like the current and main-era frontends (typed removals)
 * or like v2026.7.2 (bare-name removals only).
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

import {
	OFFER_VERSION_LIMIT,
	readOfferInputs,
} from "../modules/system/ceralive-update-notice.ts";
import { ceralivePackageList } from "../modules/system/package-layer.ts";
import {
	type AptPackage,
	type AptScript,
	CHECKED_MARKER,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RESTART_EXIT_CODE,
	SESSION_PASSWORD,
	scriptedApt,
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
	private constructor(
		private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
		private readonly out: Lines,
		private readonly err: Lines,
		readonly port: number,
	) {}

	static async start(step: Step = {}): Promise<Backend> {
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
					CERALIVE_DISMISSALS_FILE: dismissals,
					CERALIVE_STREAMING_MARKER: join(root, "streaming"),
					CERALIVE_EVENTS_DIR: join(root, "events"),
					DOCKER_HOST: "unix:///nonexistent/docker.sock",
				},
			},
		);
		const out = new Lines(child.stdout);
		const err = new Lines(child.stderr);
		const ready = await within(
			out.next((line) => line.startsWith(READY_PREFIX)),
			"backend ready",
		);
		const backend = new Backend(
			child,
			out,
			err,
			Number(ready.slice(READY_PREFIX.length)),
		);
		live.push(backend);
		return backend;
	}

	async check(): Promise<void> {
		this.child.stdin.write("check\n");
		this.child.stdin.flush();
		await within(
			this.out.next((line) => line === CHECKED_MARKER),
			"check completion",
		);
	}

	// What the package script's restart does to the running backend.
	async close(): Promise<void> {
		this.child.kill("SIGTERM");
		await this.child.exited;
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
	readonly removed: string[] = [];
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
		await this.closed;
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
				this.shown.set(name, { revision, publisher });
			for (const { id } of parsed.data.remove ?? []) this.remove(id);
			return;
		}
		// v2026.7.2: no validation, and `remove` entries go to the store by value.
		const message = frame.notification as {
			show?: { name: string }[];
			remove?: unknown[];
		};
		for (const { name } of message.show ?? []) this.shown.set(name, {});
		for (const entry of message.remove ?? [])
			if (typeof entry === "string") this.remove(entry);
	}

	private remove(name: string): void {
		if (name === NOTICE) this.removed.push(name);
		this.shown.delete(name);
	}
}

const cerastream = (installed: string, candidate = installed): AptPackage => ({
	name: "cerastream",
	installed,
	candidate,
});
// The device's APT state: an offer pending, or installed with nothing pending.
const pending = (installed: string, candidate: string): AptScript => ({
	upgradable: [cerastream(installed, candidate)],
});
const settled = (installed: string): AptScript => ({
	installed: [cerastream(installed)],
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

const names = (opened: readonly Tab[]) => opened.map((tab) => tab.names());

for (const capable of [false, true])
	test(
		`an update's restarts clear the offer in open tabs, live and after a missed proof, and a fresh tab never shows it (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given tabs of both decoders showing the offer before the install.
			const before = await Backend.start({ apt: pending("1", "2"), capable });
			const connected = await tabs(before);
			const missing = await tabs(before);
			await before.check();
			for (const tab of [...connected, ...missing]) await tab.sync();
			expect(names([...connected, ...missing])).toEqual([
				[NOTICE],
				[NOTICE],
				[NOTICE],
				[NOTICE],
			]);
			// When the package script restarts the backend: the new process recovers
			// the finished install and exits through exactly the update's own restart.
			await before.close();
			const recovering = await Backend.start({ apt: settled("2"), capable });
			await reconnect(recovering, connected);
			// An install result is not evidence: the open tabs keep the offer.
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			const restart = await recovering.recover();
			expect(restart.exit).toBe(RESTART_EXIT_CODE);
			expect(restart.stdout).toContain(RECOVERY_RESTART_MARKER);
			expect(restart.stderr).not.toContain(RECOVERY_FAILED_MARKER);
			for (const tab of connected) await tab.dropped();
			// When the completion restart's conclusive check finds nothing pending,
			// the tabs connected to it drop the offer from the live frames.
			const completion = await Backend.start({ apt: settled("2"), capable });
			await reconnect(completion, connected);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			await completion.check();
			for (const tab of connected) await tab.sync();
			expect(names(connected)).toEqual([[], []]);
			await completion.close();
			// Then tabs that missed that process drop it when they re-authenticate to
			// the next one, even though its own refresh fails.
			const next = await Backend.start({ apt: failing(settled("2")), capable });
			await reconnect(next, missing);
			expect(names(missing)).toEqual([[], []]);
			await next.check();
			for (const tab of missing) await tab.sync();
			expect(names(missing)).toEqual([[], []]);
			// And a freshly opened tab never shows it.
			const fresh = await tabs(next);
			expect(names(fresh)).toEqual([[], []]);
		},
		budget(4),
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
			const older = await Backend.start({
				olderBackend: true,
				apt: pending("1", "2"),
			});
			const opened = await tabs(older);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			await older.close();
			// When the package restart recovers the install and the completion process
			// proves nothing pending while both tabs are offline.
			const recovering = await Backend.start({ apt: settled("2"), capable });
			expect((await recovering.recover()).exit).toBe(RESTART_EXIT_CODE);
			const completion = await Backend.start({ apt: settled("2"), capable });
			await completion.check();
			await completion.close();
			// Then the next backend, whose own refresh fails, clears both on re-auth.
			const next = await Backend.start({ apt: failing(settled("2")), capable });
			await reconnect(next, opened);
			expect(names(opened)).toEqual([[], []]);
			expect(opened.map((tab) => tab.removed)).toEqual([[NOTICE], [NOTICE]]);
		},
		budget(4),
	);

test(
	"after a rollback, the offer an older backend shows survives the restored backend",
	async () => {
		// Given a proof that nothing is pending at cerastream 2.
		await (await Backend.start({ apt: pending("1", "2") })).check();
		const proof = await Backend.start({ apt: settled("2") });
		await proof.check();
		await proof.close();
		for (const [label, state] of [
			["downgraded", pending("1", "2")],
			["re-upgraded, newer release published", pending("2", "3")],
		] as const) {
			// When a rollback runs an older backend that shows a valid offer.
			const older = await Backend.start({ olderBackend: true, apt: state });
			const opened = await tabs(older);
			await older.close();
			// And the restored backend restarts before any check, and the tabs re-authenticate.
			const restored = await Backend.start({ apt: state });
			await reconnect(restored, opened);
			// Then both decoders still show it: the recorded proof is for other evidence.
			expect([label, names(opened)]).toEqual([label, [[NOTICE], [NOTICE]]]);
			expect([label, opened.map((tab) => tab.removed)]).toEqual([
				label,
				[[], []],
			]);
			await restored.close();
		}
		// Control: back at exactly the proven state, a tab still showing the offer drops it.
		const older = await Backend.start({
			olderBackend: true,
			apt: pending("1", "2"),
		});
		const opened = await tabs(older);
		await older.close();
		const restored = await Backend.start({ apt: settled("2") });
		await reconnect(restored, opened);
		expect(names(opened)).toEqual([[], []]);
	},
	budget(8),
);

test(
	"a restored older record is ignored under other evidence and never erases a newer offer",
	async () => {
		const proof = await Backend.start({ apt: settled("2") });
		await proof.check();
		await proof.close();
		const stale = await readFile(record, "utf8");
		// Given a newer release found later and shown.
		const newer = await Backend.start({ apt: pending("2", "3") });
		const opened = await tabs(newer);
		await newer.check();
		for (const tab of opened) await tab.sync();
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await newer.close();
		// When the earlier record is restored and a backend starts before any check.
		await writeFile(record, stale);
		const restored = await Backend.start({ apt: pending("2", "3") });
		await reconnect(restored, opened);
		// Then nothing is replayed and the newer offer stays.
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		expect(opened.map((tab) => tab.removed)).toEqual([[], []]);
	},
	budget(3),
);

test(
	"a fresh backend that finds an already-dismissed successor withdraws the predecessor",
	async () => {
		const first = await Backend.start({ apt: pending("1", "2") });
		const connected = await tabs(first);
		const missing = await tabs(first);
		await first.check();
		for (const tab of [...connected, ...missing]) await tab.sync();
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
		for (const tab of connected) await tab.sync();
		expect(names(connected)).toEqual([[], []]);
		await successor.close();
		// Then the withdrawal also reaches tabs that missed it, after a restart.
		const idle = await Backend.start({ apt: pending("1", "3") });
		await reconnect(idle, missing);
		expect(names(missing)).toEqual([[], []]);
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
		for (const tab of [dismissing, other, ...missing])
			await (tab as Tab).sync();
		await (dismissing as Tab).dismiss(NOTICE);
		await (other as Tab).sync();
		expect(names([dismissing as Tab, other as Tab])).toEqual([[], []]);
		await backend.close();
		const restarted = await Backend.start({ apt: pending("1", "2") });
		await reconnect(restarted, missing);
		expect(names(missing)).toEqual([[], []]);
		await restarted.check();
		expect(names(await tabs(restarted))).toEqual([[], []]);
		await restarted.close();
		const newer = await Backend.start({ apt: pending("1", "3") });
		await newer.check();
		expect(names(await tabs(newer))).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(3),
);

test(
	"startup derives nothing without a readable, current-schema record and acknowledgement store",
	async () => {
		const inputs = await readOfferInputs(scriptedApt(settled("2")));
		const valid = { version: 4, inputs, offer: null };
		const refused: Record<string, string> = {
			corrupt: "{",
			prior: JSON.stringify({ ...valid, version: 3 }),
			future: JSON.stringify({ ...valid, version: 5 }),
			duplicate: `{"version":4,"inputs":"${"0".repeat(64)}","offer":null,"inputs":"${inputs}"}`,
			oversized: JSON.stringify(valid).padEnd(5000, " "),
			inputs: JSON.stringify({ ...valid, inputs: "not-a-fingerprint" }),
			forged: JSON.stringify({
				...valid,
				offer: [{ name: "cerastream", version: "2,srtla=3" }],
			}),
		};
		for (const [kind, text] of Object.entries(refused)) {
			await writeFile(record, text);
			const backend = await Backend.start({ apt: settled("2") });
			const older = await Backend.start({ olderBackend: true });
			const opened = await tabs(older);
			await older.close();
			await reconnect(backend, opened);
			expect([kind, names(opened)]).toEqual([kind, [[NOTICE], [NOTICE]]]);
			await backend.close();
		}
		// Control: the same state under a valid record does clear both tabs.
		await writeFile(record, JSON.stringify(valid));
		const older = await Backend.start({ olderBackend: true });
		const opened = await tabs(older);
		await older.close();
		const backend = await Backend.start({ apt: settled("2") });
		await reconnect(backend, opened);
		expect(names(opened)).toEqual([[], []]);
		await backend.close();
		await rm(record);
		// Given an offer whose dismissal state cannot be read.
		const offering = await Backend.start({ apt: pending("1", "2") });
		const holding = await tabs(offering);
		await offering.check();
		for (const tab of holding) await tab.sync();
		await offering.close();
		await mkdir(dismissals);
		const unreadable = await Backend.start({ apt: pending("1", "2") });
		await reconnect(unreadable, holding);
		expect(names(holding)).toEqual([[NOTICE], [NOTICE]]);
		await unreadable.close();
		// A proven absence needs no acknowledgement store, live and on later re-auth.
		const absent = await Backend.start({ apt: settled("2") });
		await reconnect(absent, holding);
		await absent.check();
		for (const tab of holding) await tab.sync();
		expect(names(holding)).toEqual([[], []]);
		await absent.close();
		const late = await tabs(await Backend.start({ olderBackend: true }));
		const after = await Backend.start({ apt: failing(settled("2")) });
		await reconnect(after, late);
		expect(names(late)).toEqual([[], []]);
	},
	budget(24),
);

test(
	"a record too large for the reader is ignored and the next conclusive check replaces it",
	async () => {
		const history = JSON.stringify({
			version: 3,
			offer: null,
			padding: "x".repeat(6000),
		});
		await writeFile(record, history);
		const older = await Backend.start({ olderBackend: true });
		const opened = await tabs(older);
		await older.close();
		const ignoring = await Backend.start({ apt: settled("2") });
		await reconnect(ignoring, opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await ignoring.check();
		await ignoring.close();
		const after = await Backend.start({ apt: failing(settled("2")) });
		await reconnect(after, opened);
		expect(names(opened)).toEqual([[], []]);
	},
	budget(3),
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
		const [dismissing] = await tabs(backend, ["typed"]);
		const missing = await tabs(backend);
		await backend.check();
		for (const tab of [dismissing as Tab, ...missing]) await tab.sync();
		await (dismissing as Tab).dismiss(NOTICE);
		expect((await readFile(record)).byteLength).toBeLessThanOrEqual(4096);
		await backend.close();
		// Then a restart reads it back and still withdraws it from tabs that missed it.
		const restarted = await Backend.start({ apt: every(longest(0)) });
		await reconnect(restarted, missing);
		expect(names(missing)).toEqual([[], []]);
		await restarted.close();
		// A version past the limit is not committed, so it is neither shown nor recorded.
		await rm(record);
		const refusing = await Backend.start({ apt: every(longest(1)) });
		await refusing.check();
		expect(names(await tabs(refusing))).toEqual([[], []]);
		expect(await Bun.file(record).exists()).toBe(false);
	},
	budget(3),
);

test(
	"a verdict that cannot be written changes nothing, in either direction",
	async () => {
		// Given a durable "nothing pending".
		await (await Backend.start({ apt: settled("2") })).check();
		// When a newer offer is found but cannot be persisted, it is not shown.
		const unwritten = await Backend.start({
			apt: pending("2", "3"),
			failWrites: true,
		});
		const watching = await tabs(unwritten);
		await unwritten.check();
		for (const tab of watching) await tab.sync();
		expect(names(watching)).toEqual([[], []]);
		await unwritten.close();
		// Given the offer is durable and shown.
		const shown = await Backend.start({ apt: pending("2", "3") });
		const opened = await tabs(shown);
		await shown.check();
		for (const tab of opened) await tab.sync();
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await shown.close();
		// When "nothing pending" cannot be persisted, the offer is not withdrawn.
		const kept = await Backend.start({ apt: settled("3"), failWrites: true });
		await reconnect(kept, opened);
		await kept.check();
		for (const tab of opened) await tab.sync();
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await kept.close();
		// And the next process still trusts the durable offer, not the lost verdict.
		const next = await Backend.start({ apt: settled("3") });
		await reconnect(next, opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(5),
);
