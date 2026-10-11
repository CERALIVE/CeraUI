// @vitest-environment jsdom
/**
 * The Updates dialog's device reads and actions under REAL transport timing.
 *
 * Nothing here is a stand-in for the code under review: the requests travel
 * through the real `rpc` proxy and `RPCClient` (with its 30 s call timeout and
 * its half-open watchdog), and every action through the real keyed
 * async-operation store. Only the device is scripted, on a fake socket that
 * answers exactly the request a test names — which is what lets a test resolve
 * two reads in the reverse of the order they were sent.
 *
 * C-M1: a reply that never arrived is not a refusal. The backend answers
 * `installUpdatesNow` only after the OS stage finishes, which takes minutes;
 * the browser gives up after 30 s. Until 8fae0f55 that timeout rendered as
 * "Not started" and stayed there after the device had staged the image.
 *
 * C-M2: ONE latest-read counter owns `details`, and closing the dialog fences
 * every write that was still in flight.
 */
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateSettings,
} from "@ceraui/rpc/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "../rpc/async-operation.svelte";
import { rpcClient } from "../rpc/client";
import {
	createUpdateSurface,
	type UpdateSurface,
} from "./update-surface.svelte";

// ── scripted device ────────────────────────────────────────────────────────

interface SentRequest {
	readonly id: string;
	readonly path: string;
	readonly input: unknown;
}

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static current: FakeWebSocket | undefined;

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
		if (frame.id !== undefined && Array.isArray(frame.path))
			this.sent.push({
				id: frame.id,
				path: frame.path.join("."),
				input: frame.input,
			});
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

function socket(): FakeWebSocket {
	const current = FakeWebSocket.current;
	if (current === undefined) throw new Error("no socket");
	return current;
}

function requests(path: string): SentRequest[] {
	return socket().sent.filter((request) => request.path === path);
}

function outstanding(path: string): SentRequest[] {
	return requests(path).filter((request) => !socket().answered.has(request.id));
}

/** Answer ONE outstanding request for `path` — the oldest unless told otherwise. */
function answer(
	path: string,
	result: unknown,
	which: "oldest" | "newest" = "oldest",
): void {
	const open = outstanding(path);
	const request = which === "oldest" ? open[0] : open[open.length - 1];
	if (request === undefined) throw new Error(`no outstanding ${path}`);
	socket().answered.add(request.id);
	socket().deliver({ id: request.id, result });
}

function refuse(path: string, code: string): void {
	const request = outstanding(path)[0];
	if (request === undefined) throw new Error(`no outstanding ${path}`);
	socket().answered.add(request.id);
	socket().deliver({ id: request.id, error: { message: code, code } });
}

/** Let every queued promise continuation run without moving the clock. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/**
 * Let `ms` of wall time pass on a LIVE link: the device keeps the socket warm
 * the way its status pushes do, so the half-open watchdog has no reason to
 * fire and the only thing that can end the call is the client's own timeout.
 */
async function elapse(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 5_000) {
		await vi.advanceTimersByTimeAsync(Math.min(5_000, left));
		if (socket().readyState === FakeWebSocket.OPEN)
			socket().deliver({ ping: { t: Date.now() } });
	}
}

// ── fixtures ───────────────────────────────────────────────────────────────

const RPC_TIMEOUT_MS = 30_000;
const STAGED_VERSION = "2026.10.76";

const CAPABLE: UpdateCapabilities = {
	mode: "capable",
	features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
};

const SETTINGS: UpdateSettings = {
	packagesAuto: true,
	systemAuto: true,
	schedule: { mode: "any-idle", start: "03:00", end: "05:00" },
	channel: "stable",
	allowPackagesOverCellular: true,
	allowSystemOverCellular: false,
};

function details(os: Partial<UpdateDetails["os"]> = {}): UpdateDetails {
	return {
		slots: null,
		os: {
			bootedVersion: "2026.10.70",
			staged: null,
			candidate: { version: STAGED_VERSION, sizeBytes: 734_003_200 },
			...os,
		},
		checks: {
			packages: {
				lastAttemptAt: 1_000,
				lastSuccessAt: 1_000,
				nextAttemptAt: 9_000,
			},
			os: { lastAttemptAt: 1_000, lastSuccessAt: 1_000, nextAttemptAt: 9_000 },
		},
		pendingCellular: null,
		transport: null,
	};
}

const OFFERED = details();
const STAGED = details({
	staged: { version: STAGED_VERSION, stagedAt: 5_000 },
	candidate: null,
});

async function openSurface(): Promise<UpdateSurface> {
	const surface = createUpdateSurface();
	const opening = surface.load();
	answer("system.getUpdateCapabilities", CAPABLE);
	answer("system.getUpdateSettings", SETTINGS);
	answer("system.getUpdateDetails", OFFERED);
	await opening;
	return surface;
}

