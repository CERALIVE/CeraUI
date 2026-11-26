/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend, and a tab can stay open, or be offline, throughout. Each backend
 * below is a real fresh process (helpers/ceralive-update-session.ts) serving the
 * real WebSocket control server over the same device files; like production it
 * binds first and hydrates the notice afterwards, and a recovered install runs
 * the real completion path up to the update's own restart. Each tab is a real
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
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";

import { clearEvents, readEvents } from "../modules/events/store.ts";
import {
	ARCH_LIMIT,
	OFFER_VERSION_LIMIT,
} from "../modules/system/ceralive-update-notice.ts";
import { ceralivePackageList } from "../modules/system/package-layer.ts";
import {
	APPLIED_MARKER,
	type AptPackage,
	type AptScript,
	CHECKED_MARKER,
	COMMANDS_PREFIX,
	DEBIAN_ONLY_REFRESH,
	HYDRATED_MARKER,
	INVENTORY,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	REFRESH,
	RESTART_EXIT_CODE,
	SESSION_PASSWORD,
} from "./helpers/ceralive-update-apt.ts";
import type { SessionStep } from "./helpers/ceralive-update-session.ts";
import {
	attained,
	device,
	generate,
	installed,
	type Operation,
	offer,
	shrink,
} from "./helpers/scheduled-notice-model.ts";

const NOTICE = "ceralive_update";
// Bound for one awaited event (a marker, a frame answer, an exit); never a sleep.
const DEADLINE_MS = 30_000;
const budget = (backends: number) => (backends + 2) * DEADLINE_MS;
const SESSION = new URL("./helpers/ceralive-update-session.ts", import.meta.url)
	.pathname;
const MAIN_BACKEND = new URL(
	"./helpers/main-backend-preload.ts",
	import.meta.url,
).pathname;
const SETUP = new URL("../../setup.json", import.meta.url).pathname;

