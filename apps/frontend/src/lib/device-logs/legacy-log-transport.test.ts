// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rpcClient } from "$lib/rpc/client";
import { RPC_CALL_TIMEOUT_MS } from "$lib/rpc/rpc-timeouts";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";

import { LogDownloads } from "../../main/system-logs/log-downloads.svelte";
import {
	FILE_AFTER_REPLY_MS,
	type LegacyKind,
	legacyLocked,
} from "./download-gate.svelte";

/**
 * The legacy log downloads through the real transport: LogDownloads, the gate,
 * SystemHelper and the RPC client over a socket, and back through the client's
 * frame dispatch and the subscription handler's `log` case to the browser save.
 * The device side is played by hand: its replies, its pushed files (with or
 * without the echoed id) and its silences.
 */

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	readonly sent: string[] = [];

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	receive(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

const PATH: Record<LegacyKind, string> = {
	device: "system.getLog",
	system: "system.getSyslog",
};
const FILE_NAME: Record<LegacyKind, string> = {
	device: "ceralive.service_log.txt",
	system: "ceralive_system_log.txt",
};
const KINDS = [
	{ kind: "device", other: "system" },
	{ kind: "system", other: "device" },
] as const;

const realWebSocket = globalThis.WebSocket;
// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];
// Every browser download handed off, in order: the file name and the bytes behind its URL.
let handoffs: { name: string; href: string }[];
let files: Map<string, Blob>;

function socket(): FakeWebSocket {
	const current = FakeWebSocket.instances.at(-1);
	if (current === undefined) throw new Error("the client opened no socket");
	return current;
}

/** The legacy requests of one kind the client sent, oldest first. */
function asked(kind: LegacyKind): { id: string; request?: string }[] {
	return socket()
		.sent.map(
			(frame) =>
				JSON.parse(frame) as {
					id: string;
					path?: string[];
					input?: { request?: string };
				},
		)
		.filter((frame) => frame.path?.join(".") === PATH[kind])
		.map((frame) => ({ id: frame.id, request: frame.input?.request }));
}

function nth(
	kind: LegacyKind,
	index: number,
): { id: string; request?: string } {
	const request = asked(kind)[index];
	if (request === undefined) throw new Error(`no request ${index} of ${kind}`);
	return request;
}

/** The device pushes a file, echoing the request id or (an older device) not. */
function push(kind: LegacyKind, contents: string, request?: string): void {
	socket().receive({
		log: {
			name: FILE_NAME[kind],
			contents,
			...(request === undefined ? {} : { request }),
		},
		id: "device",
	});
}

function answer(id: string): void {
	socket().receive({ id, result: { log: "" } });
}

function refuse(id: string): void {
	socket().receive({ id, error: { code: "INTERNAL_ERROR", message: "late" } });
}

/** The device stays silent past the call's timeout, while the socket stays alive. */
async function silence(): Promise<void> {
	for (let elapsed = 0; elapsed <= RPC_CALL_TIMEOUT_MS; elapsed += 5_000) {
		socket().receive({ ping: elapsed });
		await vi.advanceTimersByTimeAsync(5_000);
	}
}

function handed(): Promise<{ name: string; text: string }[]> {
	return Promise.all(
		handoffs.map(async ({ name, href }) => ({
			name,
			text: (await files.get(href)?.text()) ?? `no file behind ${href}`,
		})),
	);
}

function file(kind: LegacyKind, text: string): { name: string; text: string } {
	return { name: FILE_NAME[kind], text };
}

/** Lets every queued continuation run, the late replies' included. */
function drain(): Promise<void> {
	return vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	});
	handoffs = [];
	files = new Map();
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://test.local/ws";
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		handoffs.push({
			name: this.download,
			href: this.getAttribute("href") ?? "",
		});
	});
	Object.assign(URL, {
		createObjectURL: vi.fn((blob: Blob) => {
			const href = `blob:log-${files.size + 1}`;
			files.set(href, blob);
			return href;
		}),
		revokeObjectURL: vi.fn(),
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	resetState();
	// Registers the subscription handler on the client once; later cases reconnect it.
	initSubscriptions();
	if (FakeWebSocket.instances.length === 0) rpcClient.connect();
	socket().open();
});

