/**
 * Preview WebSocket + WebCodecs harness for the EncoderDialog live-preview specs
 * (#72). cerastream serves the preview socket directly on its own port (9997),
 * which the e2e mock backend does NOT run — so the real PreviewCanvas would only
 * ever reach the transient `reconnecting` state. This harness lets a spec drive
 * the component through its real states deterministically, with NO network dial:
 *
 *   • `installPreviewHarness(token)` (an `addInitScript` payload) replaces
 *     `window.WebSocket` with a factory that hooks the RPC socket (auth-login
 *     token rewrite, exactly like the field-lock/capability harness) and returns
 *     a fully in-page fake for the preview socket (matched by the `:9997` port).
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
	const PREVIEW_PORT = "9997";

	w.__ceraPreview = {
		socket: null,
		rpcSocket: null,
		created: 0,
		_errorCb: null,
		open() {
			w.__ceraPreview.socket?.onopen?.({});
		},
		// Push a manual server config over the RPC socket so LiveView leaves its
		// empty state and renders the encoder edit row (the mock login snapshot
		// has no server). Mirrors the capability spec's `injectBroadcast`.
		injectConfig() {
			w.__ceraPreview.rpcSocket?.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({
						config: {
							srtla_addr: "127.0.0.1",
							srtla_port: 5000,
							pipeline: "hdmi",
							max_br: 6000,
						},
					}),
				}),
			);
		},
		config() {
			w.__ceraPreview.socket?.onmessage?.({
				data: JSON.stringify({
					type: "codec-config",
					codec: "avc1.42E01E",
					coded_width: 1280,
					coded_height: 720,
				}),
			});
		},
		audio(rms: number[], peak: number[]) {
			w.__ceraPreview.socket?.onmessage?.({
				data: JSON.stringify({ type: "audio-level", rms_db: rms, peak_db: peak }),
			});
		},
		fail() {
			w.__ceraPreview._errorCb?.(new Error("decode failed"));
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
			// Mirror a real socket: fire `open` after the caller wires its handlers.
			queueMicrotask(() => this.onopen?.({}));
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
	// preview port routes to the fake while everything else stays a real socket.
	// biome-ignore lint/suspicious/noExplicitAny: native ctor signature.
	function WSFactory(this: unknown, url: string, protocols?: any) {
		if (typeof url === "string" && url.includes(`:${PREVIEW_PORT}`)) {
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