let root: string;
let record: string;
let dismissals: string;
let live: { close(): Promise<void> }[] = [];
const scheduledProofPath = () =>
	join(root, "update-state", "scheduled-package-notices.json");

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
// Each wait takes the first matching line not taken yet, so markers never skip each other.
class Lines {
	private readonly seen: string[] = [];
	private readonly taken = new Set<number>();
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
				(line, index) => !this.taken.has(index) && match(line),
			);
			if (at >= 0) {
				this.taken.add(at);
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
			[
				process.execPath,
				...(step.olderBackend || step.canonicalScheduler
					? ["--preload", MAIN_BACKEND]
					: []),
				step.canonicalScheduler || step.olderBackend
					? SESSION
					: (process.env.CERALIVE_TEST_NOTICE_SESSION ?? SESSION),
				JSON.stringify(input),
			],
			{
				cwd: join(root, "cwd"),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					...(step.canonicalScheduler
						? {
								CERALIVE_TEST_BASELINE:
									"6b9f316c89965c0e13602ca1ad43ec3fcb2b52e1",
							}
						: {}),
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

	async hydrate(): Promise<void> {
		this.send("hydrate");
		await within(
			this.out.next((line) => line === HYDRATED_MARKER),
			"hydration",
		);
	}

	check(): Promise<void> {
		return this.command("check", CHECKED_MARKER, "check completion");
	}

	// Every command the device runner served since the last call.
	async commands(): Promise<string[]> {
		this.send("commands");
		const line = await within(
			this.out.next((text) => text.startsWith(COMMANDS_PREFIX)),
			"command log",
		);
		return JSON.parse(line.slice(COMMANDS_PREFIX.length));
	}

	scheduledPackageCheck(): Promise<void> {
		return this.command(
			"scheduled-package-check",
			CHECKED_MARKER,
			"scheduled package check completion",
		);
	}

	manualPackageCheck(): Promise<void> {
		return this.command(
			"manual-package-check",
			"backend:manual-check:true",
			"manual check completion",
		);
	}

	async startCheckAndCaptureHolds(): Promise<void> {
		await this.command(
			"pause-package-holds",
			"backend:holds-armed",
			"hold barrier armed",
		);
		await this.command(
			"scheduled-package-check",
			"backend:holds-captured",
			"captured apt-mark answer",
		);
	}

	// Holds the scheduled notice's next dpkg read, before it reads or after it answered.
	async startCheckPausedAtDpkgRead(when: "before" | "after"): Promise<void> {
		await this.command(
			`pause-dpkg-read ${when}`,
			"backend:dpkg-read-armed",
			"dpkg read barrier armed",
		);
		await this.command(
			"scheduled-package-check",
			when === "before"
				? "backend:dpkg-read-pending"
				: "backend:dpkg-read-captured",
			"paused dpkg read",
		);
	}

	resumeDpkgRead(): Promise<void> {
		return this.command(
			"resume-dpkg-read",
			CHECKED_MARKER,
			"scheduled package check completion",
		);
	}

	resumePackageHolds(): Promise<void> {
		return this.command(
			"resume-package-holds",
			CHECKED_MARKER,
			"scheduled package check completion",
		);
	}

	private send(text: string): void {
		this.child.stdin.write(`${text}\n`);
		this.child.stdin.flush();
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

	// Recovers a finished install; returns once it reached the update's own restart
	// (which the child holds until `ended`) or the process ended some other way.
	async recover(): Promise<void> {
		this.send("recover");
		const restarting = await within(
			this.out
				.next((line) => line === RECOVERY_RESTART_MARKER)
				.then(
					() => true,
					() => false,
				),
			"recovery",
		);
		// Output that ended without the marker: the process is ending some other way.
		if (!restarting) await within(this.child.exited, "recovery exit");
	}

	// Lets a held restart end the process, and reports how it ended.
	async ended() {
		if (this.child.exitCode === null && this.child.signalCode === null)
			this.send("exit");
		const exit = await within(this.child.exited, "backend exit");
		return { exit, stdout: this.out.text(), stderr: this.err.text() };
	}
}

type Decoder = "typed" | "v2026.7.2";
// The revision and publisher of the copy a tab shows (sent back when it dismisses).
type Copy = { revision?: number | undefined; publisher?: string | undefined };

class Tab {
	// What the tab shows, with the copy's revision and publisher (for dismissal).
	readonly shown = new Map<string, Copy>();
	// Every CeraLive show and removal the tab received, in order.
	readonly history: ("show" | "remove")[] = [];
	// The tracked notices' frames as received (see record()).
	readonly frames: string[] = [];
	readonly removedNames: string[] = [];
	private readonly publishers = new Map<string, string>();
	private readonly revisions = new Map<string, string>();
	private connections = 0;
	private socket: WebSocket | undefined;
	private closed: Promise<void> = Promise.resolve();
	private readonly answers = new Map<string, (frame: unknown) => void>();
	private requests = 0;

	constructor(
		readonly decoder: Decoder,
		private readonly tracks: (name: string) => boolean = (name) =>
			name === NOTICE,
	) {
		live.push(this);
	}

	names(): string[] {
		return [...this.shown.keys()];
	}

	removals(): number {
		return this.history.filter((event) => event === "remove").length;
	}

	async connect(backend: Backend): Promise<void> {
		await this.open(backend);
		await this.authenticate();
	}

	async open(backend: Backend): Promise<void> {
		this.connections++;
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
	}

	async authenticate(): Promise<void> {
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

	async clearEventHistory(): Promise<void> {
		expect(await this.request(["events", "clear"])).toMatchObject({
			result: { success: true },
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
		this.record(frame.notification);
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

	// Only the entries of notices this tab tracks: other owners' re-sends depend on
	// a one-second rate limit, so their frames depend on how fast the steps ran.
	// Publishers and revisions become tokens in order of first sight, so the
	// comparison keeps which copies share a process and a revision, not counters.
	private record(notification: unknown): void {
		if (typeof notification !== "object" || notification === null) return;
		const { show, remove, replay } = notification as Record<string, unknown>;
		const entries = (value: unknown) => (Array.isArray(value) ? value : []);
		const idOf = (entry: unknown) =>
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && "id" in entry
					? entry.id
					: undefined;
		const nameOf = (entry: unknown) =>
			typeof entry === "object" && entry !== null && "name" in entry
				? entry.name
				: undefined;
		const tracked = (name: unknown) =>
			typeof name === "string" && this.tracks(name);
		const shown = entries(show).filter((entry) => tracked(nameOf(entry)));
		const removed = entries(remove).filter((entry) => tracked(idOf(entry)));
		if (shown.length + removed.length === 0) return;
		const token = (map: Map<string, string>, prefix: string, key: string) => {
			if (!map.has(key)) map.set(key, `${prefix}${map.size}`);
			return map.get(key);
		};
		// A connection reaches one process: its revisions are that process's.
		const revision = (entry: object) =>
			"revision" in entry
				? {
						revision: token(
							this.revisions,
							"R",
							`${this.connections}:${String(entry.revision)}`,
						),
					}
				: {};
		const publisher = (entry: object) =>
			"publisher" in entry
				? { publisher: token(this.publishers, "P", String(entry.publisher)) }
				: {};
		const normalized = (entry: unknown) =>
			typeof entry === "object" && entry !== null
				? { ...entry, ...revision(entry), ...publisher(entry) }
				: entry;
		this.frames.push(
			JSON.stringify({
				...(shown.length > 0 ? { show: shown.map(normalized) } : {}),
				...(removed.length > 0 ? { remove: removed.map(normalized) } : {}),
				...(replay === undefined ? {} : { replay }),
			}),
		);
	}

	private show(name: string, copy: Copy) {
		if (this.tracks(name)) this.history.push("show");
		this.shown.set(name, copy);
	}

	private remove(name: string): void {
		if (this.tracks(name)) {
			this.history.push("remove");
			this.removedNames.push(name);
		}
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
// Mid-transaction: the package script restarted the backend while cerastream is configured.
const configuring = (installed: string): AptScript => ({
	...settled(installed),
	dpkgStatus: { cerastream: "iF " },
});
const offered = (version: string) => ({
	version: 8,
	offer: [{ name: "cerastream", arch: "arm64", version }],
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

// Tabs that show the offer main's own backend raised in its own check (no record written).
const noticePrefix = "update:updates-available:";
const scheduledNotice = (name: string) =>
	name.startsWith(noticePrefix) &&
	!name.startsWith("update:updates-available:os:");

const scheduledNames = (opened: readonly Tab[]) =>
	names(opened).map((items) => items.filter(scheduledNotice));
const scheduledTabs = () => [
	new Tab("typed", scheduledNotice),
	new Tab("v2026.7.2", scheduledNotice),
];
const bootPackage: AptPackage = {
	name: "linux-image-7.2.0-ceralive-rk3588",
	installed: "7.2.0",
	candidate: "7.2.0",
};

// One step of a differential sequence; each ends with a scheduled check and a sync of every tab.
type Act = {
	readonly apt: AptScript;
	// First, the first pair's typed tab dismisses its newest scheduled copy.
	readonly dismiss?: true;
	// First, the backend restarts (tabs keep their copies) as the next process of the run.
	readonly restart?: true;
	// First, another pair of tabs authenticates.
	readonly join?: true;
};
// What every tab shows after a step, and every notification frame it received during it.
type Observed = { readonly names: string[][]; readonly frames: string[][] };

// The same steps on main's scheduler, on this branch, main then (after a restart)
// this branch, or this branch, main, this branch again (each restart switches).
async function playScheduled(
	capable: boolean,
	acts: readonly Act[],
	run: "main" | "head" | "upgrade" | "rollback",
): Promise<Observed[]> {
	// Each run starts as a fresh device: no dismissal, offer record or receipt from the other.
	await Promise.all(
		[dismissals, record, scheduledProofPath(), join(root, "events")].map(
			(path) => rm(path, { recursive: true, force: true }),
		),
	);
	let main = run === "main" || run === "upgrade";
	let backend = await Backend.start({ capable, canonicalScheduler: main });
	const opened = scheduledTabs();
	await reconnect(backend, opened);
	const observed: Observed[] = [];
	for (const act of acts) {
		const before = new Map(opened.map((tab) => [tab, tab.frames.length]));
		if (act.restart) {
			await backend.close();
			await Promise.all(opened.map((tab) => tab.dropped()));
			if (run === "upgrade") main = false;
			if (run === "rollback") main = !main;
			backend = await Backend.start({ capable, canonicalScheduler: main });
			await reconnect(backend, opened);
		}
		await backend.setApt(act.apt);
		if (act.join) {
			const pair = scheduledTabs();
			await reconnect(backend, pair);
			opened.push(...pair);
		}
		if (act.dismiss) {
			const [typed] = opened;
			const newest = typed?.names().filter(scheduledNotice).at(-1);
			if (newest) await typed?.dismiss(newest);
		}
		await backend.scheduledPackageCheck();
		await sync(opened);
		observed.push({
			names: scheduledNames(opened),
			frames: opened.map((tab) => tab.frames.slice(before.get(tab) ?? 0)),
		});
	}
	await backend.close();
	await Promise.all(opened.map((tab) => tab.dropped()));
	return observed;
}

const srtlaOffer = cerastream("1:1.0~rc1", "1:1.0+build2", { name: "srtla" });
const tzdata: AptPackage = {
	name: "tzdata",
	source: "debian",
	installed: "1",
	candidate: "2",
};
const detachedRefresh = REFRESH.replace(
	"Hit:1 https://deb.debian.org/debian-security trixie-security InRelease",
	"Ign:1 https://deb.debian.org/debian-security trixie-security InRelease\nHit:3 https://deb.debian.org/debian-security trixie-security Release",
);
const offerOnly: AptScript = { upgradable: [srtlaOffer] };
const unreadableCandidate: AptScript = {
	...offerOnly,
	fail: { "package-policy": "silent-exit-1" },
};
// Announce-only sequences: the offer stays pending throughout, so nothing may be withdrawn.
const differential: readonly {
	readonly label: string;
	readonly acts: readonly Act[];
	readonly run?: "upgrade" | "rollback";
	readonly legacyOnly?: true;
}[] = [
	{
		label:
			"a refresh that falls back to a detached Release, a reconnect and a late tab",
		acts: [
			{ apt: offerOnly },
			{ apt: { ...offerOnly, refresh: { stdout: detachedRefresh } } },
			{ apt: offerOnly, restart: true },
			{ apt: offerOnly, join: true },
			{ apt: offerOnly },
		],
	},
	{
		label: "the displayed list grows by a held kept-back package",
		acts: [
			{ apt: offerOnly },
			{ apt: { ...offerOnly, keptBack: [tzdata], holds: [tzdata.name] } },
			{ apt: { ...offerOnly, keptBack: [tzdata] } },
		],
	},
	{
		label: "held, kept-back, unfinished, foreign, NEW and boot-held neighbours",
		acts: [
			{ apt: offerOnly },
			{
				apt: {
					...offerOnly,
					installed: [cerastream("2")],
					holds: ["cerastream"],
				},
			},
			{ apt: { ...offerOnly, keptBack: [cerastream("1", "2")] } },
			{
				apt: {
					...offerOnly,
					installed: [tzdata],
					dpkgStatus: { tzdata: "iF " },
				},
			},
			{
				apt: {
					upgradable: [
						srtlaOffer,
						{ ...tzdata, name: "libc6:armhf", arch: "armhf" },
					],
				},
			},
			{
				apt: {
					upgradable: [
						srtlaOffer,
						cerastream("(none)", "2", { name: "modemmanager" }),
					],
				},
			},
			{
				apt: {
					...offerOnly,
					holds: [bootPackage.name],
					installed: [bootPackage],
				},
			},
		],
	},
	{
		label: "removals and downgrades in the plan",
		acts: [
			{ apt: offerOnly },
			{ apt: { ...offerOnly, removed: [tzdata] } },
			{
				apt: {
					...offerOnly,
					downgraded: [{ ...tzdata, installed: "2", candidate: "1" }],
				},
			},
			{ apt: offerOnly },
		],
	},
	{
		label: "an epoch, tilde and plus candidate goes lower and back",
		acts: [
			{ apt: offerOnly },
			{ apt: { upgradable: [{ ...srtlaOffer, candidate: "1:1.0" }] } },
			{ apt: offerOnly },
		],
	},
	{
		label: "dismissed, then an unreadable candidate, then a changed display",
		acts: [
			{ apt: offerOnly },
			{ apt: offerOnly, dismiss: true },
			{ apt: unreadableCandidate },
			{ apt: { ...offerOnly, keptBack: [tzdata] } },
		],
	},
	{
		label: "a candidate read that fails and recovers",
		acts: [
			{ apt: offerOnly },
			{ apt: unreadableCandidate },
			{ apt: offerOnly },
			{ apt: { ...offerOnly, records: { srtla: "Package: srtla\n" } } },
			{ apt: offerOnly },
			{ apt: offerOnly, restart: true },
		],
	},
	{
		label: "tabs kept open across the upgrade from main",
		run: "upgrade",
		acts: [
			{ apt: offerOnly },
			{ apt: offerOnly, restart: true },
			{ apt: offerOnly },
		],
	},
	{
		label:
			"size estimate failing, partial, answering with an error exit, or timing out after an install",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			...[
				{ exitCode: 100, stdout: "", stderr: "E: size unavailable\n" },
				{ stdout: "Reading package lists...\n" },
				{
					exitCode: 100,
					stderr: "E: Sub-process /usr/bin/dpkg returned an error code (1)\n",
				},
				{
					exitCode: 124,
					stdout: "Reading package lists...\nBuilding dependency tree...\n",
					stderr: "timed out\n",
				},
				{},
			].map((fallback) => ({
				apt: { ...settled("2"), keptBack: [tzdata], fallback },
			})),
		],
	},
	{
		label:
			"a failed size estimate after an installed release, a newer dismissed release and late tabs",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: settled("2") },
			{ apt: pending("2", "3") },
			{ apt: pending("2", "3"), dismiss: true },
			...[1, 2].map(() => ({
				apt: {
					...settled("3"),
					keptBack: [tzdata],
					fallback: {
						exitCode: 100,
						stdout: "",
						stderr: "E: size unavailable\n",
					},
				},
				join: true as const,
			})),
		],
	},
	{
		label:
			"a refresh missing a configured source, cut short, failing or falling back after an install",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{
				apt: {
					...settled("2"),
					refresh: { stdout: REFRESH.split("\n").slice(1).join("\n") },
				},
			},
			{
				apt: {
					...settled("2"),
					refresh: { stdout: `${REFRESH.split("\n")[0]}\n` },
				},
			},
			{ apt: failing(settled("2")) },
			{ apt: { ...settled("2"), refresh: { stdout: detachedRefresh } } },
			{ apt: settled("2") },
		],
	},
	{
		label: "a rollback to main and a new upgrade with tabs kept open",
		legacyOnly: true,
		run: "rollback",
		acts: [
			{ apt: pending("1", "2") },
			{ apt: pending("2", "3"), restart: true },
			{ apt: settled("2"), restart: true },
			{ apt: settled("2") },
		],
	},
	{
		label:
			"the same display set across versions, installed, then offered again",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: pending("2", "3") },
			{ apt: settled("3") },
			{ apt: pending("3", "4") },
		],
	},
	{
		label: "a dismissal across restarts with the same and a newer candidate",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: pending("1", "2"), dismiss: true },
			{ apt: pending("1", "2"), restart: true },
			{ apt: pending("1", "3") },
			{ apt: pending("1", "3"), restart: true },
		],
	},
	{
		label: "a lower, then a newer candidate",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "3") },
			{ apt: pending("1", "2.5") },
			{ apt: pending("1", "4") },
		],
	},
	{
		label: "an unparseable or missing candidate record",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{
				apt: {
					...pending("1", "2"),
					records: {
						cerastream: "Package: cerastream\nVersion: not-a-version\n",
					},
				},
			},
			{ apt: { ...pending("1", "2"), policyFails: ["cerastream"] } },
			{ apt: pending("1", "2") },
		],
	},
	{
		label:
			"an install proven while late tabs log in, with a stock boot hold and a kept-back neighbour",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: settled("2"), join: true },
			{ apt: { ...settled("2"), keptBack: [tzdata] } },
			{
				apt: {
					holds: [bootPackage.name],
					installed: [bootPackage, cerastream("2+b1")],
				},
			},
		],
	},
	{
		label:
			"two versions, then installed while dpkg is held, below, half-configured or unpacked",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: pending("2", "3") },
			{ apt: { ...settled("3"), holds: ["cerastream"] } },
			{ apt: settled("1") },
			{ apt: { ...settled("3"), dpkgStatus: { cerastream: "iF " } } },
			{ apt: { ...settled("3"), dpkgStatus: { cerastream: "iU " } } },
			{ apt: settled("3") },
		],
	},
	{
		label: "two offers, one held before the proof",
		legacyOnly: true,
		acts: [
			{ apt: { upgradable: [cerastream("1", "2"), srtlaOffer] } },
			{ apt: { upgradable: [srtlaOffer], installed: [cerastream("2")] } },
			{
				apt: {
					installed: [
						cerastream("2"),
						{ ...srtlaOffer, installed: srtlaOffer.candidate },
					],
					holds: ["cerastream"],
				},
			},
		],
	},
	{
		label: "a newer version after a dismissal, then a restart",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			{ apt: pending("2", "3") },
			{ apt: settled("2") },
			{ apt: pending("2", "3"), dismiss: true },
			{ apt: pending("2", "4") },
			{ apt: pending("2", "4"), restart: true },
		],
	},
	{
		label: "an installed offer while the optional size estimate keeps failing",
		legacyOnly: true,
		acts: [
			{ apt: pending("1", "2") },
			...[1, 2, 3].map(() => ({
				apt: {
					...settled("2"),
					keptBack: [tzdata],
					fallback: {
						exitCode: 100,
						stdout: "",
						stderr: "E: size unavailable\n",
					},
				},
			})),
		],
	},
];

for (const capable of [false, true])
	for (const { label, acts, run, legacyOnly } of differential)
		if (!capable || !legacyOnly)
			test(
				`scheduled package notice frames match main's exactly (${capable ? "capable" : "legacy"}, ${label})`,
				async () => {
					const main = await playScheduled(capable, acts, "main");
					// The sequence exercises main's notice at all before it is compared.
					expect(
						main.some(({ names }) => names.some((ids) => ids.length > 0)),
					).toBe(true);
					expect(await playScheduled(capable, acts, run ?? "head")).toEqual(
						main,
					);
				},
				budget(2 * (1 + acts.filter((act) => act.restart).length)),
			);