// ── harness ────────────────────────────────────────────────────────────────

const realWebSocket = globalThis.WebSocket;
// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.current = undefined;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://device.test/ws";
	rpcClient.connect();
	socket().readyState = FakeWebSocket.OPEN;
	socket().onopen?.();
});

afterEach(() => {
	rpcClient.disconnect();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	destroyAsyncOperations();
	vi.useRealTimers();
});

// ── C-M1 ───────────────────────────────────────────────────────────────────

describe("an action whose reply never arrived (C-M1)", () => {
	it("is reported unconfirmed, never refused, and clears once the device shows the staged image", async () => {
		// Given an image offered for installation.
		const surface = await openSurface();

		// When the device stages for longer than the browser waits for its reply.
		const install = surface.installNow();
		await elapse(RPC_TIMEOUT_MS + 1_000);
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then the request is NOT reported as refused: nothing said it was.
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBe("install");

		// When the authoritative state arrives: a read that shows the staged image.
		const reread = surface.reloadDetails();
		answer("system.getUpdateDetails", STAGED);
		await reread;

		// Then the outcome is confirmed and the uncertainty is gone.
		expect(surface.details?.os.staged?.version).toBe(STAGED_VERSION);
		expect(surface.unconfirmed).toBeUndefined();
		expect(surface.refusal).toBeUndefined();
	});

	it("stays busy for as long as the browser still waits for the reply, then stops", async () => {
		// Given an install in flight.
		const surface = await openSurface();
		const install = surface.installNow();
		await settle();
		expect(surface.pending("install")).toBe(true);

		// When most of the client's timeout has passed.
		await elapse(RPC_TIMEOUT_MS - 5_000);

		// Then the control is still busy: a second click would race the first.
		expect(surface.pending("install")).toBe(true);

		// When the client gives up.
		await elapse(10_000);
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then the spinner ends; it cannot run forever.
		expect(surface.pending("install")).toBe(false);
	});

	it("settles at once when the device's phase moved before the reply was abandoned", async () => {
		// Given an install in flight.
		const surface = await openSurface();
		const install = surface.installNow();
		await settle();

		// When the pushed phase shows the stage starting, and the reply never comes.
		const phaseRead = surface.observePhase("os-staging");
		answer("system.getUpdateDetails", OFFERED);
		await phaseRead;
		await elapse(RPC_TIMEOUT_MS + 1_000);
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then the device itself confirmed the start: no band of any kind.
		expect(surface.unconfirmed).toBeUndefined();
		expect(surface.refusal).toBeUndefined();
	});

	it("treats a socket dropped mid-request as unconfirmed too", async () => {
		// Given a check in flight.
		const surface = await openSurface();
		const check = surface.checkNow();
		await settle();

		// When the socket drops before any reply.
		socket().close();
		await check;

		// Then nothing claims the device refused.
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBe("check");
	});

	it("still reports an explicit device refusal as not started", async () => {
		// Given an install the device declines.
		const surface = await openSurface();
		const install = surface.installNow();
		await settle();

		// When the device answers with its refusal.
		answer("system.installUpdatesNow", { success: false, error: "busy" });
		await settle();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then that refusal is what the operator sees.
		expect(surface.refusal).toEqual({ action: "install", reason: "busy" });
		expect(surface.unconfirmed).toBeUndefined();
	});

	it("keeps a typed RPC refusal (the startup envelope) on the refusal path", async () => {
		// Given an install the orchestrator refuses while it initialises.
		const surface = await openSurface();
		const install = surface.installNow();
		await settle();

		// When the device answers with the typed error envelope.
		refuse("system.installUpdatesNow", "UPDATE_ORCHESTRATOR_INITIALIZING");
		await settle();
		answer("system.getUpdateDetails", OFFERED);
		await install;

		// Then it is a device answer, not an uncertainty.
		expect(surface.refusal?.reason).toBe("UPDATE_ORCHESTRATOR_INITIALIZING");
		expect(surface.unconfirmed).toBeUndefined();
	});

	it("a new attempt replaces the previous unconfirmed outcome", async () => {
		// Given a check whose reply was lost.
		const surface = await openSurface();
		const lost = surface.checkNow();
		await elapse(RPC_TIMEOUT_MS + 1_000);
		answer("system.getUpdateDetails", OFFERED);
		await lost;
		expect(surface.unconfirmed).toBe("check");

		// When the operator checks again and the device answers this time.
		const again = surface.checkNow();
		await settle();
		expect(surface.unconfirmed).toBeUndefined();
		// The first request's id is long dead in the client; answer the new one.
		answer("system.checkUpdatesNow", { success: true }, "newest");
		await settle();
		answer("system.getUpdateDetails", OFFERED);
		await again;

		// Then nothing stale remains.
		expect(surface.unconfirmed).toBeUndefined();
		expect(surface.refusal).toBeUndefined();
	});
});

