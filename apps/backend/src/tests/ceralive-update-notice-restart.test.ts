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
import { createHash } from "node:crypto";
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
	ARCH_LIMIT,
	OFFER_VERSION_LIMIT,
} from "../modules/system/ceralive-update-notice.ts";
import { ceralivePackageList } from "../modules/system/package-layer.ts";
import {
	APPLIED_MARKER,
	type AptPackage,
	type AptScript,
	CHECKED_MARKER,
	DEBIAN_ONLY_REFRESH,
	HYDRATED_MARKER,
	READY_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	REFRESH,
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
const MAIN_BACKEND = new URL(
	"./helpers/main-backend-preload.ts",
	import.meta.url,
).pathname;
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
				SESSION,
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
									"3df836a8b910d38b7e5d4a6cae8ef8ba17b6e742",
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

	scheduledPackageCheck(): Promise<void> {
		return this.command(
			"scheduled-package-check",
			CHECKED_MARKER,
			"scheduled package check completion",
		);
	}

	pausePackageCompare(): Promise<void> {
		return this.command(
			"pause-package-compare",
			"backend:compare-armed",
			"comparison barrier armed",
		);
	}

	startCheckAndWaitForCapturedCompare(): Promise<void> {
		return this.command(
			"scheduled-package-check",
			"backend:compare-captured",
			"captured dpkg comparison",
		);
	}

	resumePackageCompare(): Promise<void> {
		return this.command(
			"resume-package-compare",
			CHECKED_MARKER,
			"scheduled package check completion",
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

	private show(name: string, copy: Copy) {
		if (this.tracks(name)) this.history.push("show");
		this.shown.set(name, copy);
	}

	private remove(name: string): void {
		if (this.tracks(name)) this.history.push("remove");
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

const scheduledNotice = (name: string) =>
	name.startsWith("update:updates-available:") &&
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

const noticePrefix = "update:updates-available:";
const canonicalNoticeId = (capable: boolean, rows: readonly AptPackage[]) =>
	noticePrefix +
	rows
		.map(
			({ name, candidate, planned }) =>
				`${name}=${capable ? (planned ?? candidate) : "unknown"}`,
		)
		.sort()
		.join(",");
const exactNoticeId = (
	rows: readonly AptPackage[],
	display = rows,
	capable = false,
) => {
	const vector = rows
		.map(({ name, arch = "arm64", candidate, planned }) => [
			name,
			arch,
			planned ?? candidate,
		])
		.sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0));
	const key = canonicalNoticeId(capable, display).slice(noticePrefix.length);
	return `${noticePrefix}packages:${createHash("sha256")
		.update(
			JSON.stringify(display.length === rows.length ? vector : [key, vector]),
		)
		.digest("hex")}`;
};

for (const capable of [false, true]) {
	const image = capable ? "capable Debian" : "legacy roster";
	const packageOffer: AptPackage = capable
		? { ...cerastream("1", "2"), name: "curl", source: "debian" }
		: cerastream("1", "2");
	const stockHold: AptScript = {
		holds: [bootPackage.name],
		installed: [bootPackage],
	};
	const keptBack = [
		{ ...cerastream("1", "2"), name: "tzdata", source: "debian" as const },
	];
	const unrelated: AptPackage = {
		name: "tzdata",
		source: "debian",
		installed: "1",
		candidate: "2",
	};
	const independent = cerastream("1", "2", { name: "srtla" });
	const configured = { ...packageOffer, installed: "2" };
	const installed = { installed: [configured] };
	const foreign: AptPackage = {
		name: "libc6:armhf",
		arch: "armhf",
		source: "debian",
		installed: "1",
		candidate: "2",
	};
	const newcomer = cerastream("(none)", "2", { name: "modemmanager" });
	const blockedA = { ...configured, candidate: "3" };
	const unfinished = { installed: [unrelated], dpkgStatus: { tzdata: "iF " } };

	const matrix: readonly {
		readonly label: string;
		readonly announce: AptScript;
		readonly canonicalRows: readonly AptPackage[];
		readonly offered: readonly AptPackage[];
		readonly withdraw: AptScript;
		readonly clears: boolean;
		readonly lateHold?: true;
	}[] = [
		{
			label: "nothing",
			announce: {},
			canonicalRows: [],
			offered: [],
			withdraw: installed,
			clears: true,
		},
		{
			label: "held offered",
			announce: {
				upgradable: [independent],
				installed: [packageOffer],
				holds: [packageOffer.name],
			},
			canonicalRows: [independent],
			offered: [independent],
			withdraw: { ...installed, holds: [packageOffer.name] },
			clears: false,
		},
		{
			label: "kept-back offered",
			announce: { upgradable: [independent], keptBack: [packageOffer] },
			canonicalRows: capable ? [independent] : [independent, packageOffer],
			offered: [independent],
			withdraw: { keptBack: [blockedA] },
			clears: false,
		},
		{
			label: "unrelated held and kept back",
			announce: {
				upgradable: [independent],
				keptBack: [unrelated],
				holds: [unrelated.name],
			},
			canonicalRows: capable ? [independent] : [independent, unrelated],
			offered: [independent],
			withdraw: {
				...installed,
				keptBack: [unrelated],
				holds: [unrelated.name],
			},
			clears: true,
		},
		{
			label: "unfinished unrelated",
			announce: { ...unfinished, upgradable: [independent] },
			canonicalRows: [independent],
			offered: [independent],
			withdraw: { ...unfinished, installed: [configured, unrelated] },
			clears: false,
		},
		{
			label: "foreign architecture",
			announce: { upgradable: [independent, foreign] },
			canonicalRows: [independent, foreign],
			offered: capable ? [independent, foreign] : [independent],
			withdraw: { installed: [{ ...configured, installedArch: "armhf" }] },
			clears: false,
		},
		{
			label: "NEW entry",
			announce: { upgradable: [independent, newcomer] },
			canonicalRows: capable ? [independent, newcomer] : [independent],
			offered: capable ? [independent, newcomer] : [independent],
			withdraw: { ...installed, upgradable: [newcomer] },
			clears: false,
		},
		{
			label: "hold after snapshot",
			announce: {
				upgradable: [independent],
				installed: [configured],
				dpkgStatus: { [configured.name]: "hi " },
			},
			canonicalRows: [independent],
			offered: [independent],
			withdraw: installed,
			clears: false,
			lateHold: true,
		},
	];

	for (const row of matrix) {
		test(
			`scheduled package notice differential announce (${image}, ${row.label})`,
			async () => {
				const before = { upgradable: [packageOffer] };
				const check = async (canonicalScheduler: boolean) => {
					const backend = await Backend.start({
						capable,
						apt: before,
						canonicalScheduler,
					});
					const opened = scheduledTabs();
					await reconnect(backend, opened);
					await backend.scheduledPackageCheck();
					await sync(opened);
					const initial = scheduledNames(opened);
					expect(initial.map((ids) => ids.length)).toEqual([1, 1]);
					await backend.setApt(row.announce);
					await backend.scheduledPackageCheck();
					await sync(opened);
					const final = scheduledNames(opened);
					const added = final.map((ids, index) =>
						ids.filter((id) => !initial[index]?.includes(id)),
					);
					expect(
						final.map((ids, index) =>
							ids.filter((id) => initial[index]?.includes(id)),
						),
					).toEqual(initial);
					expect(removals(opened)).toEqual([0, 0]);
					await backend.close();
					await Promise.all(opened.map((tab) => tab.dropped()));
					return added;
				};

				const baseline = await check(true);
				const mainId = canonicalNoticeId(capable, row.canonicalRows);
				expect(baseline).toEqual(
					row.offered.length > 0 ? [[mainId], [mainId]] : [[], []],
				);
				const exactId = exactNoticeId(row.offered, row.canonicalRows, capable);
				const revised = await check(false);
				expect(
					revised.map((ids) => ids.map((id) => (id === exactId ? mainId : id))),
				).toEqual(baseline);
			},
			budget(2),
		);

		test(
			`scheduled package notice strict withdraw (${image}, ${row.label})`,
			async () => {
				const backend = await Backend.start({
					capable,
					apt: { upgradable: [packageOffer] },
				});
				const opened = scheduledTabs();
				await reconnect(backend, opened);
				await backend.scheduledPackageCheck();
				await sync(opened);
				const id = exactNoticeId([packageOffer]);
				expect(scheduledNames(opened)).toEqual([[id], [id]]);
				await backend.setApt(row.withdraw);
				if (row.lateHold) {
					await backend.startCheckAndCaptureHolds();
					try {
						await backend.setApt({
							...row.withdraw,
							holds: [packageOffer.name],
						});
					} finally {
						await backend.resumePackageHolds();
					}
				} else {
					await backend.scheduledPackageCheck();
				}
				await sync(opened);
				expect(scheduledNames(opened).map((ids) => ids.includes(id))).toEqual(
					row.clears ? [false, false] : [true, true],
				);
				expect(removals(opened)).toEqual(row.clears ? [1, 1] : [0, 0]);
				if (row.lateHold) {
					await backend.setApt(installed);
					await backend.scheduledPackageCheck();
					await sync(opened);
					expect(scheduledNames(opened)).toEqual([[], []]);
					expect(removals(opened)).toEqual([1, 1]);
				}
			},
			budget(1),
		);
	}

	test(
		`scheduled package notice matches main when receipt evidence changes for the same offer (${image})`,
		async () => {
			const pending = { upgradable: [independent] };
			const detachedRefresh = REFRESH.replace(
				"Hit:1 https://deb.debian.org/debian-security trixie-security InRelease",
				"Ign:1 https://deb.debian.org/debian-security trixie-security InRelease\nHit:3 https://deb.debian.org/debian-security trixie-security Release",
			);
			const run = async (canonicalScheduler: boolean) => {
				const backend = await Backend.start({
					capable,
					apt: pending,
					canonicalScheduler,
				});
				const opened = scheduledTabs();
				await reconnect(backend, opened);
				await backend.scheduledPackageCheck();
				await sync(opened);
				const original = scheduledNames(opened);
				expect(original.map((ids) => ids.length)).toEqual([1, 1]);
				await backend.setApt({
					...pending,
					refresh: { stdout: detachedRefresh },
				});
				await backend.scheduledPackageCheck();
				await sync(opened);
				expect(scheduledNames(opened)).toEqual(original);
				expect(removals(opened)).toEqual([0, 0]);
				await backend.close();
				await Promise.all(opened.map((tab) => tab.dropped()));
			};
			await run(true);
			await run(false);
		},
		budget(2),
	);

	if (!capable) {
		test(
			"scheduled package notice matches main after the optional legacy size estimate fails",
			async () => {
				for (const canonicalScheduler of [true, false]) {
					const backend = await Backend.start({
						capable,
						apt: { upgradable: [packageOffer] },
						canonicalScheduler,
					});
					const opened = scheduledTabs();
					await reconnect(backend, opened);
					await backend.check();
					await sync(opened);
					expect(scheduledNames(opened)).toEqual([[], []]);
					await backend.setApt({
						...installed,
						keptBack: [unrelated],
						fallback: {
							exitCode: 100,
							stdout: "",
							stderr: "E: size unavailable\n",
						},
					});
					await backend.scheduledPackageCheck();
					await sync(opened);
					const original = canonicalNoticeId(false, [packageOffer]);
					expect(scheduledNames(opened)).toEqual([[original], [original]]);
					expect(removals(opened)).toEqual([0, 0]);
					await backend.close();
					await Promise.all(opened.map((tab) => tab.dropped()));
				}
			},
			budget(2),
		);

		test(
			"scheduled package notice matches main when only the legacy display rows change",
			async () => {
				const pending = { upgradable: [independent] };
				for (const canonicalScheduler of [true, false]) {
					const backend = await Backend.start({
						capable,
						apt: pending,
						canonicalScheduler,
					});
					const opened = scheduledTabs();
					await reconnect(backend, opened);
					await backend.scheduledPackageCheck();
					await sync(opened);
					const original = scheduledNames(opened);
					expect(original.map((ids) => ids.length)).toEqual([1, 1]);
					await backend.setApt({
						...pending,
						keptBack: [unrelated],
						holds: [unrelated.name],
					});
					await backend.scheduledPackageCheck();
					await sync(opened);
					const after = scheduledNames(opened);
					expect(after.map((ids) => ids.length)).toEqual([2, 2]);
					expect(
						after.map((ids, index) =>
							ids.filter((id) => original[index]?.includes(id)),
						),
					).toEqual(original);
					expect(removals(opened)).toEqual([0, 0]);
					await backend.close();
					await Promise.all(opened.map((tab) => tab.dropped()));
				}
			},
			budget(2),
		);
	}

	test(
		`scheduled package notice announces beside an unrelated kept-back package (${image})`,
		async () => {
			const backend = await Backend.start({
				capable,
				apt: { upgradable: [packageOffer], keptBack },
			});
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);
		},
		budget(1),
	);

	test(
		`scheduled package notice clears installed proof beside an unrelated kept-back package (${image})`,
		async () => {
			const backend = await Backend.start({
				capable,
				apt: { upgradable: [packageOffer] },
			});
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);

			await backend.setApt({
				installed: [{ ...packageOffer, installed: "2" }],
				keptBack,
				// The optional legacy size probe is not the original plan.
				fallback: {
					exitCode: 100,
					stdout: "",
					stderr: "E: size unavailable\n",
				},
			});
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(scheduledNames(opened)).toEqual([[], []]);
			expect(removals(opened)).toEqual([1, 1]);
		},
		budget(1),
	);

	test(
		`scheduled package notice keeps an offered member listed as kept back (${image})`,
		async () => {
			const backend = await Backend.start({
				capable,
				apt: { upgradable: [packageOffer] },
			});
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);
			// dpkg would meet the old offered version, but APT still lists
			// this exact member as kept back at a later candidate.
			await backend.setApt({
				keptBack: [{ ...packageOffer, installed: "2", candidate: "3" }],
			});
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);
			expect(removals(opened)).toEqual([0, 0]);
		},
		budget(1),
	);

	test(
		`scheduled package notice announces an eligible offer with the stock boot hold (${image})`,
		async () => {
			const backend = await Backend.start({
				capable,
				apt: { ...stockHold, upgradable: [packageOffer] },
			});
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);
		},
		budget(1),
	);

	test(
		`scheduled package notice clears a proven offer with the stock boot hold (${image})`,
		async () => {
			const backend = await Backend.start({
				capable,
				apt: { upgradable: [packageOffer] },
			});
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames(opened)).toEqual([[offer], [offer]]);

			await backend.setApt({
				holds: [bootPackage.name],
				installed: [
					bootPackage,
					{ ...packageOffer, installed: capable ? "1:1" : "2+b1" },
				],
			});
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(scheduledNames(opened)).toEqual([[], []]);
			expect(removals(opened)).toEqual([1, 1]);
		},
		budget(1),
	);

	test(
		`scheduled package notice does not send captured proof to late authenticators (${image})`,
		async () => {
			const offered = { upgradable: [packageOffer] };
			const configured = {
				installed: [{ ...packageOffer, installed: "2" }],
			};
			let backend = await Backend.start({ capable, apt: offered });
			const early = scheduledTabs();
			const late = scheduledTabs();
			await reconnect(backend, [...early, ...late]);
			await backend.scheduledPackageCheck();
			await sync([...early, ...late]);
			const offer = early[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			expect(scheduledNames([...early, ...late])).toEqual([
				[offer],
				[offer],
				[offer],
				[offer],
			]);
			await backend.close();
			await Promise.all([...early, ...late].map((tab) => tab.dropped()));
			backend = await Backend.start({ capable, apt: configured });
			await reconnect(backend, early);
			await backend.pausePackageCompare();
			await backend.startCheckAndWaitForCapturedCompare();
			try {
				await backend.setApt(offered);
				await reconnect(backend, late);
				expect(scheduledNames(late)).toEqual([[offer], [offer]]);
				expect(removals(late)).toEqual([0, 0]);
			} finally {
				await backend.resumePackageCompare();
			}
			await sync([...early, ...late]);
			expect(scheduledNames(late)).toEqual([[offer], [offer]]);
			expect(removals(late)).toEqual([0, 0]);
			expect(scheduledNames(early)).toEqual([[], []]);
			expect(removals(early)).toEqual([1, 1]);

			// The late pair needs a new check; no cached proof authorizes it.
			await backend.setApt(configured);
			await backend.scheduledPackageCheck();
			await sync(late);
			expect(scheduledNames(late)).toEqual([[], []]);
			expect(removals(late)).toEqual([1, 1]);
		},
		budget(2),
	);

	test(
		`scheduled package notice keeps both versions when a later proof sees their shared package held (${image})`,
		async () => {
			const backend = await Backend.start({ capable, apt: pending("1", "2") });
			const opened = scheduledTabs();
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			await backend.setApt(pending("2", "3"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offered = scheduledNames(opened);
			expect(offered[0]).toHaveLength(2);
			expect(offered[1]).toEqual(offered[0]);

			await backend.setApt(settled("3"));
			await backend.pausePackageCompare();
			await backend.startCheckAndWaitForCapturedCompare();
			try {
				await backend.setApt({ ...settled("3"), holds: ["cerastream"] });
			} finally {
				await backend.resumePackageCompare();
			}
			await sync(opened);
			expect(scheduledNames(opened)).toEqual(offered);
			expect(removals(opened)).toEqual([0, 0]);

			await backend.setApt(settled("3"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(scheduledNames(opened)).toEqual([[], []]);
			expect(removals(opened)).toEqual([2, 2]);
		},
		budget(1),
	);

	test(
		`scheduled package notice survives uncertain checks and reconnects, then clears on exact installed proof (${capable ? "capable Debian" : "legacy roster"})`,
		async () => {
			const pkg: AptPackage = capable
				? { ...cerastream("1", "2"), name: "curl", source: "debian" }
				: cerastream("1", "2");
			const other = cerastream("1", "2", { name: "srtla" });
			const configured = { ...pkg, installed: pkg.candidate };
			const installed = { installed: [configured] };
			const opened = [
				new Tab("typed", scheduledNotice),
				new Tab("v2026.7.2", scheduledNotice),
			];
			const offline = [
				new Tab("typed", scheduledNotice),
				new Tab("v2026.7.2", scheduledNotice),
			];
			let backend = await Backend.start({
				capable,
				apt: { upgradable: [pkg] },
			});
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const offer = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(offer).not.toBe("");
			const shown = () =>
				names(opened).map((items) => items.filter(scheduledNotice));
			expect(shown()).toEqual([[offer], [offer]]);
			await reconnect(backend, offline);
			expect(names(offline).map((items) => items.includes(offer))).toEqual([
				true,
				true,
			]);

			let expected = [offer];
			for (const [label, apt, adds] of [
				["failed refresh", failing(installed)],
				[
					"index omitted",
					{
						...installed,
						refresh: {
							stdout: capable
								? REFRESH.split("\n").slice(1).join("\n")
								: DEBIAN_ONLY_REFRESH,
						},
					},
				],
				[
					"missing summary",
					{
						...installed,
						fail: capable
							? { simulation: "no-summary" }
							: { discovery: "no-summary" },
					},
				],
				[
					"partial plan beside installed offer",
					{
						...installed,
						upgradable: [other],
						fail: capable
							? { simulation: "cut-after-summary" }
							: { discovery: "cut-after-summary" },
					},
				],
				[
					"kept back beside another offer",
					{
						upgradable: [other],
						keptBack: [pkg],
					},
					capable ? [] : [exactNoticeId([other], [other, pkg])],
				],
				[
					"held even with the candidate configured",
					{
						...installed,
						holds: [pkg.name],
					},
				],
				[
					"an architecture-qualified hold beside another offer",
					{
						...installed,
						holds: [`${pkg.name}:arm64`],
						upgradable: [other],
					},
					capable ? [] : [exactNoticeId([other])],
				],
				[
					"unpacked or unconfigured",
					{
						...installed,
						dpkgStatus: { [pkg.name]: "iF " },
					},
				],
				[
					"only foreign instance installed",
					{
						installed: [{ ...configured, installedArch: "amd64" }],
					},
				],
				[
					"only a lower Debian prerelease installed",
					{
						installed: [{ ...configured, installed: `${pkg.candidate}~rc1` }],
					},
				],
				[
					"readback failed",
					{ ...installed, fail: { "dpkg-query": "silent-exit-1" } },
				],
			] satisfies readonly (readonly [
				string,
				AptScript,
				(readonly string[])?,
			])[]) {
				await backend.setApt(apt);
				await backend.scheduledPackageCheck();
				await sync(opened);
				expect([
					label,
					shown().map((items) => items.includes(offer)),
					removals(opened),
				]).toEqual([label, [true, true], [0, 0]]);
				expected = [...new Set([...expected, ...(adds ?? [])])];
				expect(shown()).toEqual([expected, expected]);
			}

			await backend.close();
			await Promise.all([...opened, ...offline].map((tab) => tab.dropped()));
			backend = await Backend.start({ capable, apt: installed });
			await reconnect(backend, opened);
			expect(shown().map((items) => items.includes(offer))).toEqual([
				true,
				true,
			]);
			expect(removals(opened)).toEqual([0, 0]);

			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(shown().map((items) => items.includes(offer))).toEqual([
				false,
				false,
			]);
			expect(removals(opened)).toEqual([1, 1]);

			// The other pair missed the live removal. Reauth must not replay it,
			// especially after the device's candidate became pending again.
			await backend.setApt({ upgradable: [pkg] });
			await reconnect(backend, offline);
			expect(names(offline).map((items) => items.includes(offer))).toEqual([
				true,
				true,
			]);
			expect(removals(offline)).toEqual([0, 0]);
		},
		budget(3),
	);

	test(
		`scheduled package notice gives a newer offer its own identity (${capable ? "capable" : "legacy"})`,
		async () => {
			const backend = await Backend.start({ capable, apt: pending("1", "2") });
			const opened = [
				new Tab("typed", scheduledNotice),
				new Tab("v2026.7.2", scheduledNotice),
			];
			await reconnect(backend, opened);
			await backend.scheduledPackageCheck();
			await sync(opened);
			const original = opened[0]?.names().find(scheduledNotice) ?? "";
			expect(original).not.toBe("");

			await backend.setApt(pending("2", "3"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			const newer =
				opened[0]
					?.names()
					.find((name) => scheduledNotice(name) && name !== original) ?? "";
			expect(newer).not.toBe("");
			expect(names(opened).map((items) => items.includes(newer))).toEqual([
				true,
				true,
			]);

			// A complete check has no remaining actionable rows, but version 3
			// was pinned out. The installed readback proves only version 2.
			await backend.setApt(settled("2"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(
				names(opened).map((items) => items.filter(scheduledNotice)),
			).toEqual([[newer], [newer]]);

			// The matching version's dismissal suppresses it, but cannot
			// suppress the next version of the same package.
			await opened[0]?.dismiss(newer);
			await backend.setApt(pending("2", "3"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			expect(opened[0]?.names().filter(scheduledNotice)).toEqual([]);
			await backend.setApt(pending("2", "4"));
			await backend.scheduledPackageCheck();
			await sync(opened);
			const successor = opened[0]?.names().filter(scheduledNotice) ?? [];
			expect(successor).toHaveLength(1);
			expect(successor).not.toContain(newer);
			expect(opened[1]?.names()).toEqual(expect.arrayContaining(successor));
		},
		budget(1),
	);
}

// Tabs that show the offer main's own backend raised in its own check (no record written).
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
			expect([kind, names(control)]).toEqual([kind, expected]);
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