class ModelMismatch extends Error {
	constructor(
		readonly invariant: string,
		step: Operation,
		actual: unknown,
		expected: unknown,
	) {
		super(
			`${invariant} after ${JSON.stringify(step)}: ${JSON.stringify({ actual, expected })}`,
		);
	}
}

const packageNotice = `${noticePrefix}cerastream=2`;
const cleanTrace = async () => {
	await Promise.all(
		[dismissals, record, scheduledProofPath(), join(root, "events")].map(
			(path) => rm(path, { recursive: true, force: true }),
		),
	);
};

async function runModel(capable: boolean, trace: readonly Operation[]) {
	await cleanTrace();
	const early = scheduledTabs();
	const roaming = scheduledTabs();
	const all = [...early, ...roaming];
	const known = capable ? packageNotice : `${noticePrefix}cerastream=unknown`;
	let backend = await Backend.start({ capable });
	let baseline = false;
	let link: "closed" | "open" | "authed" = "closed";
	let recorded = false;
	try {
		await reconnect(backend, early);
		for (const step of trace) {
			const seen = all.map((tab) => tab.removedNames.length);
			let expected: string | undefined;
			switch (step.kind) {
				case "check":
					await backend.setApt(device(step.fact));
					await backend.scheduledPackageCheck();
					// This fixture has one possible issue name. Learn only whether it
					// was issued, not the verdict, from the real announcement.
					recorded ||= early.some((tab) => tab.shown.has(known));
					if (capable && !baseline && recorded && attained(step.fact))
						expected = known;
					break;
				case "restart":
					await backend.close();
					await Promise.all(all.map((tab) => tab.dropped()));
					baseline = step.main;
					backend = await Backend.start({
						capable,
						canonicalScheduler: baseline,
					});
					await reconnect(backend, early);
					if (link === "authed") await reconnect(backend, roaming);
					if (link === "open")
						await Promise.all(roaming.map((tab) => tab.open(backend)));
					break;
				case "open":
					if (link === "closed") {
						await Promise.all(roaming.map((tab) => tab.open(backend)));
						link = "open";
					}
					break;
				case "auth":
					if (link === "open") {
						await Promise.all(roaming.map((tab) => tab.authenticate()));
						link = "authed";
					}
					break;
				case "disconnect":
					await Promise.all(roaming.map((tab) => tab.close()));
					link = "closed";
					break;
				case "dismiss":
					if (early[0]?.shown.has(known)) await early[0].dismiss(known);
					break;
			}
			await sync(link === "authed" ? all : early);
			if (step.kind === "dismiss") continue; // Main's explicit user action.
			for (const [index, tab] of all.entries()) {
				const received = tab.removedNames.slice(seen[index]);
				const delivered =
					expected && (index < early.length || link === "authed")
						? [expected]
						: [];
				if (JSON.stringify(received) !== JSON.stringify(delivered))
					throw new ModelMismatch(
						received.length ? "wrong withdrawal" : "missed withdrawal",
						step,
						received,
						delivered,
					);
				if (delivered.length && tab.shown.has(known))
					throw new ModelMismatch(
						"copy survives remove",
						step,
						tab.names(),
						[],
					);
			}
		}
	} finally {
		await backend.close();
		await Promise.all(all.map((tab) => tab.dropped()));
	}
}

const seeds = (
	process.env.CERALIVE_NOTICE_SEEDS ?? "0x684001,0x80d48c7a,0xc0ffee"
)
	.split(",")
	.map(Number);
for (const capable of [true, false])
	for (const seed of seeds)
		test(
			`scheduled notice model (${capable ? "capable" : "legacy"}, seed ${seed.toString(16)})`,
			async () => {
				const trace = generate(seed);
				try {
					await runModel(capable, trace);
				} catch (error) {
					if (!(error instanceof ModelMismatch)) throw error;
					const minimal =
						process.env.CERALIVE_NOTICE_SHRINK === "1"
							? await shrink(trace, async (candidate) => {
									try {
										await runModel(capable, candidate);
										return false;
									} catch (next) {
										if (!(next instanceof ModelMismatch)) throw next;
										return (
											next.invariant === error.invariant &&
											next.message === error.message
										);
									}
								})
							: trace;
					throw new Error(
						`${error.message}\nseed=${seed} trace=${JSON.stringify(minimal)}`,
					);
				}
			},
			budget(20),
		);

// The only commands the withdrawal adds to a check, all reads.
const proofRead = (command: string) =>
	command === "dpkg --print-architecture" ||
	command.startsWith("dpkg-query -W -f=");

async function commandLog(capable: boolean, main: boolean) {
	await cleanTrace();
	const backend = await Backend.start({ capable, canonicalScheduler: main });
	const opened = scheduledTabs();
	await reconnect(backend, opened);
	const log: string[][] = [];
	for (const apt of [pending("1", "2"), settled("2"), settled("3")]) {
		await scheduledStep(backend, apt, opened);
		log.push(await backend.commands());
	}
	await backend.close();
	await Promise.all(opened.map((tab) => tab.dropped()));
	return log;
}

for (const capable of [false, true])
	test(
		`scheduled package notice runs main's commands, plus only trailing dpkg reads on a capable image (${capable ? "capable" : "legacy"})`,
		async () => {
			const main = await commandLog(capable, true);
			const head = await commandLog(capable, false);
			if (!capable) {
				expect(head).toEqual(main);
				return;
			}
			const added = head.map((step, index) => {
				const before = main[index] ?? [];
				expect(step.slice(0, before.length)).toEqual(before);
				return step.slice(before.length);
			});
			expect(added.flat().every(proofRead)).toBe(true);
			// The pending check reads nothing; the installed one reads dpkg.
			expect(added[0]).toEqual([]);
			expect(added[1]?.[0]).toBe("dpkg --print-architecture");
		},
		budget(2),
	);

async function scheduledStep(
	backend: Backend,
	apt: AptScript,
	opened: readonly Tab[],
) {
	await backend.setApt(apt);
	await backend.scheduledPackageCheck();
	await sync(opened);
}

// The reported bug: the scheduled notice outlives a recovered install of its offer.
test(
	"scheduled notice outliving a recovered install clears only at the next check",
	async () => {
		const offering = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		await reconnect(offering, opened);
		await scheduledStep(offering, pending("1", "2"), opened);
		expect(scheduledNames(opened)).toEqual([[packageNotice], [packageNotice]]);
		// The package script restarts the backend mid-transaction.
		await offering.close();
		await Promise.all(opened.map((tab) => tab.dropped()));
		const recovering = await Backend.start({
			capable: true,
			apt: configuring("2"),
		});
		await reconnect(recovering, opened);
		await recovering.setApt(settled("2"));
		await recovering.recover();
		expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
		await Promise.all(opened.map((tab) => tab.dropped()));
		// Neither restart nor login withdraws anything.
		const restarted = await Backend.start({ capable: true, apt: settled("2") });
		await reconnect(restarted, opened);
		expect(scheduledNames(opened)).toEqual([[packageNotice], [packageNotice]]);
		expect(removals(opened)).toEqual([0, 0]);
		await scheduledStep(restarted, settled("2"), opened);
		expect(opened.map((tab) => tab.removedNames)).toEqual([
			[packageNotice],
			[packageNotice],
		]);
		expect(scheduledNames(opened)).toEqual([[], []]);
		const late = scheduledTabs();
		await reconnect(restarted, late);
		expect(scheduledNames(late)).toEqual([[], []]);
	},
	budget(3),
);

const debianCurl: AptPackage = {
	name: "curl",
	installed: "1",
	candidate: "2",
	source: "debian",
};
const reinstalledCurl = `${noticePrefix}curl=2`;
const combinedNotice = `${noticePrefix}cerastream=2,curl=2`;
const narrowOffer: AptScript = {
	upgradable: [offer, debianCurl],
	inventory: INVENTORY.replace("o=Debian,", "o=Unknown,"),
};
const wideOffer: AptScript = { upgradable: [offer, debianCurl] };
const largeOffer = (): AptPackage[] => [
	offer,
	...Array.from({ length: 42 }, (_, index) => ({
		...debianCurl,
		name: `scheduled-restart-fixture-package-${index}`,
		candidate:
			index === 41 ? "1.2.3.4" : index === 40 ? "1+v2.public.fixture" : "2",
	})),
];

test(
	"a large scheduled offer survives restart and retires only at its exact installed versions",
	async () => {
		const packages = largeOffer();
		const rows = packages.map(({ name, candidate }) => `${name}=${candidate}`);
		expect(rows.join(",").length).toBeGreaterThan(1024);
		const offerText = rows.sort().join(",");
		const initial = await Backend.start({ capable: true });
		const retained = scheduledTabs();
		await reconnect(initial, retained);
		await scheduledStep(initial, { upgradable: packages }, retained);
		const shown = scheduledNames(retained);
		const hash = new Bun.CryptoHasher("sha256").update(offerText);
		const digest = hash.digest("hex");
		const id = `sha256:${digest.match(/.{8}/g)?.join("-")}`;
		const name = `${noticePrefix}${id}`;
		expect(shown).toEqual([[name], [name]]);
		const proof = scheduledProofPath();
		const saved = await readFile(proof, "utf8");
		expect(JSON.parse(saved)).toEqual({
			schema: 1,
			offers: [{ id, offer: offerText }],
		});
		expect((await stat(proof)).mode & 0o777).toBe(0o600);
		expect(
			readEvents({ baseDir: join(root, "events") })
				.filter((event) => event.code === "update_updates_available")
				.map((event) => event.params),
		).toEqual([{ id }]);
		await initial.close();
		await Promise.all(retained.map((tab) => tab.dropped()));

		const restarted = await Backend.start({ capable: true });
		await reconnect(restarted, retained);
		expect(scheduledNames(retained)).toEqual(shown);
		expect(retained.map((tab) => tab.removedNames)).toEqual([[], []]);
		const exact = packages.map((pkg) => ({ ...pkg, installed: pkg.candidate }));
		const skipped = exact.map((pkg, index) =>
			index === exact.length - 1
				? { ...pkg, installed: "3", candidate: "3" }
				: pkg,
		);
		const query = `dpkg-query -W -f=\${Package}\\t\${Architecture}\\t\${db:Status-Abbrev}\\t\${Version}\\n -- ${rows
			.map((row) => row.split("=")[0])
			.join(" ")}`;
		const unknown = exact
			.map(({ name, installed }, index) =>
				index === exact.length - 1
					? `${name}\tarm64\tun \t\n`
					: `${name}\tarm64\tii \t${installed}\n`,
			)
			.join("");
		for (const apt of [
			{ installed: skipped },
			{ installed: exact, proof: { "dpkg-query": { stdout: unknown } } },
		]) {
			await scheduledStep(restarted, apt, retained);
			expect((await restarted.commands()).filter(proofRead)).toEqual([
				"dpkg --print-architecture",
				query,
			]);
			expect(scheduledNames(retained)).toEqual(shown);
			expect(retained.map((tab) => tab.removedNames)).toEqual([[], []]);
		}

		const keepsWithoutProof = async (installed: readonly AptPackage[]) => {
			await scheduledStep(restarted, { installed }, retained);
			expect((await restarted.commands()).filter(proofRead)).toEqual([]);
			expect(retained.map((tab) => tab.removedNames)).toEqual([[], []]);
			expect(scheduledNames(retained)).toEqual(shown);
		};

		const altered = skipped
			.map(({ name, candidate }) => `${name}=${candidate}`)
			.sort()
			.join(",");
		const mismatched = JSON.stringify({
			schema: 1,
			offers: [{ id, offer: altered }],
		});
		// Matching dpkg rows for an altered roster cannot remove the original name.
		await writeFile(proof, mismatched);
		await keepsWithoutProof(skipped);
		expect(await readFile(proof, "utf8")).toBe(mismatched);

		await writeFile(proof, "{");
		await keepsWithoutProof(exact);
		expect(await readFile(proof, "utf8")).toBe("{");

		// A non-regular path cannot be read as proof, even by privileged test runners.
		const parked = `${proof}.fixture`;
		await rename(proof, parked);
		await keepsWithoutProof(exact);
		await mkdir(proof);
		await keepsWithoutProof(exact);
		expect((await stat(proof)).isDirectory()).toBe(true);
		await rmdir(proof);
		await rename(parked, proof);
		await writeFile(proof, saved);

		await scheduledStep(restarted, { installed: exact }, retained);
		expect(retained.map((tab) => tab.removedNames)).toEqual(shown);
		expect(scheduledNames(retained)).toEqual([[], []]);
	},
	budget(2),
);

