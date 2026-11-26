import type { Page } from "@playwright/test";

import { type EngineAudioToken, engineAudioMixRefusal } from "../../../../backend/src/mocks/engine-audio-tokens.js";

/**
 * The Audio mixer's page-socket interceptor. The socket is proxied, never
 * rewritten, so every save and every live change reaches the real mock backend
 * and its mock engine. The proxy records the RPC frames, injects the bridged
 * `audio-level` frames the mock does not publish on the main socket, forces a
 * backend or engine refusal where a scenario needs it, and holds the device's
 * answer to a live change or an audio pick until the test releases it. A page
 * script reports, by RPC id, which answers the page's own socket has received.
 */

export interface RpcCall {
	id: unknown;
	path: string;
	input: Record<string, unknown>;
	result?: Record<string, unknown>;
}

export interface HeldReply {
	/** Resolves with the call once the device has answered it; the page has not received that answer yet. */
	readonly held: Promise<RpcCall>;
	/** Deliver the held answer to the page. */
	release(): void;
}

export interface MixerWire {
	calls(path: string): RpcCall[];
	inject(frame: Record<string, unknown>): void;
	/** Answer the next audio_inputs saves with this backend token instead. */
	refuseAudioInputs(token: string | null): void;
	/** Hold every device frame this long before the page sees it, in order; 0 stops. */
	delayServer(ms: number): void;
	/** Hold the device's answer to the next `streaming.setAudioMix`; the call itself reaches the device. */
	holdAudioMix(): HeldReply;
	/** Hold the device's answer to the next save of this audio pick; the save itself reaches the device. */
	holdAudioPick(asrc: string): HeldReply;
	/** The device's answer to the next call to this path, which the page receives as usual. */
	nextAnswer(path: string): Promise<RpcCall>;
	/** Answer `streaming.setAudioMix` as the backend does when the engine refuses with this token; null stops. */
	refuseAudioMixWithEngineToken(token: EngineAudioToken | null): void;
	/** Whether the page's own socket has received the answer to the call with this RPC id. */
	pageHasReply(id: unknown): Promise<boolean>;
	/** The answer to the call with this RPC id, once the page's own socket has received it. */
	pageReply(id: unknown): Promise<Record<string, unknown>>;
}

interface PageReplies {
	has(id: unknown): boolean;
	next(id: unknown): Promise<Record<string, unknown>>;
}

type WithPageReplies = typeof globalThis & { __mixerWireReplies: PageReplies };

interface Hold {
	matches(call: RpcCall): boolean;
	released: boolean;
	deliver?: () => void;
	settle(call: RpcCall): void;
}

