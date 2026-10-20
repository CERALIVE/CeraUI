/**
 * A scripted device behind the REAL `rpc` proxy and `RPCClient` (its 30 s call
 * timeout, its half-open watchdog, its reconnect loop), for the Updates
 * dialog's action/outcome tests. Only the socket is fake: a test answers
 * exactly the request it names, drops the link, or reopens it, and every timer
 * is Vitest's fake clock — nothing sleeps.
 */
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateSettings,
} from "@ceraui/rpc/schemas";
import { vi } from "vitest";

import { rpcClient } from "../../lib/rpc/client";

export interface SentRequest {
	readonly id: string;
	readonly path: string;
	readonly input: unknown;
}

export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static current: FakeWebSocket | undefined;
	/** Every request sent over every socket of this test, in order. */
	static readonly log: SentRequest[] = [];

	readyState: number = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	readonly sent: SentRequest[] = [];
	readonly answered = new Set<string>();

	constructor(readonly url: string) {
		FakeWebSocket.current = this;
	}

	send(raw: string): void {
		const frame = JSON.parse(raw) as {
			id?: string;
			path?: string[];
			input?: unknown;
		};
		if (frame.id === undefined || !Array.isArray(frame.path)) return;
		const request = {
			id: frame.id,
			path: frame.path.join("."),
			input: frame.input,
		};
		this.sent.push(request);
		FakeWebSocket.log.push(request);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	deliver(frame: unknown): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

export function socket(): FakeWebSocket {
	const current = FakeWebSocket.current;
	if (current === undefined) throw new Error("no socket");
	return current;
}

/** Every request for `path` sent over any socket of this test. */
export function sentCount(path: string): number {
	return FakeWebSocket.log.filter((request) => request.path === path).length;
}

/** Requests for `path` the client is still waiting on (not answered, not given up). */
export function outstanding(path: string): SentRequest[] {
	const live = socket();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	const awaited = rpcClient["pendingRequests"];
	return live.sent.filter(
		(request) =>
			request.path === path &&
			!live.answered.has(request.id) &&
			awaited.has(request.id),
	);
}

function take(path: string, which: "oldest" | "newest"): SentRequest {
	const open = outstanding(path);
	const request = which === "oldest" ? open[0] : open[open.length - 1];
	if (request === undefined) throw new Error(`no outstanding ${path}`);
	socket().answered.add(request.id);
	return request;
}

/** Answer ONE outstanding request for `path`, the oldest unless told otherwise. */
export function answer(
	path: string,
	result: unknown,
	which: "oldest" | "newest" = "oldest",
): void {
	socket().deliver({ id: take(path, which).id, result });
}

/** Answer ONE outstanding request for `path` with the adapter's error envelope. */
export function reject(
	path: string,
	code: string,
	which: "oldest" | "newest" = "oldest",
): void {
	socket().deliver({
		id: take(path, which).id,
		error: { message: code, code },
	});
}

/** Run every queued continuation without moving the clock. */
export async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/**
 * Let `ms` of wall time pass on a LIVE link: the device keeps the socket warm
 * the way its status pushes do, so only the client's own call timeout can end
 * a request.
 */
export async function elapse(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 5_000) {
		await vi.advanceTimersByTimeAsync(Math.min(5_000, left));
		if (FakeWebSocket.current?.readyState === FakeWebSocket.OPEN)
			socket().deliver({ ping: { t: Date.now() } });
	}
}

/** The link drops: the client rejects every request still waiting on it. */
export function dropLink(): void {
	socket().close();
}

/** The client's reconnect loop opens a new socket and the device accepts it. */
export async function restoreLink(): Promise<void> {
	const dropped = FakeWebSocket.current;
	for (let waited = 0; FakeWebSocket.current === dropped; waited += 250) {
		if (waited > 60_000) throw new Error("the client never reconnected");
		await vi.advanceTimersByTimeAsync(250);
	}
	socket().readyState = FakeWebSocket.OPEN;
	socket().onopen?.();
	await flush();
}

const realWebSocket = globalThis.WebSocket;
// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];
let fixedJitter: { mockRestore(): void } | undefined;

/** Fake clock, fake socket, real client: the device is reachable and quiet. */
export function connectDevice(): void {
	vi.useFakeTimers();
	// The reconnect backoff's jitter is the only randomness on this path.
	fixedJitter = vi.spyOn(Math, "random").mockReturnValue(0.5);
	FakeWebSocket.current = undefined;
	FakeWebSocket.log.length = 0;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://device.test/ws";
	rpcClient.connect();
	socket().readyState = FakeWebSocket.OPEN;
	socket().onopen?.();
}

export function disconnectDevice(): void {
	rpcClient.disconnect();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	fixedJitter?.mockRestore();
	fixedJitter = undefined;
	vi.useRealTimers();
}

// ── contract-shaped fixtures ───────────────────────────────────────────────

export const RPC_TIMEOUT_MS = 30_000;
export const OFFERED_VERSION = "2026.10.76";
export const CELLULAR_ID = "2026.10.76";

export const CAPABLE: UpdateCapabilities = {
	mode: "capable",
	features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
};

export const SETTINGS: UpdateSettings = {
	packagesAuto: true,
	systemAuto: true,
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	channel: "stable",
	allowPackagesOverCellular: true,
	allowSystemOverCellular: false,
};

export interface DeviceFacts {
	readonly staged?: UpdateDetails["os"]["staged"];
	readonly candidate?: UpdateDetails["os"]["candidate"];
	/** Both check clocks: the last attempt and the last success, epoch ms. */
	readonly checkedAt?: number;
	readonly pendingCellular?: UpdateDetails["pendingCellular"];
}

export function deviceDetails(facts: DeviceFacts = {}): UpdateDetails {
	const at = facts.checkedAt ?? 1_000;
	const clock = { lastAttemptAt: at, lastSuccessAt: at, nextAttemptAt: 9_000 };
	return {
		slots: null,
		os: {
			bootedVersion: "2026.10.70",
			staged: facts.staged ?? null,
			candidate:
				facts.candidate === undefined
					? { version: OFFERED_VERSION, sizeBytes: 734_003_200 }
					: facts.candidate,
		},
		checks: { packages: clock, os: clock },
		pendingCellular: facts.pendingCellular ?? null,
		transport: null,
	};
}

export const OFFERED = deviceDetails();
export const STAGED = deviceDetails({
	staged: { version: OFFERED_VERSION, stagedAt: 5_000 },
	candidate: null,
});