test(
	"clearing event history removes restart candidates without exposing or changing private offer state",
	async () => {
		const packages = largeOffer();
		const initial = await Backend.start({ capable: true });
		const retained = scheduledTabs();
		await reconnect(initial, retained);
		await scheduledStep(initial, { upgradable: packages }, retained);
		await scheduledStep(initial, pending("1", "2"), retained);
		const shown = scheduledNames(retained);
		expect(shown[0]).toHaveLength(2);
		expect(shown[1]).toEqual(shown[0]);
		const proof = scheduledProofPath();
		const saved = await readFile(proof, "utf8");
		await initial.close();
		await Promise.all(retained.map((tab) => tab.dropped()));

		const baseDir = join(root, "events");
		expect(clearEvents({ baseDir })).toBe(true);
		expect(readEvents({ baseDir })).toEqual([]);
		expect(await readFile(proof, "utf8")).toBe(saved);

		const restarted = await Backend.start({ capable: true });
		await reconnect(restarted, retained);
		const installed = packages.map((pkg) => ({
			...pkg,
			installed: pkg.candidate,
		}));
		await scheduledStep(restarted, { installed }, retained);
		expect((await restarted.commands()).filter(proofRead)).toEqual([]);
		expect(retained.map((tab) => tab.removedNames)).toEqual([[], []]);
		expect(scheduledNames(retained)).toEqual(shown);
	},
	budget(2),
);

for (const [kind, restart, compact] of [
	["historical inline", true, false],
	["historical compact", true, true],
	["live compact", false, true],
] as const) {
	test(
		`clearing event history during captured dpkg proof (${kind} scheduled notice)`,
		async () => {
			const packages = compact ? largeOffer() : [offer];
			let backend = await Backend.start({ capable: true });
			const opened = scheduledTabs();
			const [clearingTab] = opened;
			if (!clearingTab) throw new Error("missing clearing tab");
			await reconnect(backend, opened);
			await scheduledStep(backend, { upgradable: packages }, opened);
			const shown = scheduledNames(opened);
			expect(shown[0]).toHaveLength(1);
			expect(shown[1]).toEqual(shown[0]);

			if (restart) {
				await backend.close();
				await Promise.all(opened.map((tab) => tab.dropped()));
				backend = await Backend.start({ capable: true });
				await reconnect(backend, opened);
				expect(scheduledNames(opened)).toEqual(shown);
			}

			await backend.setApt({
				installed: packages.map((pkg) => ({
					...pkg,
					installed: pkg.candidate,
				})),
			});
			await backend.startCheckPausedAtDpkgRead("after");
			// Use the real RPC in the process whose in-memory clear generation matters.
			await clearingTab.clearEventHistory();
			expect(readEvents({ baseDir: join(root, "events") })).toEqual([]);
			await backend.resumeDpkgRead();
			await sync(opened);

			expect(opened.map((tab) => tab.removedNames)).toEqual(
				restart ? [[], []] : shown,
			);
			expect(scheduledNames(opened)).toEqual(restart ? shown : [[], []]);
		},
		budget(restart ? 2 : 1),
	);
}

test(
	"scheduled notice keeps both copies when different dpkg reads prove different members",
	async () => {
		const main = await Backend.start({
			capable: true,
			canonicalScheduler: true,
		});
		const opened = scheduledTabs();
		await reconnect(main, opened);
		await scheduledStep(main, wideOffer, opened);
		expect(scheduledNames(opened)).toEqual(opened.map(() => [combinedNotice]));
		await main.close();
		await Promise.all(opened.map((tab) => tab.dropped()));

		const current = await Backend.start({ capable: true });
		await reconnect(current, opened);
		const state = (first: string, second: string): AptScript => ({
			installed: [
				cerastream(first, first),
				{ ...debianCurl, installed: second, candidate: second },
			],
		});
		const partial = [state("2", "3"), state("3", "2")];
		for (const answer of partial) {
			await current.setApt(state("2", "2"));
			await current.startCheckPausedAtDpkgRead("before");
			await current.setApt(answer);
			await current.resumeDpkgRead();
			await sync(opened);
			expect(opened.map((tab) => tab.removedNames)).toEqual([[], []]);
			expect(scheduledNames(opened)).toEqual(
				opened.map(() => [combinedNotice]),
			);
		}
		await scheduledStep(current, state("2", "2"), opened);
		expect(opened.map((tab) => tab.removedNames)).toEqual(
			opened.map(() => [combinedNotice]),
		);
		expect(scheduledNames(opened)).toEqual([[], []]);
	},
	budget(2),
);

test(
	"scheduled notice keeps both copies when a manual check finds a reinstall during proof",
	async () => {
		const backend = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		await reconnect(backend, opened);
		await scheduledStep(backend, device("pending"), opened);
		expect(scheduledNames(opened)).toEqual(opened.map(() => [packageNotice]));

		await backend.setApt(device("installed"));
		await backend.startCheckPausedAtDpkgRead("after");
		await backend.setApt(device("reinstall"));
		await backend.manualPackageCheck();
		await backend.resumeDpkgRead();
		await sync(opened);
		expect(opened.map((tab) => tab.removedNames)).toEqual([[], []]);
		expect(scheduledNames(opened)).toEqual(opened.map(() => [packageNotice]));
		await scheduledStep(backend, device("installed"), opened);
		expect(scheduledNames(opened)).toEqual([[], []]);
	},
	budget(1),
);

for (const trajectory of ["rollback", "old-index fallback"] as const)
	test(
		`scheduled notice never removes a still-unmet member after same-id ${trajectory}`,
		async () => {
			const retained = scheduledTabs();
			const fresh = scheduledTabs();
			const wideFirst = trajectory === "rollback";
			const boot = await Backend.start({
				capable: true,
				canonicalScheduler: wideFirst,
			});
			await reconnect(boot, retained);
			await scheduledStep(boot, wideFirst ? wideOffer : narrowOffer, retained);
			expect(scheduledNames(retained)).toEqual([
				[combinedNotice],
				[combinedNotice],
			]);
			await boot.close();
			await Promise.all(retained.map((tab) => tab.dropped()));
			const other = await Backend.start({ capable: true });
			const audience = wideFirst ? fresh : [...retained, ...fresh];
			await reconnect(other, audience);
			await scheduledStep(
				other,
				wideFirst
					? narrowOffer
					: {
							...wideOffer,
							refresh: {
								stderr:
									"W: Some index files failed to download. They have been ignored, or old ones used instead.\n",
							},
						},
				audience,
			);
			expect(scheduledNames(fresh)).toEqual([
				[combinedNotice],
				[combinedNotice],
			]);
			await other.close();
			await Promise.all(audience.map((tab) => tab.dropped()));
			const last = await Backend.start({ capable: true });
			const all = [...retained, ...fresh];
			await reconnect(last, all);
			await scheduledStep(
				last,
				{ installed: [installed, { ...debianCurl, candidate: "1" }] },
				all,
			);
			expect(all.map((tab) => tab.removedNames)).toEqual([[], [], [], []]);
			expect(scheduledNames(all)).toEqual(all.map(() => [combinedNotice]));
		},
		budget(3),
	);

test(
	"scheduled notice requires all dpkg lines, clean status, and exact versions",
	async () => {
		const backend = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		await reconnect(backend, opened);
		await scheduledStep(backend, wideOffer, opened);
		expect(scheduledNames(opened)).toEqual([
			[combinedNotice],
			[combinedNotice],
		]);
		const done = { installed: [installed, { ...debianCurl, installed: "2" }] };
		const curled = "curl\tarm64\tii \t2\n";
		const lines = `cerastream\tarm64\tii \t2\n${curled}`;
		const negatives: readonly AptScript[] = [
			...Array.from({ length: lines.length }, (_, end) => ({
				...done,
				proof: { "dpkg-query": { stdout: lines.slice(0, end) } },
			})),
			{
				...done,
				proof: {
					"dpkg-query": { stderr: "dpkg-query: warning: incomplete read\n" },
				},
			},
			{ ...done, proof: { "dpkg-query": { exitCode: 1 } } },
			{ ...done, proof: { "dpkg-query": { stdout: `${lines}${curled}` } } },
			{ ...done, proof: { "dpkg-query": { stdout: `${lines}malformed\n` } } },
			{
				...done,
				proof: {
					"dpkg-query": { stdout: lines.replace("curl\tarm64", "curl\tarmhf") },
				},
			},
			{ ...done, fail: { "dpkg-query": "timeout" } },
			{ ...done, fail: { "dpkg-query": "launch" } },
			{ ...done, fail: { "dpkg-query": "signal" } },
			{ ...done, holds: ["curl"] },
			{ ...done, dpkgStatus: { curl: "iU " } },
			{ ...done, dpkgStatus: { curl: "iF " } },
			{ installed: [installed, { ...debianCurl, installed: "3" }] },
			{ ...done, fail: { "dpkg-native": "silent-exit-1" } },
			{
				...done,
				upgradable: [{ ...debianCurl, installed: "2" }],
				installed: [installed],
			},
		];
		for (const [index, apt] of negatives.entries()) {
			await scheduledStep(backend, apt, opened);
			expect({
				index,
				removals: opened.map((tab) => tab.removedNames),
			}).toEqual({ index, removals: [[], []] });
		}
		// D4: no conclusion is drawn from absence in discovery, holds or inventory,
		// and an unrelated kept-back package vetoes nothing (round 2).
		await scheduledStep(
			backend,
			{
				...done,
				keptBack: [tzdata],
				refresh: { stderr: "W: Duplicate target Packages in sources list\n" },
				proof: { "apt-mark": { stdout: "unrelated-hold\n" } },
			},
			opened,
		);
		// The reinstall row above raised curl=2 on its own; it is attained too.
		expect(opened.map((tab) => [...tab.removedNames].sort())).toEqual(
			opened.map(() => [combinedNotice, reinstalledCurl].sort()),
		);
	},
	budget(2),
);