export async function installMixerWire(
	page: Page,
	pageRpc: {
		bindConnectionLifecycle(browser: unknown, server: unknown): void;
		acceptServerMessage(message: string | Buffer): void;
	},
): Promise<MixerWire> {
	const byId = new Map<unknown, RpcCall>();
	const all: RpcCall[] = [];
	let refusal: string | null = null;
	let engineRefusal: EngineAudioToken | null = null;
	let route: { send: (data: string) => void } | null = null;
	let delayMs = 0;
	let held = 0;
	let tail: Promise<void> = Promise.resolve();
	const nextHolds: Hold[] = [];
	const holdsById = new Map<unknown, Hold>();

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		pageRpc.bindConnectionLifecycle(ws, server);

		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as {
					id?: unknown;
					path?: unknown;
					input?: Record<string, unknown>;
				};
				if (Array.isArray(frame.path) && frame.id !== undefined) {
					const call: RpcCall = { id: frame.id, path: frame.path.join("."), input: frame.input ?? {} };
					all.push(call);
					byId.set(frame.id, call);
					const mixSave =
						call.path === "streaming.setConfig" &&
						("audio_inputs" in call.input || call.input.audio_pick === true);
					if (refusal !== null && (mixSave || call.path === "streaming.setAudioMix")) {
						call.result = mixSave
							? { success: false, error: refusal, applied: {} }
							: { success: false, error: refusal };
						ws.send(JSON.stringify({ id: frame.id, result: call.result }));
						return;
					}
					if (call.path === "streaming.setAudioMix" && engineRefusal !== null) {
						// The backend's answer when the engine refuses: nothing reaches the device.
						const refused = engineAudioMixRefusal(engineRefusal);
						call.result = {
							success: false,
							error: refused.dataCode,
							engine_error: { code: refused.code, message: refused.message, data: { code: refused.dataCode } },
						};
						ws.send(JSON.stringify({ id: frame.id, result: call.result }));
						return;
					}
					const next = nextHolds.findIndex((hold) => hold.matches(call));
					const [hold] = next === -1 ? [] : nextHolds.splice(next, 1);
					if (hold) holdsById.set(frame.id, hold);
				}
			} catch {
				/* non-RPC frame */
			}
			server.send(message);
		});

		server.onMessage((message) => {
			pageRpc.acceptServerMessage(message);
			const text = typeof message === "string" ? message : message.toString();
			let answered: { call: RpcCall; hold: Hold } | undefined;
			try {
				const frame = JSON.parse(text) as { id?: unknown; result?: Record<string, unknown> };
				const call = frame.id === undefined ? undefined : byId.get(frame.id);
				if (call) call.result = frame.result;
				const hold = frame.id === undefined ? undefined : holdsById.get(frame.id);
				if (call && hold) {
					holdsById.delete(frame.id);
					answered = { call, hold };
				}
			} catch {
				/* non-JSON / binary frame */
			}
			if (answered) {
				const { call, hold } = answered;
				hold.deliver = () => ws.send(message);
				if (hold.released) hold.deliver();
				hold.settle(call);
				return;
			}
			if (delayMs === 0 && held === 0) {
				ws.send(message);
				return;
			}
			const due = Date.now() + delayMs;
			held += 1;
			tail = tail.then(async () => {
				const wait = due - Date.now();
				if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
				ws.send(message);
				held -= 1;
			});
		});
	});

	// Registered after the route, so it wraps Playwright's page-side socket mock and
	// records each answer as the page's own socket dispatches it.
	await page.addInitScript(() => {
		const replies = new Map<unknown, Record<string, unknown>>();
		const waiting = new Map<unknown, (frame: Record<string, unknown>) => void>();
		const Base = globalThis.WebSocket;
		globalThis.WebSocket = class WebSocket extends Base {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => {
					if (typeof event.data !== "string") return;
					let frame: unknown;
					try {
						frame = JSON.parse(event.data);
					} catch {
						return;
					}
					if (typeof frame !== "object" || frame === null || !("id" in frame)) return;
					const answer = frame as Record<string, unknown>;
					replies.set(answer.id, answer);
					waiting.get(answer.id)?.(answer);
				});
			}
		};
		(globalThis as WithPageReplies).__mixerWireReplies = {
			has: (id) => replies.has(id),
			next: (id) => {
				const answer = replies.get(id);
				return answer ? Promise.resolve(answer) : new Promise((resolve) => waiting.set(id, resolve));
			},
		};
	});

	const holdNext = (matches: Hold["matches"]): HeldReply => {
		let settle!: (call: RpcCall) => void;
		const answer = new Promise<RpcCall>((resolve) => {
			settle = resolve;
		});
		const hold: Hold = { matches, released: false, settle };
		nextHolds.push(hold);
		return {
			held: answer,
			release: () => {
				if (hold.released) return;
				hold.released = true;
				hold.deliver?.();
			},
		};
	};

	return {
		calls: (path) => all.filter((call) => call.path === path),
		inject: (frame) => route?.send(JSON.stringify(frame)),
		refuseAudioInputs: (token) => {
			refusal = token;
		},
		delayServer: (ms) => {
			delayMs = ms;
		},
		holdAudioMix: () => holdNext((call) => call.path === "streaming.setAudioMix"),
		holdAudioPick: (asrc) =>
			holdNext(
				(call) =>
					call.path === "streaming.setConfig" && call.input.audio_pick === true && call.input.asrc === asrc,
			),
		nextAnswer: (path) => {
			const reply = holdNext((call) => call.path === path);
			reply.release();
			return reply.held;
		},
		refuseAudioMixWithEngineToken: (token) => {
			engineRefusal = token;
		},
		pageHasReply: (id) => page.evaluate((replyId) => (globalThis as WithPageReplies).__mixerWireReplies.has(replyId), id),
		pageReply: (id) => page.evaluate((replyId) => (globalThis as WithPageReplies).__mixerWireReplies.next(replyId), id),
	};
}