// ── C-M2 ───────────────────────────────────────────────────────────────────

describe("one latest read owns the details (C-M2)", () => {
	it("never lets the opening snapshot overwrite a newer phase-triggered read", async () => {
		// Given the open's read A and a phase-change read B, both in flight.
		const surface = createUpdateSurface();
		const opening = surface.load();
		const phaseRead = surface.reloadDetails();
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);

		// When B (newer) answers first with the staged image, then A answers late.
		answer("system.getUpdateDetails", STAGED, "newest");
		await phaseRead;
		answer("system.getUpdateDetails", OFFERED, "oldest");
		await opening;

		// Then the newer read stands; the open's other reads still landed.
		expect(surface.details?.os.staged?.version).toBe(STAGED_VERSION);
		expect(surface.capabilities).toEqual(CAPABLE);
		expect(surface.settings).toEqual(SETTINGS);
		expect(surface.loaded).toBe(true);
	});

	it("applies reads that resolve in the order they were sent", async () => {
		// Given an open, then a phase-change read.
		const surface = createUpdateSurface();
		const opening = surface.load();
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);
		answer("system.getUpdateDetails", OFFERED);
		await opening;

		// When the later read answers.
		const phaseRead = surface.reloadDetails();
		answer("system.getUpdateDetails", STAGED);
		await phaseRead;

		// Then it is applied.
		expect(surface.details?.os.staged?.version).toBe(STAGED_VERSION);
	});

	it("never lets an older settings read overwrite a newer save echo", async () => {
		// Given a loaded dialog whose Retry re-reads everything.
		const surface = await openSurface();
		const retry = surface.load();
		await settle();

		// When the operator's save is echoed before the older read returns.
		const saved = surface.save({ packagesAuto: false });
		await settle();
		answer("system.setUpdateSettings", { ...SETTINGS, packagesAuto: false });
		await saved;
		answer("system.getUpdateCapabilities", CAPABLE);
		answer("system.getUpdateSettings", SETTINGS);
		answer("system.getUpdateDetails", OFFERED);
		await retry;

		// Then the device's newer echo stands.
		expect(surface.settings?.packagesAuto).toBe(false);
	});

	it("drops a read from a previous open after close and reopen", async () => {
		// Given an open whose reads are still in flight when the dialog closes.
		const surface = createUpdateSurface();
		const first = surface.load();
		surface.reset();

		// When the dialog reopens and the new reads answer before the old ones.
		const second = surface.load();
		answer("system.getUpdateCapabilities", CAPABLE, "newest");
		answer("system.getUpdateSettings", SETTINGS, "newest");
		answer("system.getUpdateDetails", STAGED, "newest");
		await second;
		answer("system.getUpdateCapabilities", { mode: "legacy", features: [] });
		answer("system.getUpdateSettings", { ...SETTINGS, channel: "beta" });
		answer("system.getUpdateDetails", OFFERED);
		await first;

		// Then only the current open's answers are on screen.
		expect(surface.capabilities).toEqual(CAPABLE);
		expect(surface.settings?.channel).toBe("stable");
		expect(surface.details?.os.staged?.version).toBe(STAGED_VERSION);
	});

	it("fences an action result that lands after close, and starts no read for it", async () => {
		// Given a check in flight when the dialog closes.
		const surface = await openSurface();
		const check = surface.checkNow();
		await settle();
		surface.reset();
		const readsAtClose = requests("system.getUpdateDetails").length;

		// When the device's refusal arrives after the close.
		answer("system.checkUpdatesNow", { success: false, error: "busy" });
		await settle();

		// Then the closed dialog carries nothing into the next open.
		expect(surface.refusal).toBeUndefined();
		expect(surface.unconfirmed).toBeUndefined();
		expect(requests("system.getUpdateDetails")).toHaveLength(readsAtClose);
		await check;
	});

	it("fences a save that fails after close", async () => {
		// Given a save in flight when the dialog closes.
		const surface = await openSurface();
		const saved = surface.save({ channel: "beta" });
		await settle();
		surface.reset();

		// When the device rejects it after the close.
		refuse("system.setUpdateSettings", "VALIDATION_ERROR");
		await saved;

		// Then the next open does not inherit a failure band for it.
		expect(surface.saveFailed).toBe(false);
		expect(surface.settings?.channel).toBe("stable");
	});
});
