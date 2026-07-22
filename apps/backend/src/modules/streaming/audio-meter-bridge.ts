/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Always-on audio-level bridge (device-quality-wave2 Todo 22).
//
// The cerastream engine runs an ALWAYS-ON level-meter sidecar (ADR-0007): a real
// per-channel audio level flows on the `audio-level` event topic whether the
// device is IDLE or STREAMING (the Todo-18 lease FSM hands the device between the
// idle sidecar and the streaming leg without a gap). This bridge holds ONE
// long-lived subscription to that topic — independent of the streaming session's
// own connection in `cerastream-backend.ts` — and re-broadcasts every event over
// the MAIN authenticated backend WS as an `audio-level` message. That is what
// drives the LiveView meter OUTSIDE a preview (an always-visible slot), so the
// bars move on a clap while idle with no preview open.
//
// The engine emits an `unavailable` variant (no fabricated silence) for a lease
// handoff gap, a missing device, or `audio.mode=none` — forwarded verbatim so the
// meter can render its `unavailable` state per the ADR contract.
//
// Resilience: the `@ceralive/cerastream` client's `autoReconnect` re-subscribes on
// a dropped socket, so once connected the bridge self-heals. The only gap it must
// cover itself is the INITIAL connect when the engine is not up yet (a systemd
// ordering race) — a bounded backoff retry, mirroring `engine-reconnect.ts`. It
// NEVER throws and NEVER blocks boot; every collaborator is injected for tests.

import type {
	CerastreamClient,
	ConnectOptions,
	EventParams,
	Subscription,
} from "@ceralive/cerastream";
import { connect as defaultConnect } from "@ceralive/cerastream";
import type { AudioLevelMessage } from "@ceraui/rpc/schemas";
import { logger as defaultLogger } from "../../helpers/logger.ts";
import { setup } from "../setup.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";

/** Backoff bounds for the initial-connect retry. Mirrors `engine-reconnect.ts`. */
export const AUDIO_METER_CONNECT_BASE_MS = 2_000;
export const AUDIO_METER_CONNECT_MAX_MS = 30_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface AudioMeterBridgeLogger {
	info(message: string): void;
	warn(message: string): void;
	debug(message: string): void;
}

export interface AudioMeterBridgeDeps {
	connect: (options?: ConnectOptions) => Promise<CerastreamClient>;
	connectOptions: ConnectOptions;
	/** Re-broadcast one audio-level payload over the main authenticated WS. */
	broadcast: (payload: AudioLevelMessage) => void;
	logger: AudioMeterBridgeLogger;
	random: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	baseDelayMs: number;
	maxDelayMs: number;
}

/**
 * Project a cerastream `audio-level` event onto the wire message: drop the
 * envelope `type`/`seq` (the broadcast layer stamps its own `seq`) and keep every
 * level/unavailable field. Exported for the bridge test.
 */
export function toAudioLevelMessage(
	event: Extract<EventParams, { type: "audio-level" }>,
): AudioLevelMessage {
	return {
		...(event.source !== undefined ? { source: event.source } : {}),
		...(event.channels !== undefined ? { channels: event.channels } : {}),
		...(event.rms_db !== undefined ? { rms_db: event.rms_db } : {}),
		...(event.peak_db !== undefined ? { peak_db: event.peak_db } : {}),
		...(event.floor_db !== undefined ? { floor_db: event.floor_db } : {}),
		...(event.unavailable !== undefined
			? { unavailable: event.unavailable }
			: {}),
		...(event.reason !== undefined ? { reason: event.reason } : {}),
	};
}

function defaultDeps(): AudioMeterBridgeDeps {
	return {
		connect: defaultConnect,
		connectOptions: {
			...(setup.cerastream_socket
				? { socketPath: setup.cerastream_socket }
				: {}),
			// The binding re-subscribes on a dropped socket, so post-connect
			// resilience is free; the outer loop only covers the first connect.
			autoReconnect: true,
			client: "ceraui-audio-meter",
		},
		broadcast: (payload) => broadcastMsg("audio-level", payload),
		logger: defaultLogger,
		random: Math.random,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		baseDelayMs: AUDIO_METER_CONNECT_BASE_MS,
		maxDelayMs: AUDIO_METER_CONNECT_MAX_MS,
	};
}

