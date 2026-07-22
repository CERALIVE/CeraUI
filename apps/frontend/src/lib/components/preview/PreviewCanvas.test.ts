// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	resetHarnessConfig,
	setHarnessSource,
} from "../../../tests/fixtures/preview-config-harness.svelte";
import PreviewCanvas from "./PreviewCanvas.svelte";
import {
	cappedAttemptText,
	derivePreviewAvailability,
} from "./preview-availability";
import { DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS } from "./preview-tier-ladder";

// Controllable capability snapshot: the component reads it through
// getCapabilities() to decide whether the preview is dialable.
const capsMock = vi.hoisted(() => ({ value: undefined as unknown }));
// getConfig() is delegated to a compiled rune harness so a source change drives the
// applied-source follow effect reactively (a plain mock can't — see the harness).
vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const harness = await import(
		"../../../tests/fixtures/preview-config-harness.svelte"
	);
	return {
		getCapabilities: () => capsMock.value,
		getConfig: () => harness.getHarnessConfig(),
	};
});

// Single-use token minted over the authenticated RPC socket before every dial.
const mintMock = vi.hoisted(() =>
	vi.fn(async () => ({ token: "tok-1", ttlMs: 30000 })),
);
vi.mock("$lib/rpc", () => ({
	rpc: { system: { mintPreviewToken: mintMock } },
}));

// The preview URL is now the backend origin `/preview` — never the engine port.
vi.mock("$lib/env", () => ({
	getPreviewSocketUrl: (token: string) =>
		`ws://localhost/preview?token=${token}`,
}));

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	binaryType = "blob";
	onopen: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: ((e: { code?: number }) => void) | null = null;
	readyState = 0;
	sent: unknown[] = [];
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: unknown): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
	}
}

class DecoderStub {
	state = "configured";
	configure(): void {}
	decode(): void {}
	close(): void {}
}

// Flush the async mint→dial chain (a couple microtask turns) plus Svelte ticks.
async function flush(): Promise<void> {
	await tick();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await tick();
}

async function turnOn(getByTestId: (id: string) => HTMLElement): Promise<void> {
	await fireEvent.click(getByTestId("preview-toggle"));
	await flush();
}

// Same microtask/tick drain as `flush`, used from fake-timer tests for symmetry.
const flushFake = flush;

// Drive a socket to a live-ish session: open + codec-config (→ `waiting`, clears
// the media watchdog, marks the session as having progressed).
function goLive(ws: FakeWebSocket | undefined): void {
	ws?.onopen?.({});
	ws?.onmessage?.({
		data: JSON.stringify({
			type: "codec-config",
			tier: "webcodecs",
			codec: "avc1.42001f",
		}),
	});
}

// jsdom leaves the tab permanently visible; override the getter + fire the event
// so the component's viewer-liveness effect observes the change.
function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => (hidden ? "hidden" : "visible"),
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
	// Unmount first: a leaked component still reacts to the shared harness $state,
	// so it must be gone before resetHarnessConfig() flips the source back.
	cleanup();
	FakeWebSocket.instances = [];
	capsMock.value = undefined;
	mintMock.mockReset();
	mintMock.mockImplementation(async () => ({ token: "tok-1", ttlMs: 30000 }));
	resetHarnessConfig();
	setDocumentHidden(false);
	vi.unstubAllGlobals();
});