afterEach(() => {
	resetState();
	rpcClient.disconnect();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("legacy log downloads over the socket", () => {
	it.each(KINDS)(
		"an older device's $kind file late after a timeout is dropped, and only then the retry is sent and saves its own",
		async ({ kind }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			await silence();
			await first;

			expect(legacyLocked(kind)).toBe(true);
			await view.download(kind);
			expect(asked(kind)).toHaveLength(1);
			push(kind, "stale");
			expect(legacyLocked(kind)).toBe(false);
			const retry = view.download(kind);
			await vi.waitFor(() => expect(asked(kind)).toHaveLength(2));
			push(kind, "fresh");
			answer(nth(kind, 1).id);
			await retry;

			expect(await handed()).toEqual([file(kind, "fresh")]);
		},
	);

	it.each(KINDS)(
		"on a device that echoes the id, the $kind retry is active at once and its file is saved, not the timed-out one's",
		async ({ kind, other }) => {
			const view = new LogDownloads(() => true);
			const warm = view.download(other);
			push(other, "warm", nth(other, 0).request);
			answer(nth(other, 0).id);
			await warm;
			const first = view.download(kind);
			await silence();
			await first;

			expect(legacyLocked(kind)).toBe(false);
			const retry = view.download(kind);
			await vi.waitFor(() => expect(asked(kind)).toHaveLength(2));
			push(kind, "stale", nth(kind, 0).request);
			push(kind, "fresh", nth(kind, 1).request);
			answer(nth(kind, 1).id);
			await retry;

			expect(await handed()).toEqual([
				file(other, "warm"),
				file(kind, "fresh"),
			]);
		},
	);

	it.each(KINDS)(
		"a $kind file that arrives before its call times out is saved, and the timeout locks nothing",
		async ({ kind }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			push(kind, "fresh");
			await silence();
			await first;

			expect(legacyLocked(kind)).toBe(false);
			void view.download(kind);
			expect(asked(kind)).toHaveLength(2);
			expect(await handed()).toEqual([file(kind, "fresh")]);
		},
	);

	it.each(KINDS)(
		"a $kind file dropped after its view closed leaves no lock: the reopened view's request goes out at once and saves its own",
		async ({ kind }) => {
			let open = true;
			const closed = new LogDownloads(() => open);
			const first = closed.download(kind);
			open = false;
			push(kind, "closed view");
			await silence();
			await first;

			expect(legacyLocked(kind)).toBe(false);
			const reopened = new LogDownloads(() => true).download(kind);
			expect(asked(kind)).toHaveLength(2);
			push(kind, "reopened view");
			answer(nth(kind, 1).id);
			await reopened;

			expect(await handed()).toEqual([file(kind, "reopened view")]);
		},
	);

	it("a locked device log leaves the system log free, and each file goes to its own kind", async () => {
		const view = new LogDownloads(() => true);
		const device = view.download("device");
		await silence();
		await device;
		expect(legacyLocked("device")).toBe(true);

		const system = view.download("system");
		expect(asked("system")).toHaveLength(1);
		push("system", "system log");
		answer(nth("system", 0).id);
		await system;

		expect(legacyLocked("device")).toBe(true);
		expect(legacyLocked("system")).toBe(false);
		expect(await handed()).toEqual([file("system", "system log")]);
	});

	it.each(KINDS)(
		"once the device echoes ids, an untagged $kind file is refused and the tagged one is saved",
		async ({ kind, other }) => {
			const view = new LogDownloads(() => true);
			const warm = view.download(other);
			push(other, "warm", nth(other, 0).request);
			answer(nth(other, 0).id);
			await warm;
			const download = view.download(kind);

			push(kind, "untagged");
			push(kind, "tagged", nth(kind, 0).request);
			answer(nth(kind, 0).id);
			await download;

			expect(await handed()).toEqual([
				file(other, "warm"),
				file(kind, "tagged"),
			]);
		},
	);

	const BOTH = KINDS.flatMap(({ kind, other }) =>
		[true, false].map((echoed) => ({ kind, other, echoed })),
	);
	const tag = (echoed: boolean, request?: string) => {
		if (echoed && request === undefined)
			throw new Error("the client sent no request id to echo");
		return echoed ? request : undefined;
	};
	const distinctIds = (kind: LegacyKind) => {
		const ids = asked(kind).map(({ request }) => request);
		expect(ids.every((id) => id !== undefined)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
	};

	it.each(BOTH)(
		"a saved $kind file ends its request at once: the retry goes out while its reply is pending, and the late answer changes nothing (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			push(kind, "first", tag(echoed, nth(kind, 0).request));
			await vi.waitFor(() => expect(view.downloading).toBeNull());
			await first;

			const retry = view.download(kind);
			expect(asked(kind)).toHaveLength(2);
			answer(nth(kind, 0).id);
			await drain();
			expect(view.downloading).toBe(kind);
			push(kind, "second", tag(echoed, nth(kind, 1).request));
			answer(nth(kind, 1).id);
			await retry;

			if (echoed) distinctIds(kind);
			expect(view.failed).toBeNull();
			expect(await handed()).toEqual([
				file(kind, "first"),
				file(kind, "second"),
			]);
		},
	);

	it.each(BOTH)(
		"a saved $kind file is not reported failed by its late error reply, and the active retry is untouched (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			push(kind, "first", tag(echoed, nth(kind, 0).request));
			await vi.waitFor(() => expect(view.downloading).toBeNull());
			await first;

			const retry = view.download(kind);
			refuse(nth(kind, 0).id);
			await drain();
			expect(view.failed).toBeNull();
			expect(view.downloading).toBe(kind);
			push(kind, "second", tag(echoed, nth(kind, 1).request));
			answer(nth(kind, 1).id);
			await retry;

			if (echoed) distinctIds(kind);
			expect(view.failed).toBeNull();
			expect(await handed()).toEqual([
				file(kind, "first"),
				file(kind, "second"),
			]);
		},
	);

	it.each(BOTH)(
		"a closed view's dropped $kind file frees the slot: the reopened view's request is active while the late reply lands, and saves only its own (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			let open = true;
			const closed = new LogDownloads(() => open);
			const first = closed.download(kind);
			open = false;
			push(kind, "closed view", tag(echoed, nth(kind, 0).request));
			await vi.waitFor(() => expect(closed.downloading).toBeNull());
			await first;

			const reopened = new LogDownloads(() => true);
			const fresh = reopened.download(kind);
			expect(asked(kind)).toHaveLength(2);
			answer(nth(kind, 0).id);
			await drain();
			expect(reopened.downloading).toBe(kind);
			push(kind, "reopened view", tag(echoed, nth(kind, 1).request));
			answer(nth(kind, 1).id);
			await fresh;

			expect(await handed()).toEqual([file(kind, "reopened view")]);
		},
	);

	it.each(KINDS)(
		"an error reply before the $kind file fails it, and that request's late file is dropped while the retry saves its own",
		async ({ kind }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			refuse(nth(kind, 0).id);
			await first;
			expect(view.failed).toBe(kind);

			const retry = view.download(kind);
			expect(asked(kind)).toHaveLength(2);
			push(kind, "late", nth(kind, 0).request);
			push(kind, "fresh", nth(kind, 1).request);
			answer(nth(kind, 1).id);
			await retry;

			expect(view.failed).toBeNull();
			expect(await handed()).toEqual([file(kind, "fresh")]);
		},
	);

	it("a saved device file with its reply pending leaves the system log free, and neither late reply moves the other", async () => {
		const view = new LogDownloads(() => true);
		const device = view.download("device");
		push("device", "device log");
		await vi.waitFor(() => expect(view.downloading).toBeNull());
		await device;

		const system = view.download("system");
		expect(asked("system")).toHaveLength(1);
		answer(nth("device", 0).id);
		await drain();
		expect(view.downloading).toBe("system");
		push("system", "system log");
		answer(nth("system", 0).id);
		await system;

		expect(view.failed).toBeNull();
		expect(await handed()).toEqual([
			file("device", "device log"),
			file("system", "system log"),
		]);
	});

	it.each(BOTH)(
		"an OK reply before the $kind file only acknowledges it: the request keeps its slot and the file is handed off once, to it (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			answer(nth(kind, 0).id);
			await drain();

			expect(view.downloading).toBe(kind);
			const queued = view.download(kind);
			await drain();
			expect(asked(kind)).toHaveLength(1);
			push(kind, "its file", tag(echoed, nth(kind, 0).request));
			await first;
			await queued;

			expect(view.failed).toBeNull();
			expect(await handed()).toEqual([file(kind, "its file")]);
		},
	);

	it.each(BOTH)(
		"an OK reply with no $kind file fails the download at the file deadline and frees the slot for a retry that saves only its own (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			answer(nth(kind, 0).id);
			await vi.advanceTimersByTimeAsync(FILE_AFTER_REPLY_MS - 1);
			expect(view.downloading).toBe(kind);
			await vi.advanceTimersByTimeAsync(1);
			await first;

			expect(view.failed).toBe(kind);
			expect(legacyLocked(kind)).toBe(false);
			const retry = view.download(kind);
			expect(asked(kind)).toHaveLength(2);
			push(kind, "retry", tag(echoed, nth(kind, 1).request));
			answer(nth(kind, 1).id);
			await retry;

			if (echoed) distinctIds(kind);
			expect(view.failed).toBeNull();
			expect(await handed()).toEqual([file(kind, "retry")]);
		},
	);

	it.each([true, false])(
		"both kinds active, their files arriving in reverse, each go to their own request with their own bytes (id echoed: %s)",
		async (echoed) => {
			const deviceView = new LogDownloads(() => true);
			const systemView = new LogDownloads(() => true);
			const device = deviceView.download("device");
			const system = systemView.download("system");
			expect(asked("device")).toHaveLength(1);
			expect(asked("system")).toHaveLength(1);

			push("system", "system bytes", tag(echoed, nth("system", 0).request));
			push("device", "device bytes", tag(echoed, nth("device", 0).request));
			answer(nth("system", 0).id);
			answer(nth("device", 0).id);
			await Promise.all([device, system]);

			expect(await handed()).toEqual([
				file("system", "system bytes"),
				file("device", "device bytes"),
			]);
		},
	);

	it.each(BOTH)(
		"a $kind retry queued before the closed view's request is dropped goes out only then, and saves only its own (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			let open = true;
			const closed = new LogDownloads(() => open);
			const first = closed.download(kind);
			const reopened = new LogDownloads(() => true);
			const queued = reopened.download(kind);
			await drain();
			expect(asked(kind)).toHaveLength(1);
			expect(reopened.downloading).toBe(kind);

			open = false;
			push(kind, "closed view", tag(echoed, nth(kind, 0).request));
			await vi.waitFor(() => expect(asked(kind)).toHaveLength(2));
			answer(nth(kind, 0).id);
			await drain();
			expect(reopened.downloading).toBe(kind);
			push(kind, "reopened view", tag(echoed, nth(kind, 1).request));
			answer(nth(kind, 1).id);
			await Promise.all([first, queued]);

			if (echoed) distinctIds(kind);
			expect(await handed()).toEqual([file(kind, "reopened view")]);
		},
	);

	it.each(BOTH)(
		"after the socket is replaced, the old socket's late $kind file and reply never reach the retry on the new one (id echoed: $echoed)",
		async ({ kind, echoed }) => {
			const view = new LogDownloads(() => true);
			const first = view.download(kind);
			const old = socket();
			const request = nth(kind, 0);
			old.close();
			await first;
			await vi.advanceTimersByTimeAsync(30_000);
			socket().open();
			expect(socket()).not.toBe(old);

			const retry = view.download(kind);
			expect(asked(kind)).toHaveLength(1);
			old.receive({
				log: {
					name: FILE_NAME[kind],
					contents: "old socket",
					...(echoed ? { request: request.request } : {}),
				},
				id: "device",
			});
			old.receive({ id: request.id, result: { log: "" } });
			await drain();
			expect(view.downloading).toBe(kind);
			push(kind, "new socket", tag(echoed, nth(kind, 0).request));
			answer(nth(kind, 0).id);
			await retry;

			expect(await handed()).toEqual([file(kind, "new socket")]);
		},
	);
});