interface BridgeState {
	deps: AudioMeterBridgeDeps;
	attempt: number;
	timer: TimerHandle | undefined;
	stopped: boolean;
	client: CerastreamClient | undefined;
	subscription: Subscription | undefined;
	/** Tail of the in-flight connect attempt (test seam via settleAudioMeterBridge). */
	inflight: Promise<void>;
}

let state: BridgeState | undefined;

/** Equal-jitter exponential backoff; mirrors `engine-reconnect.ts backoffDelay`. */
function backoffDelay(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number,
): number {
	const capped = Math.min(baseMs * 2 ** attempt, maxMs);
	return capped / 2 + random() * (capped / 2);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function handleEvent(event: EventParams): void {
	if (!state || state.stopped) return;
	if (event.type !== "audio-level") return;
	try {
		state.deps.broadcast(toAudioLevelMessage(event));
	} catch (err) {
		state.deps.logger.debug(
			`audio-meter bridge: broadcast threw: ${errMessage(err)}`,
		);
	}
}

/**
 * One connect + subscribe attempt. Resolves `true` when the subscription is live
 * (the binding's autoReconnect then owns resilience), `false` to reschedule.
 */
async function runAttempt(): Promise<boolean> {
	if (!state || state.stopped) return false;
	const { deps } = state;
	try {
		const client = await deps.connect(deps.connectOptions);
		if (!state || state.stopped) {
			await client.close().catch(() => undefined);
			return false;
		}
		const subscription = await client.subscribeEvents(
			{ topics: ["audio-level"] },
			handleEvent,
		);
		if (!state || state.stopped) {
			subscription.close();
			await client.close().catch(() => undefined);
			return false;
		}
		state.client = client;
		state.subscription = subscription;
		deps.logger.info(
			"audio-meter bridge: subscribed to the engine audio-level topic",
		);
		return true;
	} catch (err) {
		deps.logger.debug(
			`audio-meter bridge: connect/subscribe failed, will retry: ${errMessage(err)}`,
		);
		return false;
	}
}

function scheduleRetry(): void {
	if (!state || state.stopped || state.timer !== undefined) return;
	const { deps } = state;
	const delay = backoffDelay(
		state.attempt,
		deps.baseDelayMs,
		deps.maxDelayMs,
		deps.random,
	);
	state.attempt += 1;
	state.timer = deps.setTimer(() => {
		if (!state) return;
		state.timer = undefined;
		state.inflight = tick();
	}, delay);
}

async function tick(): Promise<void> {
	if (!state || state.stopped) return;
	const connected = await runAttempt();
	if (!state || state.stopped) return;
	if (!connected) scheduleRetry();
}

/**
 * Boot entry point. Runs the first connect attempt (fire-and-forget — the meter
 * is never on the boot critical path) and, if the engine is not up yet, arms a
 * bounded backoff retry. Idempotent — a prior bridge is torn down first.
 */
export function initAudioMeterBridge(
	overrides: Partial<AudioMeterBridgeDeps> = {},
): void {
	stopAudioMeterBridge();
	state = {
		deps: { ...defaultDeps(), ...overrides },
		attempt: 0,
		timer: undefined,
		stopped: false,
		client: undefined,
		subscription: undefined,
		inflight: Promise.resolve(),
	};
	state.inflight = tick();
}

/** Test seam: resolve once the in-flight connect attempt has settled. */
export function settleAudioMeterBridge(): Promise<void> {
	return state?.inflight ?? Promise.resolve();
}

/** Tear down the bridge (close the subscription + connection, clear the timer). */
export function stopAudioMeterBridge(): void {
	if (!state) return;
	const s = state;
	s.stopped = true;
	if (s.timer !== undefined) s.deps.clearTimer(s.timer);
	s.subscription?.close();
	void s.client?.close().catch(() => undefined);
	state = undefined;
}
