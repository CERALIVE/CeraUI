/**
 * Preview WebSocket + WebCodecs harness for the EncoderDialog live-preview specs
 * (#72). Since Task 20 the preview is a single-origin proxy: PreviewCanvas mints a
 * token over the RPC socket, then dials the SAME backend origin at `/preview`. This
 * harness lets a spec drive the component through its real states deterministically,
 * with NO real preview dial:
 *
 *   • `installPreviewHarness(token)` (an `addInitScript` payload) replaces
 *     `window.WebSocket` with a factory that hooks the RPC socket (auth-login
 *     token rewrite, exactly like the field-lock/capability harness) and returns
 *     a fully in-page fake for the preview socket (matched by the `/preview` path).
 *   • It also installs a controllable `VideoDecoder` so the WebCodecs tier is
 *     selected and `configure()`/decode-error are deterministic.
 *   • Control surface on `window.__ceraPreview`: `config()` (codec-config →
 *     `waiting`), `audio(rms, peak)` (audio-level event), `fail()` (decoder error
 *     → `error`), plus `created` / `socket` for orphaned-socket assertions.
 *
 * The harness never references anything outside its own body so Playwright can
 * serialize it for `addInitScript`.
 */
import fs from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

/** Load the seeded persistent auth token, or `null` when only the placeholder exists. */
export function loadE2EToken(): string | null {
	try {
		const tokensPath = path.resolve(
			import.meta.dirname,
			"../../../../backend/auth_tokens.json",
		);
		const tokens = Object.keys(
			JSON.parse(fs.readFileSync(tokensPath, "utf8")) as Record<string, true>,
		).filter((key) => key !== "placeholder");
		return tokens[0] ?? null;
	} catch {
		return null;
	}
}