test(
	"scheduled notice uses dpkg's hold at the proof boundary, not the earlier apt-mark snapshot",
	async () => {
		const backend = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		await reconnect(backend, opened);
		await scheduledStep(backend, device("pending"), opened);
		await backend.setApt(device("installed"));
		await backend.startCheckAndCaptureHolds();
		await backend.setApt(device("held"));
		const late = scheduledTabs();
		await reconnect(backend, late);
		const all = [...opened, ...late];
		await backend.resumePackageHolds();
		await sync(all);
		expect(all.map((tab) => tab.removedNames)).toEqual([[], [], [], []]);
		expect(scheduledNames(all)).toEqual(all.map(() => [packageNotice]));
		await scheduledStep(backend, device("installed"), all);
		expect(scheduledNames(all)).toEqual([[], [], [], []]);
	},
	budget(1),
);

test(
	"scheduled notice catches up following a missed exact withdrawal but keeps a skipped version",
	async () => {
		const initial = await Backend.start({
			capable: true,
			canonicalScheduler: true,
		});
		const retained = scheduledTabs();
		await reconnect(initial, retained);
		const old = `${noticePrefix}cerastream=1:1.0~rc1`;
		const newer = `${noticePrefix}cerastream=1:1.0+build2`;
		const versions = ["1:1.0~rc1", "1:1.0+build2"] as const;
		for (const version of versions)
			await scheduledStep(initial, pending("1", version), retained);
		expect(scheduledNames(retained)).toEqual(retained.map(() => [old, newer]));
		await initial.close();
		await Promise.all(retained.map((tab) => tab.dropped()));
		const backend = await Backend.start({ capable: true });
		const early = scheduledTabs();
		await reconnect(backend, early);
		await scheduledStep(backend, settled(versions[1]), early);
		expect(early.map((tab) => tab.removedNames)).toEqual(
			early.map(() => [newer]),
		);
		await reconnect(backend, retained);
		expect(scheduledNames(retained)).toEqual(retained.map(() => [old, newer]));
		await scheduledStep(backend, settled(versions[1]), [...early, ...retained]);
		expect(scheduledNames(retained)).toEqual(retained.map(() => [old]));
	},
	budget(2),
);

test(
	"scheduled notice keeps a bare package's reinstall but accepts its installed all architecture",
	async () => {
		const backend = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		await reconnect(backend, opened);
		await scheduledStep(backend, device("pending"), opened);
		const allArch = { ...installed, arch: "all" };
		await scheduledStep(backend, { upgradable: [allArch] }, opened);
		expect(opened.map((tab) => tab.removedNames)).toEqual([[], []]);
		await scheduledStep(backend, { installed: [allArch] }, opened);
		expect(opened.map((tab) => tab.removedNames)).toEqual([
			[packageNotice],
			[packageNotice],
		]);
		await scheduledStep(backend, device("pending"), opened);
		await scheduledStep(backend, device("pending"), opened);
		expect(histories(opened)).toEqual(
			opened.map(() => ["show", "remove", "show"]),
		);
	},
	budget(1),
);

test(
	"scheduled notice fences a dismissal while allowing a late login to replay until proof",
	async () => {
		const backend = await Backend.start({ capable: true });
		const opened = scheduledTabs();
		const late = scheduledTabs();
		await reconnect(backend, opened);
		await scheduledStep(backend, device("pending"), opened);
		await backend.setApt(device("installed"));
		await backend.startCheckPausedAtDpkgRead("before");
		await reconnect(backend, late);
		expect(scheduledNames(late)).toEqual(late.map(() => [packageNotice]));
		await opened[0]?.dismiss(packageNotice);
		await backend.resumeDpkgRead();
		const all = [...opened, ...late];
		await sync(all);
		// Main's user dismissal is typed-only; there is no automatic bare removal yet.
		expect(all.map((tab) => tab.removedNames)).toEqual([
			[packageNotice],
			[],
			[packageNotice],
			[],
		]);
		await scheduledStep(backend, device("pending"), all);
		expect(histories(all)).toEqual([
			["show", "remove"],
			["show"],
			["show", "remove"],
			["show"],
		]);
		await scheduledStep(backend, device("installed"), all);
		expect(scheduledNames(all)).toEqual([[], [], [], []]);
	},
	budget(1),
);

async function olderBackendTabs(
	state: AptScript = pending("1", "2"),
	capable = false,
) {
	const older = await Backend.start({
		olderBackend: true,
		apt: state,
		capable,
	});
	const opened = await tabs(older);
	await older.check();
	await sync(opened);
	expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
	await older.close();
	return opened;
}

// A conclusive check's "nothing pending" at cerastream 2, recorded by a real check.
async function proveNothingPending(
	state: AptScript = settled("2"),
	capable = false,
) {
	const proof = await Backend.start({ apt: state, capable });
	await proof.check();
	await proof.close();
}

// A real install of cerastream 2: a check shows and records the offer, the package
// script restarts the backend mid-transaction, and the new process recovers the
// finished install, which dpkg proves, up to the update's own restart. The record
// still names the offer, for that restart to read dpkg again.
async function installProof(capable = false) {
	const offering = await Backend.start({ apt: pending("1", "2"), capable });
	await offering.check();
	await offering.close();
	const recovering = await Backend.start({
		apt: configuring("2"),
		capable,
	});
	await recovering.setApt(settled("2"));
	await recovering.recover();
	expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
	expect(JSON.parse(await readFile(record, "utf8"))).toEqual(offered("2"));
}