describe("PreviewCanvas", () => {
	it("shows the toggle and stays off until the operator enables it", () => {
		const { container } = render(PreviewCanvas);
		expect(
			container.querySelector('[data-testid="preview-toggle"]'),
		).not.toBeNull();
		// Off by default: no media surface, no live session.
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
		expect(container.querySelector('[data-testid="preview-video"]')).toBeNull();
	});

	it("shows the 'preview off' copy (not noSignal) while the toggle is off", () => {
		const { getByTestId } = render(PreviewCanvas);
		const off = getByTestId("preview-off");
		expect(off).not.toBeNull();
		expect(off.textContent).toMatch(/preview off/i);
	});

	it("mints a token then opens a WebCodecs canvas dialing the backend /preview", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { container, getByTestId } = render(PreviewCanvas);

		await turnOn(getByTestId);

		const section = getByTestId("preview");
		expect(section.getAttribute("data-tier")).toBe("webcodecs");
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-level-meter"]'),
		).not.toBeNull();

		// A token was minted and the dial URL is the backend origin + token.
		expect(mintMock).toHaveBeenCalledTimes(1);
		const ws = FakeWebSocket.instances.at(-1);
		expect(ws).toBeDefined();
		expect(ws?.url).toBe("ws://localhost/preview?token=tok-1");

		// The session handshake is sent on open.
		ws?.onopen?.({});
		expect(ws?.sent).toContain(
			JSON.stringify({ action: "start", tier: "webcodecs" }),
		);
	});

	it("falls back to the unsupported message when no codec path exists", async () => {
		for (const target of [window, globalThis] as Record<string, unknown>[]) {
			delete target.VideoDecoder;
			delete target.MediaSource;
		}
		const { container, getByTestId } = render(PreviewCanvas);

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(getByTestId("preview").getAttribute("data-tier")).toBe("none");
		expect(getByTestId("preview").getAttribute("data-status")).toBe(
			"unsupported",
		);
		// No token is minted when the browser cannot decode anything.
		expect(mintMock).not.toHaveBeenCalled();
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("tears the session down on toggle-off", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { container, getByTestId } = render(PreviewCanvas);

		await turnOn(getByTestId);
		const ws = FakeWebSocket.instances.at(-1);
		const closeSpy = vi.spyOn(ws as FakeWebSocket, "close");

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(closeSpy).toHaveBeenCalled();
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("renders a calm engine-offline band and never dials when the engine is unavailable", async () => {
		capsMock.value = { engineUnavailable: true };
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { container, getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		const band = getByTestId("preview-unavailable");
		expect(band.getAttribute("data-reason")).toBe("engineOffline");
		expect(band.getAttribute("role")).toBe("status");
		// No token minted, no socket dial — the band replaces the media surface.
		expect(mintMock).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("names the engine-starting condition in its own band", async () => {
		capsMock.value = { engineStarting: true };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineStarting",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("renders the preview-unavailable band when the engine reports preview unbound", async () => {
		capsMock.value = { preview: { enabled: true, bound: false } };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"previewUnavailable",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("maps close code 4502 to the engine-offline band", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4502 });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineOffline",
		);
	});

	it("maps close code 4503 to the preview-unavailable band", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4503 });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"previewUnavailable",
		);
	});

	it("re-mints once on 4401, then surfaces the tokenRejected band on a second 4401", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(mintMock).toHaveBeenCalledTimes(1);

		// First 4401 → one silent re-mint + re-dial (no band yet).
		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4401 });
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(mintMock).toHaveBeenCalledTimes(2);

		// Second 4401 → surface the DISTINCT tokenRejected band (was engineOffline),
		// no further re-mint. The engine is reachable; only the authorization failed.
		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4401 });
		await tick();
		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"tokenRejected",
		);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("surfaces the mintFailed band when the token mint RPC throws", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		mintMock.mockRejectedValue(new Error("rpc down"));

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		// The mint threw before any dial: a distinct band, NOT a silent reconnect loop.
		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"mintFailed",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("maps close code 4502 with backpressure_overflow to its own band, not engineOffline", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		FakeWebSocket.instances
			.at(-1)
			?.onclose?.({ code: 4502, reason: "backpressure_overflow" });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"backpressure",
		);
	});

	for (const [reason, band] of [
		["no-source-applied", "noSourceApplied"],
		["source-unavailable", "sourceUnavailable"],
		["device-busy", "deviceBusy"],
		["pipeline-failed", "pipelineFailed"],
	] as const) {
		it(`renders a distinct band for the engine failure frame '${reason}'`, async () => {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await turnOn(getByTestId);

			FakeWebSocket.instances.at(-1)?.onopen?.({});
			await tick();
			FakeWebSocket.instances
				.at(-1)
				?.onmessage?.({ data: JSON.stringify({ type: "error", reason }) });
			await tick();

			expect(
				getByTestId("preview-unavailable").getAttribute("data-reason"),
			).toBe(band);
		});
	}

	it("accepts the reason-as-type engine failure frame shape too", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);
		FakeWebSocket.instances.at(-1)?.onopen?.({});
		await tick();
		FakeWebSocket.instances
			.at(-1)
			?.onmessage?.({ data: JSON.stringify({ type: "device-busy" }) });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"deviceBusy",
		);
	});

	it("sends the applied config.source as input_id on the start frame", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		setHarnessSource("video1");

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		const ws = FakeWebSocket.instances.at(-1);
		ws?.onopen?.({});
		expect(ws?.sent).toContain(
			JSON.stringify({
				action: "start",
				tier: "webcodecs",
				input_id: "video1",
			}),
		);
	});

	it("surfaces the terminal interrupted band once a was-live session exhausts its reconnect budget", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			// Progress the session past connecting (codec-config → waiting), so an
			// exhausted reconnect budget is a was-live drop, not a never-connected one.
			FakeWebSocket.instances.at(-1)?.onopen?.({});
			await tick();
			FakeWebSocket.instances.at(-1)?.onmessage?.({
				data: JSON.stringify({
					type: "codec-config",
					tier: "webcodecs",
					codec: "avc1.42001f",
				}),
			});
			await tick();

			// Drop repeatedly; each backoff redials, until the budget (5) is spent.
			for (let i = 0; i < 8; i++) {
				FakeWebSocket.instances.at(-1)?.onclose?.({});
				await tick();
				vi.advanceTimersByTime(20000);
				for (let j = 0; j < 6; j++) await Promise.resolve();
				await tick();
			}

			expect(
				getByTestId("preview-unavailable").getAttribute("data-reason"),
			).toBe("interrupted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces the noVideo band when the socket opens but stays silent past the media watchdog", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();
			expect(FakeWebSocket.instances).toHaveLength(1);

			// The socket opens and sends `start`, arming the media watchdog — but the
			// engine (idle: no program pipeline to tap) never delivers codec-config.
			FakeWebSocket.instances.at(-1)?.onopen?.({});
			await tick();
			expect(getByTestId("preview").getAttribute("data-status")).toBe(
				"connecting",
			);

			// The deadline elapses with no media → the calm noVideo band, not an
			// endless "Connecting…".
			vi.advanceTimersByTime(8000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(
				getByTestId("preview-unavailable").getAttribute("data-reason"),
			).toBe("noVideo");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stands the media watchdog down once codec-config arrives (no noVideo band)", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { container, getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			const ws = FakeWebSocket.instances.at(-1);
			ws?.onopen?.({});
			await tick();

			// The engine delivers codec-config → media is flowing; the watchdog is
			// cancelled and the status advances past "connecting".
			ws?.onmessage?.({
				data: JSON.stringify({
					type: "codec-config",
					tier: "webcodecs",
					codec: "avc1.42001f",
				}),
			});
			await tick();
			expect(getByTestId("preview").getAttribute("data-status")).toBe(
				"waiting",
			);

			// Even past the former deadline, no noVideo band is raised.
			vi.advanceTimersByTime(8000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(
				container.querySelector('[data-testid="preview-unavailable"]'),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects while mounted when the socket drops (timer fires)", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"VideoDecoder",
				class {
					state = "configured";
					configure(): void {}
					decode(): void {}
					close(): void {}
				},
			);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();
			expect(FakeWebSocket.instances).toHaveLength(1);

			// A dropped socket with no code while the toggle is on → bounded reconnect.
			FakeWebSocket.instances.at(-1)?.onclose?.({});
			await tick();

			// Advancing past the capped+jittered backoff (<=650ms for attempt 0)
			// fires the timer and dials a fresh socket while still mounted.
			vi.advanceTimersByTime(2000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a scheduled reconnect timer inert after unmount", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal(
				"VideoDecoder",
				class {
					state = "configured";
					configure(): void {}
					decode(): void {}
					close(): void {}
				},
			);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId, unmount } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			// Drop the socket to schedule a reconnect timer, then unmount.
			FakeWebSocket.instances.at(-1)?.onclose?.({});
			await tick();
			const beforeUnmount = FakeWebSocket.instances.length;

			unmount();

			// The unmounted timer must be inert: no new socket construction,
			// no state mutation after teardown.
			vi.advanceTimersByTime(2000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(FakeWebSocket.instances.length).toBe(beforeUnmount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tears down and redials exactly once when the applied config source changes while running", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		setHarnessSource("video0");

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		expect(FakeWebSocket.instances).toHaveLength(1);
		const first = FakeWebSocket.instances[0]!;
		first.onopen?.({});
		await tick();
		expect(mintMock).toHaveBeenCalledTimes(1);

		// The APPLIED (broadcast-confirmed) source changes → teardown + fresh redial.
		setHarnessSource("video1");
		await flush();

		// The old socket is closed and exactly one new socket is dialed.
		expect(first.readyState).toBe(3);
		const open = FakeWebSocket.instances.filter((w) => w.readyState !== 3);
		expect(open).toHaveLength(1);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(mintMock).toHaveBeenCalledTimes(2);
	});

	it("does not dial when the applied source changes while the preview is disabled", async () => {
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		setHarnessSource("video0");

		const { getByTestId } = render(PreviewCanvas);
		// Preview stays OFF (never toggled on).
		expect(getByTestId("preview-off")).not.toBeNull();

		setHarnessSource("video1");
		await flush();

		// Disabled → the follow effect is a no-op: no token minted, no socket dialed.
		expect(mintMock).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("dials exactly one live socket on a rapid double source change with a delayed mint (double-dial guard)", async () => {
		// Controllable mint: capture each resolver so a restart lands while a mint is
		// still in flight.
		const resolvers: Array<(value: { token: string; ttlMs: number }) => void> =
			[];
		mintMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		);
		vi.stubGlobal("VideoDecoder", DecoderStub);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		setHarnessSource("video0");

		const { getByTestId } = render(PreviewCanvas);

		// Enable → connect() #1 awaits mint #1 (held). Resolve it so socket #1 opens
		// and the status is live-ish, arming the source-change restart path.
		await fireEvent.click(getByTestId("preview-toggle"));
		await flush();
		expect(resolvers).toHaveLength(1);
		resolvers[0]!({ token: "tok-1", ttlMs: 30000 });
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(1);
		FakeWebSocket.instances[0]!.onopen?.({});
		await tick();

		// Rapid double source change: each restart's start() mints a fresh (held)
		// token, so mint #2 (now superseded) and mint #3 are both in flight.
		setHarnessSource("video1");
		await flush();
		setHarnessSource("video2");
		await flush();
		expect(resolvers).toHaveLength(3);

		// Resolve the STALE mint #2 first: its connect must abort (no socket). Then
		// resolve the current mint #3: it dials the sole live socket.
		resolvers[1]!({ token: "tok-2", ttlMs: 30000 });
		await flush();
		resolvers[2]!({ token: "tok-3", ttlMs: 30000 });
		await flush();

		// Exactly ONE live socket, zero leaked dials: socket #1 closed by the first
		// restart's stop(); stale mint #2 opened nothing; mint #3 opened the one live
		// socket.
		const open = FakeWebSocket.instances.filter((w) => w.readyState !== 3);
		expect(open).toHaveLength(1);
	});

	it("auto-stops after 30s unwatched into pausedHidden and resumes via the affordance", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await flushFake();
			goLive(FakeWebSocket.instances.at(-1));
			await tick();

			// Hide the tab → the viewer-liveness window arms. <30s is not enough yet.
			setDocumentHidden(true);
			await flushFake();
			vi.advanceTimersByTime(29000);
			await flushFake();
			expect(FakeWebSocket.instances[0]?.readyState).not.toBe(3);

			// The full window elapses → clean socket close + the distinct pausedHidden
			// band (NOT an error) with a resume affordance.
			vi.advanceTimersByTime(2000);
			await flushFake();
			expect(FakeWebSocket.instances[0]?.readyState).toBe(3);
			expect(
				getByTestId("preview-unavailable").getAttribute("data-reason"),
			).toBe("pausedHidden");
			expect(getByTestId("preview-resume")).not.toBeNull();

			// Resume redials a fresh socket.
			setDocumentHidden(false);
			await fireEvent.click(getByTestId("preview-resume"));
			await flushFake();
			expect(
				FakeWebSocket.instances.filter((w) => w.readyState !== 3).length,
			).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not tear down on a <30s visibility blip", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { container, getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await flushFake();
			goLive(FakeWebSocket.instances.at(-1));
			await tick();

			setDocumentHidden(true);
			await flushFake();
			vi.advanceTimersByTime(20000);
			await flushFake();
			// Re-viewed before the window elapses → timer cancelled.
			setDocumentHidden(false);
			await flushFake();
			vi.advanceTimersByTime(20000);
			await flushFake();

			expect(FakeWebSocket.instances[0]?.readyState).not.toBe(3);
			expect(
				container.querySelector('[data-testid="preview-unavailable"]'),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("redials when the tab becomes visible again after a pausedHidden teardown", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await flushFake();
			goLive(FakeWebSocket.instances.at(-1));
			await tick();

			setDocumentHidden(true);
			await flushFake();
			vi.advanceTimersByTime(30000);
			await flushFake();
			expect(FakeWebSocket.instances[0]?.readyState).toBe(3);

			// Re-view → auto-redial, no manual click.
			setDocumentHidden(false);
			await flushFake();
			expect(
				FakeWebSocket.instances.filter((w) => w.readyState !== 3).length,
			).toBeGreaterThanOrEqual(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("auto-stops when the host <details> collapses (hostActive → false)", async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal("VideoDecoder", DecoderStub);
			vi.stubGlobal("WebSocket", FakeWebSocket);

			const { getByTestId, rerender } = render(PreviewCanvas, {
				props: { hostActive: true },
			});
			await fireEvent.click(getByTestId("preview-toggle"));
			await flushFake();
			goLive(FakeWebSocket.instances.at(-1));
			await tick();

			// Collapse the disclosure → unwatched → the 30s window closes the socket.
			await rerender({ hostActive: false });
			await flushFake();
			vi.advanceTimersByTime(30000);
			await flushFake();

			expect(FakeWebSocket.instances[0]?.readyState).toBe(3);
			expect(
				getByTestId("preview-unavailable").getAttribute("data-reason"),
			).toBe("pausedHidden");
		} finally {
			vi.useRealTimers();
		}
	});

	// The connecting-exit invariant: no trigger may leave `connecting` rendered
	// indefinitely — every path exits within ≤10s (8s watchdog + margin).
	const connectingExitTriggers: Array<{
		name: string;
		apply: (ws: FakeWebSocket | undefined) => void;
	}> = [
		{ name: "close 4502", apply: (ws) => ws?.onclose?.({ code: 4502 }) },
		{ name: "close 4503", apply: (ws) => ws?.onclose?.({ code: 4503 }) },
		{
			name: "backpressure",
			apply: (ws) =>
				ws?.onclose?.({ code: 4502, reason: "backpressure_overflow" }),
		},
		{
			name: "engine failure frame",
			apply: (ws) =>
				ws?.onmessage?.({
					data: JSON.stringify({ type: "error", reason: "pipeline-failed" }),
				}),
		},
		{ name: "default close", apply: (ws) => ws?.onclose?.({}) },
		{ name: "media timeout", apply: () => vi.advanceTimersByTime(8000) },
	];

	for (const trigger of connectingExitTriggers) {
		it(`exits the connecting presentation within 10s: ${trigger.name}`, async () => {
			vi.useFakeTimers();
			try {
				vi.stubGlobal("VideoDecoder", DecoderStub);
				vi.stubGlobal("WebSocket", FakeWebSocket);

				const { getByTestId } = render(PreviewCanvas);
				await fireEvent.click(getByTestId("preview-toggle"));
				await flushFake();
				FakeWebSocket.instances.at(-1)?.onopen?.({});
				await tick();
				expect(getByTestId("preview").getAttribute("data-status")).toBe(
					"connecting",
				);

				trigger.apply(FakeWebSocket.instances.at(-1));
				vi.advanceTimersByTime(10000);
				await flushFake();

				expect(getByTestId("preview").getAttribute("data-status")).not.toBe(
					"connecting",
				);
			} finally {
				vi.useRealTimers();
			}
		});
	}
});

// Minimal RTCPeerConnection double: records the answer flow and lets a test drive
// ICE state + track events. The engine is the offerer; the browser answers.
class FakeRTCPeerConnection {
	static instances: FakeRTCPeerConnection[] = [];
	iceConnectionState = "new";
	localDescription: unknown = null;
	remote: unknown = null;
	closed = false;
	onicecandidate: ((e: unknown) => void) | null = null;
	ontrack: ((e: unknown) => void) | null = null;
	oniceconnectionstatechange: (() => void) | null = null;
	// biome-ignore lint/suspicious/noExplicitAny: test double config is opaque
	constructor(public config: any) {
		FakeRTCPeerConnection.instances.push(this);
	}
	async setRemoteDescription(desc: unknown): Promise<void> {
		this.remote = desc;
	}
	async createAnswer(): Promise<{ type: string; sdp: string }> {
		return { type: "answer", sdp: "answer-sdp" };
	}
	async setLocalDescription(desc: unknown): Promise<void> {
		this.localDescription = desc;
	}
	async addIceCandidate(): Promise<void> {}
	close(): void {
		this.closed = true;
	}
}

class FakeMediaStream {
	constructor(public tracks?: unknown) {}
}

// Drive a preview socket to an OPEN WebRTC session: toggle on, flush the async
// mint→dial, then fire `onopen` (which sends `start` + builds the peer connection).
async function turnOnWebrtc(
	getByTestId: (id: string) => HTMLElement,
): Promise<FakeWebSocket> {
	await fireEvent.click(getByTestId("preview-toggle"));
	await flush();
	const ws = FakeWebSocket.instances.at(-1);
	if (!ws) throw new Error("no preview socket dialed");
	ws.onopen?.({});
	await flush();
	return ws;
}

describe("PreviewCanvas — WebRTC tier ladder", () => {
	// Browser advertises WebRTC + MSE but NOT WebCodecs → ladder is [webrtc, mse]
	// (the canonical WebRTC → MSE ladder; MSE is the floor).
	function stubWebrtcBrowser(): void {
		vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
		vi.stubGlobal("MediaStream", FakeMediaStream);
		vi.stubGlobal(
			"MediaSource",
			class {
				addEventListener(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		FakeRTCPeerConnection.instances = [];
	}

	it("starts on the WebRTC rung: badge=WebRTC and start frame carries tier=webrtc", async () => {
		stubWebrtcBrowser();
		const { getByTestId } = render(PreviewCanvas);

		const ws = await turnOnWebrtc(getByTestId);

		expect(getByTestId("preview").getAttribute("data-tier")).toBe("webrtc");
		const badge = getByTestId("preview-tier-badge");
		expect(badge.getAttribute("data-tier")).toBe("webrtc");
		expect(ws.sent).toContain(
			JSON.stringify({ action: "start", tier: "webrtc" }),
		);
		// A peer connection was created for the WebRTC session.
		expect(FakeRTCPeerConnection.instances).toHaveLength(1);
	});

	it("answers the engine offer and trickles ICE both ways", async () => {
		stubWebrtcBrowser();
		const { getByTestId } = render(PreviewCanvas);
		const ws = await turnOnWebrtc(getByTestId);

		// Engine offers → the browser answers over the WS.
		ws.onmessage?.({
			data: JSON.stringify({
				type: "webrtc-offer",
				session_id: "rtc-0",
				sdp: "offer-sdp",
			}),
		});
		await flush();
		expect(ws.sent).toContain(
			JSON.stringify({ action: "webrtc-answer", sdp: "answer-sdp" }),
		);

		// A locally-gathered host candidate is trickled to the engine.
		const pc = FakeRTCPeerConnection.instances.at(-1);
		pc?.onicecandidate?.({
			candidate: {
				candidate: "candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host",
				sdpMLineIndex: 0,
			},
		});
		expect(
			ws.sent.some(
				(s) => typeof s === "string" && s.includes('"action":"webrtc-ice"'),
			),
		).toBe(true);
	});

	it("goes live when ICE connects and the first frame paints", async () => {
		stubWebrtcBrowser();
		const { container, getByTestId } = render(PreviewCanvas);
		const ws = await turnOnWebrtc(getByTestId);
		ws.onmessage?.({
			data: JSON.stringify({ type: "webrtc-offer", sdp: "offer-sdp" }),
		});
		await flush();

		const pc = FakeRTCPeerConnection.instances.at(-1);
		// The engine's track arrives; the <video> receives the stream.
		const video = container.querySelector(
			'[data-testid="preview-video"]',
		) as HTMLVideoElement;
		expect(video).not.toBeNull();
		pc?.ontrack?.({ streams: [new FakeMediaStream()], track: {} });
		ws.onmessage?.({ data: JSON.stringify({ type: "webrtc-connected" }) });
		await tick();

		// First frame paints → live.
		video.dispatchEvent(new Event("loadeddata"));
		await tick();
		expect(getByTestId("preview").getAttribute("data-status")).toBe("live");
	});

	it("falls back to MSE on a webrtc-failed frame (badge=MSE, start tier=mse)", async () => {
		stubWebrtcBrowser();
		const { getByTestId } = render(PreviewCanvas);
		const ws = await turnOnWebrtc(getByTestId);
		expect(getByTestId("preview-tier-badge").getAttribute("data-tier")).toBe(
			"webrtc",
		);

		// The engine reports a typed mid-session failure → the ladder descends.
		ws.onmessage?.({
			data: JSON.stringify({ type: "webrtc-failed", reason: "ice_timeout" }),
		});
		await flush();

		// The badge and data-tier now reflect the MSE floor …
		expect(getByTestId("preview").getAttribute("data-tier")).toBe("mse");
		expect(getByTestId("preview-tier-badge").getAttribute("data-tier")).toBe(
			"mse",
		);
		// … the WebRTC peer connection was torn down …
		expect(FakeRTCPeerConnection.instances.at(0)?.closed).toBe(true);
		// … exactly ONE live socket remains (no leaked dial from the restart) …
		const openSockets = FakeWebSocket.instances.filter(
			(w) => w.readyState !== 3,
		);
		expect(openSockets).toHaveLength(1);
		// … and it starts on the MSE tier.
		const mseWs = openSockets[0];
		expect(mseWs).not.toBe(ws);
		mseWs?.onopen?.({});
		expect(mseWs?.sent).toContain(
			JSON.stringify({ action: "start", tier: "mse" }),
		);
	});

	it("falls back to MSE within the signaling deadline when no offer arrives (TIMED)", async () => {
		vi.useFakeTimers();
		try {
			stubWebrtcBrowser();
			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await flushFake();
			FakeWebSocket.instances.at(-1)?.onopen?.({});
			await flushFake();
			// On the WebRTC rung, still awaiting the engine's offer.
			expect(getByTestId("preview-tier-badge").getAttribute("data-tier")).toBe(
				"webrtc",
			);
			expect(FakeRTCPeerConnection.instances).toHaveLength(1);

			// The signaling budget elapses with no offer → the ladder must have
			// landed on the MSE floor by the deadline (never hang on WebRTC).
			vi.advanceTimersByTime(DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS);
			await flushFake();

			expect(getByTestId("preview").getAttribute("data-tier")).toBe("mse");
			expect(getByTestId("preview-tier-badge").getAttribute("data-tier")).toBe(
				"mse",
			);
			// The dropped peer connection was torn down.
			expect(FakeRTCPeerConnection.instances.at(0)?.closed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("descends only to the floor — a stray webrtc frame on MSE does not re-ladder", async () => {
		stubWebrtcBrowser();
		const { getByTestId } = render(PreviewCanvas);
		const ws = await turnOnWebrtc(getByTestId);

		ws.onmessage?.({ data: JSON.stringify({ type: "webrtc-failed" }) });
		await flush();
		expect(getByTestId("preview").getAttribute("data-tier")).toBe("mse");

		const mseWs = FakeWebSocket.instances.at(-1);
		mseWs?.onopen?.({});
		const dialsAfterFallback = FakeWebSocket.instances.length;
		const pcsAfterFallback = FakeRTCPeerConnection.instances.length;

		// A stray webrtc-failed on the MSE floor is ignored (signaling is only
		// meaningful on the WebRTC rung) — no re-ladder, no new peer connection.
		mseWs?.onmessage?.({ data: JSON.stringify({ type: "webrtc-failed" }) });
		await flush();
		expect(getByTestId("preview").getAttribute("data-tier")).toBe("mse");
		expect(FakeRTCPeerConnection.instances.length).toBe(pcsAfterFallback);
		expect(FakeWebSocket.instances.length).toBe(dialsAfterFallback);
	});
});

describe("derivePreviewAvailability", () => {
	it("treats an absent snapshot and an absent preview field as available", () => {
		expect(derivePreviewAvailability(undefined)).toBe("available");
		expect(derivePreviewAvailability({} as never)).toBe("available");
	});

	it("maps engine flags to their own conditions (starting wins over offline)", () => {
		expect(derivePreviewAvailability({ engineStarting: true } as never)).toBe(
			"engineStarting",
		);
		expect(
			derivePreviewAvailability({ engineUnavailable: true } as never),
		).toBe("engineOffline");
		expect(
			derivePreviewAvailability({
				engineStarting: true,
				engineUnavailable: true,
			} as never),
		).toBe("engineStarting");
	});

	it("flags preview unavailable when the engine reports it unbound or disabled", () => {
		expect(
			derivePreviewAvailability({
				preview: { enabled: true, bound: false },
			} as never),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability({
				preview: { enabled: false, bound: true },
			} as never),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability({
				preview: { enabled: true, bound: true },
			} as never),
		).toBe("available");
	});
});

describe("cappedAttemptText", () => {
	it("is empty before the first reconnect and caps at the ceiling", () => {
		expect(cappedAttemptText(0)).toBe("");
		expect(cappedAttemptText(1)).toBe("1");
		expect(cappedAttemptText(4)).toBe("4");
		expect(cappedAttemptText(5)).toBe("5+");
		expect(cappedAttemptText(99)).toBe("5+");
	});
});