/** `addInitScript` payload — must be self-contained (no closed-over references). */
export function installPreviewHarness(token: string): void {
	// biome-ignore lint/suspicious/noExplicitAny: browser harness glue.
	const w = window as any;
	if (w.__ceraPreview) return;
	const Real = w.WebSocket;

	w.__ceraPreview = {
		socket: null,
		rpcSocket: null,
		created: 0,
		_errorCb: null,
		// The preview socket is now dialed only AFTER an async
		// `system.mintPreviewToken()` RPC round-trip (Task 20), so a spec driving a
		// state right after the toggle click can run ahead of the socket. Queue
		// control ops issued before the socket exists; the socket flushes them on
		// creation so the drive stays deterministic regardless of mint timing.
		_queue: [] as Array<() => void>,
		_deliver(op: () => void) {
			if (w.__ceraPreview.socket) op();
			else w.__ceraPreview._queue.push(op);
		},
		open() {
			w.__ceraPreview.socket?.onopen?.({});
		},
		// Push a manual server config over the RPC socket so LiveView leaves its
		// empty state and renders the encoder edit row (the mock login snapshot
		// has no server). `source` un-gates the encoder-edit trigger (Task 18/19).
		// Mirrors the capability spec's `injectBroadcast`.
		injectConfig() {
			w.__ceraPreview.rpcSocket?.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						config: {
							srtla_addr: "127.0.0.1",
							srtla_port: 5000,
							pipeline: "hdmi",
							source: "hdmi",
							max_br: 6000,
						},
					}),
				}),
			);
		},
		config() {
			w.__ceraPreview._deliver(() =>
				w.__ceraPreview.socket?.onmessage?.({
					data: JSON.stringify({
						type: "codec-config",
						codec: "avc1.42E01E",
						coded_width: 1280,
						coded_height: 720,
					}),
				}),
			);
		},
		audio(rms: number[], peak: number[]) {
			w.__ceraPreview._deliver(() =>
				w.__ceraPreview.socket?.onmessage?.({
					data: JSON.stringify({ type: "audio-level", rms_db: rms, peak_db: peak }),
				}),
			);
		},
		fail() {
			w.__ceraPreview._deliver(() =>
				w.__ceraPreview._errorCb?.(new Error("decode failed")),
			);
		},
	};

	class FakeVideoDecoder {
		state = "unconfigured";
		// biome-ignore lint/suspicious/noExplicitAny: VideoDecoderInit shape.
		constructor(init: any) {
			w.__ceraPreview._errorCb = init.error;
		}
		configure(): void {
			this.state = "configured";
		}
		decode(): void {}
		close(): void {
			this.state = "closed";
		}
	}
	w.VideoDecoder = FakeVideoDecoder;
	// Force the non-WebRTC tier: the harness drives the WebCodecs path (via the
	// FakeVideoDecoder + codec-config control ops), so the tier ladder (Todo 16)
	// must NOT put WebRTC on top — the fake preview socket speaks no WebRTC offer.
	w.RTCPeerConnection = undefined;

	class FakePreviewSocket {
		url: string;
		binaryType = "blob";
		readyState = 1;
		onopen: ((e: unknown) => void) | null = null;
		onmessage: ((e: unknown) => void) | null = null;
		onerror: ((e: unknown) => void) | null = null;
		onclose: ((e: unknown) => void) | null = null;
		sent: unknown[] = [];
		constructor(url: string) {
			this.url = url;
			w.__ceraPreview.socket = this;
			w.__ceraPreview.created += 1;
			// Mirror a real socket: fire `open` after the caller wires its handlers,
			// then flush any control ops queued while the async mint was in flight.
			queueMicrotask(() => {
				this.onopen?.({});
				const queued = w.__ceraPreview._queue;
				w.__ceraPreview._queue = [];
				for (const op of queued) op();
			});
		}
		send(data: unknown): void {
			this.sent.push(data);
		}
		close(): void {
			this.readyState = 3;
			w.__ceraPreview.socket = null;
		}
		addEventListener(): void {}
		removeEventListener(): void {}
	}

	class HookedRpcWS extends Real {
		// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
		constructor(url: string, protocols?: any) {
			super(url, protocols);
			this.__realSend = Real.prototype.send.bind(this);
			w.__ceraPreview.rpcSocket = this;
		}
		// biome-ignore lint/suspicious/noExplicitAny: WebSocket.send payload union.
		send(data: any) {
			try {
				const msg = JSON.parse(data);
				if (Array.isArray(msg.path) && msg.path.join(".") === "auth.login") {
					msg.input = { token, persistent_token: true };
					return this.__realSend(JSON.stringify(msg));
				}
			} catch {
				/* non-RPC frame */
			}
			return this.__realSend(data);
		}
	}

	// A constructor that returns an object yields that object from `new`, so the
	// single-origin `/preview` dial (Task 20) routes to the fake while the RPC
	// socket (same origin, root path) stays a real, token-rewritten socket.
	// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
	function WSFactory(this: unknown, url: string, protocols?: any) {
		if (typeof url === "string" && url.includes("/preview")) {
			return new FakePreviewSocket(url);
		}
		return new HookedRpcWS(url, protocols);
	}
	Object.assign(WSFactory, {
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	});
	w.WebSocket = WSFactory;
	try {
		localStorage.setItem("auth", "e2e-token-marker");
	} catch {
		/* storage unavailable */
	}
}

/** Inject a server config so LiveView renders the encoder edit row. */
export function injectServerConfig(page: Page): Promise<void> {
	return page.evaluate(() =>
		(window as { __ceraPreview: { injectConfig: () => void } }).__ceraPreview.injectConfig(),
	);
}

/** Drive the preview into `waiting` (codec configured, no frames yet). */
export function previewConfig(page: Page): Promise<void> {
	return page.evaluate(() =>
		(window as { __ceraPreview: { config: () => void } }).__ceraPreview.config(),
	);
}

/** Push an audio-level event so the meter renders active channels. */
export function previewAudio(page: Page, rms: number[], peak: number[]): Promise<void> {
	return page.evaluate(
		([r, p]) =>
			(
				window as { __ceraPreview: { audio: (r: number[], p: number[]) => void } }
			).__ceraPreview.audio(r, p),
		[rms, peak] as const,
	);
}

/** Drive the preview into the hard `error` state via a decoder failure. */
export function previewFail(page: Page): Promise<void> {
	return page.evaluate(() =>
		(window as { __ceraPreview: { fail: () => void } }).__ceraPreview.fail(),
	);
}

/** Number of preview sockets ever constructed (leak/orphan detection). */
export function previewSocketCount(page: Page): Promise<number> {
	return page.evaluate(
		() => (window as { __ceraPreview: { created: number } }).__ceraPreview.created,
	);
}

/** Assert no live preview socket remains (the component tore it down). */
export async function expectNoOrphanPreviewSocket(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(window as { __ceraPreview: { socket: unknown } }).__ceraPreview
							.socket === null,
				),
			{ message: "preview socket should be torn down on dialog close" },
		)
		.toBe(true);
}