for (const capable of [false, true])
	test(
		`an install's own restarts clear the offer in open tabs at the first conclusive check, live and after a missed process, and a fresh tab never shows it (${capable ? "capable" : "legacy"} image)`,
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
			// When the package script restarts the backend mid-transaction, the new process
			// announces nothing: only its own conclusive check may write the slot.
			await before.close();
			const recovering = await Backend.start({
				apt: configuring("2"),
				capable,
			});
			await reconnect(recovering, connected);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(connected)).toEqual([0, 0]);
			// And it recovers the finished install. It never showed the offer, so it cannot know
			// which release a connected tab holds: those tabs keep their copy through its restart.
			await recovering.setApt(settled("2"));
			await recovering.recover();
			await sync(connected);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(connected)).toEqual([0, 0]);
			const restart = await recovering.ended();
			expect(restart.exit).toBe(RESTART_EXIT_CODE);
			expect(restart.stdout).toContain(RECOVERY_RESTART_MARKER);
			expect(restart.stderr).not.toContain(RECOVERY_FAILED_MARKER);
			for (const tab of connected) await tab.dropped();
			// Then the update's own restart announces nothing, tells no tab at login (a copy may be
			// another release's), and a failing refresh changes nothing.
			const completion = await Backend.start({
				apt: failing(settled("2")),
				capable,
			});
			await reconnect(completion, missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([0, 0]);
			await reconnect(completion, connected);
			expect(removals(connected)).toEqual([0, 0]);
			await completion.check();
			await sync([...missing, ...connected]);
			expect(removals([...missing, ...connected])).toEqual([0, 0, 0, 0]);
			// And a freshly opened tab is shown nothing.
			const fresh = await tabs(completion);
			expect(histories(fresh)).toEqual([[], []]);
			// When that process's conclusive check finds nothing pending, dpkg showing the offer
			// installed, every connected tab drops it live; a later login is told nothing.
			await completion.setApt(settled("2"));
			await completion.check();
			await sync([...missing, ...connected, ...fresh]);
			expect(names([...missing, ...connected])).toEqual([[], [], [], []]);
			expect(removals([...missing, ...connected])).toEqual([1, 1, 1, 1]);
			expect(removals(fresh)).toEqual([1, 1]);
			expect(histories(await tabs(completion))).toEqual([[], []]);
			// When a newer release appears, it is shown and nothing removes it.
			await completion.setApt(pending("2", "3"));
			await completion.check();
			await sync(missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([1, 1]);
			await completion.close();
			// And a restart that runs no check announces nothing and removes nothing; its check shows it.
			const idle = await Backend.start({ apt: pending("2", "3"), capable });
			await reconnect(idle, missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([1, 1]);
			const later = await tabs(idle);
			expect(histories(later)).toEqual([[], []]);
			await idle.check();
			await sync(later);
			expect(histories(later)).toEqual([["show"], ["show"]]);
		},
		budget(5),
	);

test(
	"a recovery that fails is never taken for the update's restart",
	async () => {
		const backend = await Backend.start({ recoverFails: true });
		await backend.recover();
		const failed = await backend.ended();
		expect(failed.exit).not.toBe(RESTART_EXIT_CODE);
		expect(failed.stdout).not.toContain(RECOVERY_RESTART_MARKER);
		expect(failed.stderr).toContain(RECOVERY_FAILED_MARKER);
	},
	budget(1),
);

for (const capable of [false, true])
	test(
		`an update from a backend before this notice is cleared by the first conclusive check, in the tabs connected to it (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given main's own backend, whose own check showed its offer in main-era and v2026.7.2
			// tabs; it recorded nothing.
			const connected = await olderBackendTabs(pending("1", "2"), capable);
			const missing = await olderBackendTabs(pending("1", "2"), capable);
			// When the package restart recovers the install while two tabs are connected.
			const recovering = await Backend.start({ apt: settled("2"), capable });
			await reconnect(recovering, connected);
			await recovering.recover();
			await sync(connected);
			// Then no recorded offer means nothing to prove: nothing is removed through the restart.
			expect(removals(connected)).toEqual([0, 0]);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			const restart = await recovering.ended();
			expect(restart.exit).toBe(RESTART_EXIT_CODE);
			expect(restart.stdout).toContain(RECOVERY_RESTART_MARKER);
			for (const tab of connected) await tab.dropped();
			// When the next process's check concludes nothing is pending, connected tabs drop it.
			const completion = await Backend.start({ apt: settled("2"), capable });
			await reconnect(completion, connected);
			expect(removals(connected)).toEqual([0, 0]);
			await completion.check();
			await sync(connected);
			expect(names(connected)).toEqual([[], []]);
			expect(removals(connected)).toEqual([1, 1]);
			// And a tab that logs in to that process afterwards is not told; its next complete
			// check while the tab is connected tells it.
			const late = await olderBackendTabs(pending("1", "2"), capable);
			await reconnect(completion, late);
			expect(names(late)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(late)).toEqual([0, 0]);
			await completion.check();
			await sync(late);
			expect(names(late)).toEqual([[], []]);
			expect(removals(late)).toEqual([1, 1]);
			await completion.close();
			// A tab offline throughout is not told by a later process: a check's verdict is its process's own.
			const next = await Backend.start({ apt: failing(settled("2")), capable });
			await reconnect(next, missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([0, 0]);
			// Until a conclusive check while it is connected.
			await next.setApt(settled("2"));
			await next.check();
			await sync(missing);
			expect(names(missing)).toEqual([[], []]);
			expect(removals(missing)).toEqual([1, 1]);
		},
		budget(7),
	);

test(
	"after a rollback, the offer an older backend shows survives the restored backend",
	async () => {
		for (const [label, state] of [
			["downgraded", pending("1", "2")],
			["re-upgraded, newer release published", pending("2", "3")],
		] as const) {
			// Given an install proven, and the update's own restart's conclusive check recording none.
			await installProof();
			const completion = await Backend.start({ apt: settled("2") });
			await completion.check();
			await completion.close();
			expect([label, JSON.parse(await readFile(record, "utf8"))]).toEqual([
				label,
				{ version: 8, offer: null },
			]);
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
		// Control: after an install's proof, the next process's conclusive check clears a tab still
		// showing the offer (its login alone is no authority over that copy).
		await installProof();
		const opened = await olderBackendTabs();
		const successor = await Backend.start({ apt: settled("2") });
		await reconnect(successor, opened);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await successor.check();
		await sync(opened);
		expect(names(opened)).toEqual([[], []]);
	},
	budget(18),
);

test(
	"an install that ended before the recovering process read dpkg is not re-announced there; a tab offline for its whole life waits for a conclusive check",
	async () => {
		const offering = await Backend.start({ apt: pending("1", "2") });
		const missing = await tabs(offering);
		await offering.check();
		await sync(missing);
		await offering.close();
		// When the recovering process starts after the transaction ended, its startup read proves
		// the offer: it is not re-announced and nothing is written or removed.
		const recovering = await Backend.start({ apt: settled("2") });
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual(offered("2"));
		const connected = await olderBackendTabs();
		await reconnect(recovering, connected);
		expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(connected)).toEqual([0, 0]);
		expect(histories(await tabs(recovering))).toEqual([[], []]);
		await recovering.recover();
		expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
		// Then a tab offline until now keeps it at the update's own restart, whose refresh fails.
		const completion = await Backend.start({ apt: failing(settled("2")) });
		await reconnect(completion, missing);
		expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(missing)).toEqual([0, 0]);
		// Until that process's conclusive check.
		await completion.setApt(settled("2"));
		await completion.check();
		await sync(missing);
		expect(names(missing)).toEqual([[], []]);
	},
	budget(5),
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
		// Given a check while cerastream 2 was held back: the kept-back plan is not conclusive.
		const held: AptScript = {
			keptBack: [cerastream("1", "2")],
			holds: ["cerastream"],
		};
		await proveNothingPending(held);
		expect(await Bun.file(record).exists()).toBe(false);
		// The "none" an earlier design recorded then.
		const stale = JSON.stringify({ version: 8, offer: null });
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

const curl: AptPackage = {
	name: "curl",
	installed: "8.1",
	candidate: "8.2",
	source: "debian",
};

for (const capable of [false, true])
	test(
		`a changed install plan with unchanged installed versions is new evidence: nothing replays (${capable ? "capable" : "legacy"} image)`,
		async () => {
			const dependency: AptPackage = {
				name: "ceralive-modem-support",
				installed: "(none)",
				candidate: "2026.1",
			};
			// Given a verdict taken while a roster dependency was only available, not planned.
			await proveNothingPending(
				{ ...settled("2"), available: [dependency] },
				capable,
			);
			const opened = await olderBackendTabs(pending("1", "2"), capable);
			// When an out-of-roster upgrade now pulls it into the plan, every roster version unchanged.
			const restarted = await Backend.start({
				apt: { ...settled("2"), upgradable: [curl, dependency] },
				capable,
			});
			await reconnect(restarted, opened);
			// Then neither decoder is told to remove the offer.
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
		},
		budget(4),
	);

test(
	"a record edited to claim none never removes the offer",
	async () => {
		// Given the real record of an offer, edited to claim "none".
		const offering = await Backend.start({ apt: pending("1", "2") });
		await offering.check();
		await offering.close();
		const real = JSON.parse(await readFile(record, "utf8"));
		expect(real).toEqual(offered("2"));
		await writeFile(record, JSON.stringify({ ...real, offer: null }));
		const opened = await olderBackendTabs();
		// When a backend starts under exactly that evidence.
		const restarted = await Backend.start({ apt: pending("1", "2") });
		await reconnect(restarted, opened);
		// Then the edited withdrawal reaches neither decoder.
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(opened)).toEqual([0, 0]);
	},
	budget(4),
);

test(
	"a conclusive check's withdrawal stops reaching tabs once a check records a newer offer",
	async () => {
		await installProof();
		const first = await olderBackendTabs();
		const second = await olderBackendTabs();
		const backend = await Backend.start({ apt: settled("2") });
		// An install's proof alone tells a reconnecting tab nothing.
		await reconnect(backend, first);
		expect(names(first)).toEqual([[NOTICE], [NOTICE]]);
		// While this process's conclusive "none" stands, a reconnecting tab is told.
		await backend.check();
		await reconnect(backend, first);
		expect(names(first)).toEqual([[], []]);
		// When a check then finds a newer release, connected tabs are shown it.
		await backend.setApt(pending("2", "3"));
		await backend.check();
		await sync(first);
		expect(names(first)).toEqual([[NOTICE], [NOTICE]]);
		// Then a tab that reconnects afterwards keeps it: no removal reaches it.
		await reconnect(backend, second);
		expect(names(second)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(second)).toEqual([0, 0]);
	},
	budget(6),
);

test(
	"tabs that authenticate before hydration see nothing wrong, then the right outcome",
	async () => {
		await installProof();
		// An install's proof: early tabs get no frame until hydration, and none from it after,
		// then the removal from that process's conclusive check.
		const early = await olderBackendTabs();
		const matching = await Backend.start(
			{ apt: settled("2") },
			{ hydrate: false },
		);
		await reconnect(matching, early);
		expect(histories(early)).toEqual([["show"], ["show"]]);
		await matching.hydrate();
		await sync(early);
		expect(histories(early)).toEqual([["show"], ["show"]]);
		await matching.check();
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
		await restored.close();
		// A stored offer: early tabs see nothing before or after hydration, then its check's show.
		const offering = await Backend.start({ apt: pending("1", "2") });
		await offering.check();
		await offering.close();
		const announcing = await Backend.start(
			{ apt: pending("1", "2") },
			{ hydrate: false },
		);
		const waiting = await tabs(announcing);
		expect(histories(waiting)).toEqual([[], []]);
		await announcing.hydrate();
		await sync(waiting);
		expect(histories(waiting)).toEqual([[], []]);
		await announcing.check();
		await sync(waiting);
		expect(histories(waiting)).toEqual([["show"], ["show"]]);
	},
	budget(10),
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
				entries: [{ key: "update:cerastream:arm64=3", dismissedAt: 1 }],
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
		// Then a restart alone neither shows the dismissed release nor removes another copy;
		// its own conclusive check finds the dismissed release and tells tabs that missed it.
		const idle = await Backend.start({ apt: pending("1", "3") });
		await reconnect(idle, missing);
		expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(missing)).toEqual([0, 0]);
		await idle.check();
		await sync(missing);
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
		expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
		expect(removals(missing)).toEqual([0, 0]);
		await restarted.check();
		await sync(missing);
		expect(names(missing)).toEqual([[], []]);
		expect(removals(missing)).toEqual([1, 1]);
		expect(histories(await tabs(restarted))).toEqual([[], []]);
		await restarted.close();
		const newer = await Backend.start({ apt: pending("1", "3") });
		await newer.check();
		expect(names(await tabs(newer))).toEqual([[NOTICE], [NOTICE]]);
	},
	budget(3),
);

test(
	"an install's proof reaches missed tabs only through a conclusive check of the process they log in to",
	async () => {
		const first = await Backend.start({ apt: pending("1", "2") });
		const groups = [await tabs(first), await tabs(first)];
		await first.check();
		await sync(groups.flat());
		await first.close();
		const recovering = await Backend.start({ apt: configuring("2") });
		await recovering.setApt(settled("2"));
		await recovering.recover();
		expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
		for (const [index, group] of groups.entries()) {
			const restarted = await Backend.start({ apt: failing(settled("2")) });
			await reconnect(restarted, group);
			// No restart tells a tab at login what the update's own proof showed.
			expect([index, names(group), removals(group)]).toEqual([
				index,
				[[NOTICE], [NOTICE]],
				[0, 0],
			]);
			// Each process's own conclusive check clears the tabs connected to it.
			await restarted.setApt(settled("2"));
			await restarted.check();
			await sync(group);
			expect([index, names(group)]).toEqual([index, [[], []]]);
			expect([index, removals(group)]).toEqual([index, [1, 1]]);
			await restarted.close();
		}
	},
	budget(6),
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
		// The real record of an installed offer, then refused variants of it under the same evidence.
		await installProof();
		const valid = JSON.parse(await readFile(record, "utf8"));
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [{ key: "update:cerastream:arm64=2,srtla=3", dismissedAt: 1 }],
			}),
		);
		const forged = [
			{ name: "cerastream", arch: "arm64", version: "2,srtla=3" },
		];
		const bare = [{ name: "cerastream", version: "2" }];
		const refused: Record<string, string> = {
			corrupt: "{",
			"prior v2": JSON.stringify({ version: 2, offer: [], withdrawn: [] }),
			"prior v3": JSON.stringify({ ...valid, version: 3 }),
			"prior v4": JSON.stringify({ ...valid, version: 4 }),
			"prior v5": JSON.stringify({ ...valid, version: 5 }),
			"prior v6": JSON.stringify({
				version: 6,
				inputs: "0".repeat(64),
				offer: null,
			}),
			"prior v7 offer": JSON.stringify({ version: 7, offer: bare }),
			"prior v7 proof": JSON.stringify({
				version: 7,
				offer: null,
				installed: bare,
			}),
			future: JSON.stringify({ ...valid, version: 9 }),
			duplicate: `{"version":8,"offer":null,"offer":${JSON.stringify(valid.offer)}}`,
			oversized: JSON.stringify(valid).padEnd(5000, " "),
			inputs: JSON.stringify({ ...valid, inputs: "not-a-fingerprint" }),
			"a proof member": JSON.stringify({ ...valid, installed: valid.offer }),
			"an offer without its architecture": JSON.stringify({
				version: 8,
				offer: bare,
			}),
			"empty offer": JSON.stringify({ ...valid, offer: [] }),
			// A forged multi-package key, whose acknowledgement is present, cannot be smuggled in.
			forged: JSON.stringify({ version: 8, offer: forged }),
		};
		// Under a still-pending offer: a refused record is neither re-announced nor acted on.
		for (const [kind, text] of Object.entries(refused)) {
			await writeFile(record, text);
			const opened = await olderBackendTabs();
			const backend = await Backend.start({ apt: pending("1", "2") });
			await reconnect(backend, opened);
			expect([kind, names(opened), removals(opened)]).toEqual([
				kind,
				[[NOTICE], [NOTICE]],
				[0, 0],
			]);
			expect([kind, histories(await tabs(backend))]).toEqual([kind, [[], []]]);
			await backend.close();
		}
		// Control: the record is read. Under a check that finds nothing pending while dpkg shows
		// cerastream 1, a refused record holds no offer, so "none" withdraws; the valid record's
		// offer of 2 is not installed, so it stays.
		for (const [kind, text, expected] of [
			["corrupt", "{", [[], []]],
			["valid", JSON.stringify(valid), [[NOTICE], [NOTICE]]],
		] as const) {
			await writeFile(record, text);
			const control = await olderBackendTabs();
			const backend = await Backend.start({ apt: settled("1") });
			await reconnect(backend, control);
			expect([kind, removals(control)]).toEqual([kind, [0, 0]]);
			await backend.check();
			await sync(control);
			expect([kind, names(control)]).toEqual([
				kind,
				expected.map((pair) => [...pair]),
			]);
			await backend.close();
		}
		await rm(record);
		await rm(dismissals);
		// Main's own backend shows these before the acknowledgement store becomes unreadable
		// (its keyed notice waits for a readable store).
		const late = await olderBackendTabs();
		const later = await olderBackendTabs();
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
		// A proven absence needs no acknowledgement store, live.
		const absent = await Backend.start({ apt: settled("3") });
		await reconnect(absent, holding);
		await absent.check();
		await sync(holding);
		expect(names(holding)).toEqual([[], []]);
		await absent.close();
		// Nor is a later login told (an install's proof alone tells it nothing, and nor does a
		// complete check's none): only that check's live removal, while the tab is connected.
		await installProof();
		const after = await Backend.start({ apt: failing(settled("2")) });
		await reconnect(after, late);
		expect(names(late)).toEqual([[NOTICE], [NOTICE]]);
		await after.setApt(settled("2"));
		await after.check();
		await reconnect(after, later);
		expect(names(later)).toEqual([[NOTICE], [NOTICE]]);
		await after.check();
		await sync(later);
		expect(names(later)).toEqual([[], []]);
	},
	budget(44),
);

test(
	"a record too large for the reader is ignored and the next conclusive check replaces it",
	async () => {
		// Given a current-schema record of an installed offer, padded past the reader's limit.
		await installProof();
		const padded = (await readFile(record, "utf8")).padEnd(5000, " ");
		expect(Buffer.byteLength(padded)).toBeGreaterThan(4096);
		await writeFile(record, padded);
		const opened = await olderBackendTabs();
		const ignoring = await Backend.start({ apt: settled("2") });
		await reconnect(ignoring, opened);
		expect(removals(opened)).toEqual([0, 0]);
		await ignoring.check();
		await sync(opened);
		expect(names(opened)).toEqual([[], []]);
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
			version: 8,
			offer: null,
		});
	},
	budget(5),
);

test(
	"the largest record a check can commit is read back at restart, and read back against dpkg",
	async () => {
		const longest = (extra: number) =>
			`2026.${"1".repeat(OFFER_VERSION_LIMIT - 5 + extra)}`;
		// The longest architecture a record admits, on every package.
		const arch = "a".repeat(ARCH_LIMIT);
		const every = (installed: string, candidate: string): AptScript => ({
			upgradable: ceralivePackageList.map((name) => ({
				name,
				installed,
				candidate,
				arch,
			})),
		});
		const installedEvery = (version: string): AptScript => ({
			installed: ceralivePackageList.map((name) => ({
				name,
				installed: version,
				candidate: version,
				arch,
			})),
		});
		// Given every roster package offered at the longest admitted version, then dismissed.
		const backend = await Backend.start({ apt: every("1", longest(0)) });
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
		const largest = await readFile(record, "utf8");
		expect(JSON.parse(largest).offer).toHaveLength(ceralivePackageList.length);
		expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(4096);
		await backend.close();
		// Then a restart reads it back: it neither shows the dismissed release nor removes another
		// copy, and its own conclusive check of that release withdraws it from tabs that missed it.
		const restarted = await Backend.start({ apt: every("1", longest(0)) });
		await reconnect(restarted, missing);
		expect(removals(missing)).toEqual([0, 0]);
		await restarted.check();
		await sync(missing);
		expect(names(missing)).toEqual([[], []]);
		expect(removals(missing)).toEqual([1, 1]);
		await restarted.close();
		// And once the whole offer is installed, the next start's dpkg readback of it keeps it from
		// being re-announced, and that process's conclusive check proves it gone everywhere.
		const late = await olderBackendTabs();
		const successor = await Backend.start({
			apt: installedEvery(longest(0)),
		});
		await reconnect(successor, late);
		expect(names(late)).toEqual([[NOTICE], [NOTICE]]);
		await successor.check();
		await sync(late);
		expect(names(late)).toEqual([[], []]);
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
			version: 8,
			offer: null,
		});
		await successor.close();
		// A version past the limit is not committed: neither shown, removed nor recorded.
		await rm(record);
		const refusing = await Backend.start({ apt: every("1", longest(1)) });
		const watching = await tabs(refusing);
		await refusing.check();
		await sync(watching);
		expect(histories(watching)).toEqual([[], []]);
		expect(await Bun.file(record).exists()).toBe(false);
	},
	budget(6),
);

test(
	"a verdict that cannot be written changes nothing, in any direction; an install's own result needs no write",
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
		const durable = await readFile(record, "utf8");
		// When neither the startup readback's "none" nor a check's can be persisted, no removal is sent.
		const kept = await Backend.start({ apt: settled("3"), failWrites: true });
		await reconnect(kept, opened);
		await kept.check();
		await sync(opened);
		expect(removals(opened)).toEqual([0, 0]);
		expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
		await kept.close();
		// When an install of the offer finishes in a process that cannot write: its own check found
		// exactly the durable offer (nothing to write), so it shows it, and the install's own
		// proof removes it live; nothing is written.
		const installing = await Backend.start({
			apt: pending("2", "3"),
			failWrites: true,
		});
		await reconnect(installing, opened);
		await installing.check();
		await installing.setApt(settled("3"));
		await installing.recover();
		await sync(opened);
		expect(names(opened)).toEqual([[], []]);
		expect(removals(opened)).toEqual([1, 1]);
		expect((await installing.ended()).exit).toBe(RESTART_EXIT_CODE);
		for (const tab of opened) await tab.dropped();
		expect(await readFile(record, "utf8")).toBe(durable);
		// And a restart that still cannot write tells a fresh tab nothing at all.
		const unwritable = await Backend.start({
			apt: settled("3"),
			failWrites: true,
		});
		expect(histories(await tabs(unwritable))).toEqual([[], []]);
		await unwritable.close();
		// Then the first process whose conclusive check can record "none" tells the tabs that missed it.
		const next = await Backend.start({ apt: settled("3") });
		const missed = await olderBackendTabs();
		await reconnect(next, missed);
		expect(names(missed)).toEqual([[NOTICE], [NOTICE]]);
		await next.check();
		await sync(missed);
		expect(names(missed)).toEqual([[], []]);
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
			version: 8,
			offer: null,
		});
	},
	budget(9),
);

for (const capable of [false, true]) {
	const image = capable ? "capable" : "legacy";

	test(
		`a stored offer dpkg shows installed proves nothing about another backend's newer offer (${image} image)`,
		async () => {
			// Given release 2 recorded by this backend, then installed by an older one that records nothing.
			const offering = await Backend.start({ apt: pending("1", "2"), capable });
			await offering.check();
			await offering.close();
			// And that older backend shows release 3 in both decoders.
			const opened = await olderBackendTabs(pending("2", "3"), capable);
			// When this backend starts: dpkg shows the stored release 2 installed, which says nothing about 3.
			const restored = await Backend.start({ apt: pending("2", "3"), capable });
			await reconnect(restored, opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
			// Then its own conclusive check shows release 3, and still nothing removed it.
			await restored.check();
			await sync(opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
		},
		budget(3),
	);

	test(
		`a dismissed stored offer removes nothing another backend shows at startup (${image} image)`,
		async () => {
			// Given release 2 recorded and dismissed, still pending.
			const offering = await Backend.start({ apt: pending("1", "2"), capable });
			await offering.check();
			await offering.close();
			await writeFile(
				dismissals,
				JSON.stringify({
					version: 1,
					entries: [{ key: "update:cerastream:arm64=2", dismissedAt: 1 }],
				}),
			);
			// And an older backend shows release 3 in both decoders.
			const opened = await olderBackendTabs(pending("1", "3"), capable);
			// When this backend starts, the dismissal of 2 is no authority over that copy.
			const restored = await Backend.start({ apt: pending("1", "3"), capable });
			await reconnect(restored, opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
			// Then its conclusive check finds release 3, which was never dismissed, and shows it.
			await restored.check();
			await sync(opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
		},
		budget(3),
	);

	test(
		`a tab that logs in after the update's own proof, even after a rollback, is not told by it (${image} image)`,
		async () => {
			// Given a process whose own check showed the offer to its tabs, which then finishes the install.
			const recovering = await Backend.start({
				apt: pending("1", "2"),
				capable,
			});
			const connected = await tabs(recovering);
			await recovering.check();
			await sync(connected);
			expect(names(connected)).toEqual([[NOTICE], [NOTICE]]);
			await recovering.setApt(settled("2"));
			await recovering.recover();
			await sync(connected);
			// The tabs this process showed the offer to drop it.
			expect(names(connected)).toEqual([[], []]);
			expect(removals(connected)).toEqual([1, 1]);
			// When cerastream is rolled back before another tab logs in, that tab keeps its copy.
			await recovering.setApt(pending("1", "2"));
			const late = await olderBackendTabs(pending("1", "2"), capable);
			await reconnect(recovering, late);
			expect(names(late)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(late)).toEqual([0, 0]);
			expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
		},
		budget(4),
	);

	test(
		`a refresh that never reached CeraLive's index is no check that nothing is pending (${image} image)`,
		async () => {
			// Given main's backend showing its offer; nothing was recorded.
			const opened = await olderBackendTabs(pending("1", "2"), capable);
			// When a clean refresh reaches only Debian and the cached lists still list CeraLive with nothing pending.
			const backend = await Backend.start({
				apt: { ...settled("2"), refresh: { stdout: DEBIAN_ONLY_REFRESH } },
				capable,
			});
			await reconnect(backend, opened);
			await backend.check();
			await sync(opened);
			// Then neither decoder loses the banner.
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(opened)).toEqual([0, 0]);
			// Control: the same process's check after a refresh that reached CeraLive clears both.
			await backend.setApt(settled("2"));
			await backend.check();
			await sync(opened);
			expect(names(opened)).toEqual([[], []]);
			expect(removals(opened)).toEqual([1, 1]);
		},
		budget(3),
	);

	test(
		`an offered package held back beside an unrelated upgrade keeps the offer (${image} image)`,
		async () => {
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(backend);
			await backend.check();
			await sync(opened);
			expect(names(opened)).toEqual([[NOTICE], [NOTICE]]);
			// When cerastream is held at 1 and only an unrelated upgrade is pending.
			await backend.setApt({
				keptBack: [cerastream("1", "2")],
				holds: ["cerastream"],
				upgradable: [curl],
			});
			await backend.check();
			await sync(opened);
			// (A capable image refuses a held first-party package and says so in its own notice.)
			expect(opened.map((tab) => tab.shown.has(NOTICE))).toEqual([true, true]);
			expect(removals(opened)).toEqual([0, 0]);
			// Control: once the offered version is installed, the next conclusive check clears it.
			await backend.setApt({ ...settled("2"), upgradable: [curl] });
			await backend.check();
			await sync(opened);
			expect(opened.map((tab) => tab.shown.has(NOTICE))).toEqual([
				false,
				false,
			]);
		},
		budget(2),
	);
}

for (const capable of [false, true]) {
	const image = capable ? "capable" : "legacy";
	const holdsNotice = (opened: readonly Tab[]) =>
		opened.map((tab) => tab.shown.has(NOTICE));

	test(
		`a stored older offer never overwrites another backend's newer copy during recovery (${image} image)`,
		async () => {
			// Given release 2 recorded, then an older backend showing release 3 in both decoders.
			const offering = await Backend.start({ apt: pending("1", "2"), capable });
			await offering.check();
			await offering.close();
			const opened = await olderBackendTabs(pending("1", "3"), capable);
			// When the package script restarts this backend while cerastream 2 is configured.
			const recovering = await Backend.start({
				apt: configuring("2"),
				capable,
			});
			await reconnect(recovering, opened);
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			// And the install of 2 finishes while 3 is still pending.
			await recovering.setApt(pending("2", "3"));
			await recovering.recover();
			await sync(opened);
			// Then release 3's copy was neither replaced nor removed.
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			expect((await recovering.ended()).exit).toBe(RESTART_EXIT_CODE);
		},
		budget(4),
	);

	test(
		`a later check that is not conclusive voids the earlier "none" for tabs that reconnect (${image} image)`,
		async () => {
			const missing = await olderBackendTabs(pending("1", "2"), capable);
			const backend = await Backend.start({ apt: settled("2"), capable });
			await backend.check();
			// When the next check's refresh fails, a tab that reconnects is not told the old "none".
			await backend.setApt(failing(settled("2")));
			await backend.check();
			await reconnect(backend, missing);
			expect(names(missing)).toEqual([[NOTICE], [NOTICE]]);
			expect(removals(missing)).toEqual([0, 0]);
			// Control: the next conclusive check tells them.
			await backend.setApt(settled("2"));
			await backend.check();
			await sync(missing);
			expect(names(missing)).toEqual([[], []]);
		},
		budget(3),
	);

	test(
		`with no stored offer, a held CeraLive package beside an unrelated upgrade keeps another backend's banner (${image} image)`,
		async () => {
			const opened = await olderBackendTabs(pending("1", "2"), capable);
			const backend = await Backend.start({
				apt: {
					keptBack: [cerastream("1", "2")],
					holds: ["cerastream"],
					upgradable: [curl],
				},
				capable,
			});
			await reconnect(backend, opened);
			await backend.check();
			await sync(opened);
			expect(holdsNotice(opened)).toEqual([true, true]);
			expect(removals(opened)).toEqual([0, 0]);
			// Control: with cerastream 2 installed, the same process's next check clears it.
			await backend.setApt({ ...settled("2"), upgradable: [curl] });
			await backend.check();
			await sync(opened);
			expect(holdsNotice(opened)).toEqual([false, false]);
		},
		budget(3),
	);

	test(
		`a new release found within a second still reaches every connected tab (${image} image)`,
		async () => {
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(backend);
			await backend.check();
			// The limiter holds the third update of a slot inside a second of the second.
			for (const release of ["3", "4"]) {
				await backend.setApt(pending("1", release));
				await backend.check();
			}
			await sync(opened);
			expect(histories(opened)).toEqual([
				["show", "show", "show"],
				["show", "show", "show"],
			]);
		},
		budget(2),
	);
}

// One rule, over real processes, the real WebSocket server and both decoders: only a
// complete check replaces or retires the standing offer, and no removal reaches a tab
// that logs in. Each sequence asserts its deciding step, then the copy its tabs end with.
const srtla = (installed: string, candidate: string): AptPackage => ({
	name: "srtla",
	installed,
	candidate,
});
// cerastream 2 is kept back beside srtla 2's valid upgrade: the check is not complete.
const keptBesideSrtla: AptScript = {
	upgradable: [srtla("1", "2")],
	keptBack: [cerastream("1", "2")],
};
// srtla 2 installed while cerastream stays kept back at 1.
const srtlaInstalled: AptScript = {
	installed: [srtla("2", "2")],
	keptBack: [cerastream("1", "2")],
};
const holding = (opened: readonly Tab[]) =>
	opened.map((tab) => tab.shown.has(NOTICE));

const oneRule: readonly [
	string,
	"kept" | "removed",
	(capable: boolean) => Promise<Tab[]>,
][] = [
	[
		"a complete none, then the evidence changes before tabs that were away reconnect",
		"kept",
		async (capable) => {
			const away = await olderBackendTabs(pending("1", "3"), capable);
			const backend = await Backend.start({ apt: settled("2"), capable });
			await backend.check();
			// A rollback, and no check yet: the earlier none reaches no reconnecting tab.
			await backend.setApt(pending("1", "2"));
			await reconnect(backend, away);
			expect(removals(away)).toEqual([0, 0]);
			await backend.check();
			await sync(away);
			return away;
		},
	],
	[
		"a dismissal while tabs were away",
		"kept",
		async (capable) => {
			const away = await olderBackendTabs(pending("1", "2"), capable);
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const [dismissing] = await tabs(backend, ["typed"]);
			await backend.check();
			await (dismissing as Tab).sync();
			await (dismissing as Tab).dismiss(NOTICE);
			expect((dismissing as Tab).shown.has(NOTICE)).toBe(false);
			await reconnect(backend, away);
			return away;
		},
	],
	[
		"an incomplete check beside the standing offer, then the other package installs",
		"kept",
		async (capable) => {
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(backend);
			await backend.check();
			await backend.setApt(keptBesideSrtla);
			await backend.check();
			await sync(opened);
			// srtla's verified upgrade is not shown in cerastream's place.
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			await backend.setApt(srtlaInstalled);
			await backend.recover();
			await sync(opened);
			expect((await backend.ended()).exit).toBe(RESTART_EXIT_CODE);
			return opened;
		},
	],
	[
		"a stored offer, an incomplete check beside it after a restart, then the other package installs",
		"kept",
		async (capable) => {
			const offering = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(offering);
			await offering.check();
			await sync(opened);
			await offering.close();
			const next = await Backend.start({ apt: keptBesideSrtla, capable });
			await reconnect(next, opened);
			await next.check();
			await sync(opened);
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			await next.setApt(srtlaInstalled);
			await next.recover();
			await sync(opened);
			expect((await next.ended()).exit).toBe(RESTART_EXIT_CODE);
			return opened;
		},
	],
	[
		"an incomplete check, then a complete one",
		"kept",
		async (capable) => {
			const backend = await Backend.start({ apt: keptBesideSrtla, capable });
			const opened = await tabs(backend);
			await backend.check();
			await sync(opened);
			expect(histories(opened)).toEqual([[], []]);
			await backend.setApt({
				upgradable: [cerastream("1", "2"), srtla("1", "2")],
			});
			await backend.check();
			await sync(opened);
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			return opened;
		},
	],
	[
		"a standing offer left unfinished beside another package's upgrade",
		"kept",
		async (capable) => {
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(backend);
			await backend.check();
			// cerastream 2 unpacked but not configured, srtla 2 upgradable beside it.
			await backend.setApt({
				...configuring("2"),
				upgradable: [srtla("1", "2")],
			});
			await backend.check();
			await sync(opened);
			// srtla's upgrade is not shown in cerastream's place.
			expect(histories(opened)).toEqual([["show"], ["show"]]);
			return opened;
		},
	],
	[
		"the standing offer's hold changes, then a complete none",
		"removed",
		async (capable) => {
			const backend = await Backend.start({ apt: pending("1", "2"), capable });
			const opened = await tabs(backend);
			await backend.check();
			await backend.setApt({
				keptBack: [cerastream("1", "2")],
				holds: ["cerastream"],
			});
			await backend.check();
			await sync(opened);
			expect(holding(opened)).toEqual([true, true]);
			await backend.setApt(settled("2"));
			await backend.check();
			await sync(opened);
			return opened;
		},
	],
];

for (const capable of [false, true])
	for (const [label, outcome, run] of oneRule)
		test(
			`${label}: ${outcome} (${capable ? "capable" : "legacy"} image)`,
			async () => {
				const opened = await run(capable);
				expect([holding(opened), removals(opened)]).toEqual(
					outcome === "kept"
						? [
								[true, true],
								[0, 0],
							]
						: [
								[false, false],
								[1, 1],
							],
				);
			},
			budget(3),
		);

for (const capable of [false, true])
	test(
		`an install APT reports unfinished keeps main's banner; once configured, a complete check clears it (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given main's own backend, whose own check showed its offer in main-era and
			// v2026.7.2 tabs; it recorded nothing for this process to read back.
			const opened = await olderBackendTabs(pending("1", "2"), capable);
			// When the transaction unpacked cerastream 2 but its setup failed: APT reports it
			// not fully installed and plans only its configuration, with nothing to upgrade.
			const backend = await Backend.start({ apt: configuring("2"), capable });
			await reconnect(backend, opened);
			await backend.check();
			await sync(opened);
			// Then that check is not complete: both tabs keep the banner.
			expect(holding(opened)).toEqual([true, true]);
			expect(removals(opened)).toEqual([0, 0]);
			// Control: once dpkg shows it configured, the same process's complete check clears it.
			await backend.setApt(settled("2"));
			await backend.check();
			await sync(opened);
			expect(holding(opened)).toEqual([false, false]);
			expect(removals(opened)).toEqual([1, 1]);
		},
		budget(3),
	);

const credentials = (installed: string, candidate: string): AptPackage => ({
	name: "ceralive-apt-credentials",
	installed,
	candidate,
});

test(
	"a credentials-only update main raised stays while pending and while unfinished, and clears once dpkg shows it configured at the candidate (capable image)",
	async () => {
		// Given main's own capable backend, whose own check showed its offer for a
		// ceralive-apt-credentials upgrade alone, in main-era and v2026.7.2 tabs.
		const pendingCredentials: AptScript = {
			upgradable: [credentials("1.0.0", "1.0.1")],
		};
		const opened = await olderBackendTabs(pendingCredentials, true);
		// When this backend's own complete check finds that same upgrade still pending.
		const backend = await Backend.start({
			apt: pendingCredentials,
			capable: true,
		});
		await reconnect(backend, opened);
		await backend.check();
		await sync(opened);
		// Then it is this process's offer too: both tabs keep the banner.
		expect(holding(opened)).toEqual([true, true]);
		expect(removals(opened)).toEqual([0, 0]);
		expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
			version: 8,
			offer: [
				{ name: "ceralive-apt-credentials", arch: "arm64", version: "1.0.1" },
			],
		});
		// And while 1.0.1 is unpacked but not configured, the check is not complete.
		await backend.setApt({
			installed: [credentials("1.0.1", "1.0.1")],
			dpkgStatus: { "ceralive-apt-credentials": "iF " },
		});
		await backend.check();
		await sync(opened);
		expect(holding(opened)).toEqual([true, true]);
		expect(removals(opened)).toEqual([0, 0]);
		// Control: once configured, dpkg shows 1.0.1 installed at the offered version.
		await backend.setApt({ installed: [credentials("1.0.1", "1.0.1")] });
		await backend.check();
		await sync(opened);
		expect(holding(opened)).toEqual([false, false]);
		expect(removals(opened)).toEqual([1, 1]);
	},
	budget(3),
);
