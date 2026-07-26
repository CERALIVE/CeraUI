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
import { getConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	isMeterPreferenceDevicePresent,
	isMeterSilencedByPick,
	resolveMeterPreference,
} from "./audio.ts";
import { supportsMeterDevicePreference } from "./cerastream-backend.ts";

/** Backoff bounds for the initial-connect retry. Mirrors `engine-reconnect.ts`. */
export const AUDIO_METER_CONNECT_BASE_MS = 2_000;
export const AUDIO_METER_CONNECT_MAX_MS = 30_000;

/** How long a foreign-card reading must persist before it is re-asserted. */
export const AUDIO_METER_MISMATCH_GRACE_MS = 5_000;
/** Floor between two re-assertions, so a permanent mismatch stays cheap. */
export const AUDIO_METER_REASSERT_INTERVAL_MS = 30_000;

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
	/**
	 * The ALSA device the operator's audio-source pick resolves to, or `null` for
	 * "Auto" (hand selection back to the engine's own delivery-based pick).
	 */
	meterPreference: () => string | null;
	/** Whether that pick is a card CeraUI's own device scan currently lists. */
	meterPreferencePresent: () => boolean;
	/**
	 * Whether the operator asked for NO audio at all — the one pick a `null`
	 * preference cannot express, because `null` means "engine, choose for
	 * yourself" and the engine has no "meter nothing" value.
	 */
	meterSilenced: () => boolean;
	logger: AudioMeterBridgeLogger;
	random: () => number;
	now: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	baseDelayMs: number;
	maxDelayMs: number;
}

/**
 * The ALSA card identity inside a device/identity string, so the operator's
 * preference (`hw:CARD=rockchiphdmiin`, `plughw:CARD=usbaudio,DEV=0`) and the
 * engine's reported source identity (`card:usbaudio`) both reduce to the bare
 * card id they name. Mirrors cerastream's own `alsa_card_key` so the two sides
 * cannot drift on spelling. `undefined` when nothing is named.
 */
export function alsaCardKey(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const head = value.trim().split(",")[0] ?? "";
	const colon = head.lastIndexOf(":");
	const tail = colon === -1 ? head : head.slice(colon + 1);
	const card = tail.startsWith("CARD=") ? tail.slice("CARD=".length) : tail;
	return card === "" ? undefined : card;
}

/**
 * Is this level a reading of a DIFFERENT card than the one the operator picked?
 *
 * The engine's `meter_device` is a PREFERENCE, not a pin (ADR-0007 §10-11): it
 * only reorders the candidate list, so a selected card the engine cannot open —
 * or does not enumerate at all — silently leaves the meter on some other card.
 * Found live on a Rock 5B+: with nothing plugged into the HDMI-RX port, the
 * RK3588 `rockchiphdmiin` card exposes NO capture PCM substream (`alsasrc
 * device=hw:CARD=rockchiphdmiin` fails "No such file or directory") and never
 * reaches the engine's device list at all, so selecting "HDMI Input" left the
 * meter reporting a USB microphone. The operator saw real, moving bars and read
 * them as live HDMI embedded audio.
 *
 * A level that names a different card is simply not the selected source's level,
 * so it must be reported as a gap rather than rendered. Deliberately requires
 * BOTH sides to be known: an "Auto" pick (`null` preference) hands selection to
 * the engine by design, and an engine that reports no identity cannot be PROVEN
 * to mismatch — neither is gated, so this can only ever suppress a reading we
 * know belongs to another device.
 */
export function isForeignCardLevel(
	preference: string | null,
	identity: string | undefined,
): boolean {
	if (preference === null) return false;
	const wanted = alsaCardKey(preference);
	const reported = alsaCardKey(identity);
	if (wanted === undefined || reported === undefined) return false;
	return wanted !== reported;
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
		meterPreference: () => resolveMeterPreference(getConfig().asrc),
		meterPreferencePresent: () => isMeterPreferenceDevicePresent(),
		meterSilenced: () => isMeterSilencedByPick(getConfig().asrc),
		logger: defaultLogger,
		random: Math.random,
		now: Date.now,
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
	/** Start of the current uninterrupted run of foreign-card readings. */
	mismatchSince: number | undefined;
	mismatchLogged: boolean;
	lastReassertAt: number | undefined;
	/** Selection the last broadcast level was attributable to (see `noteMeterSelection`). */
	lastSelection: string | undefined;
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

/**
 * The gap reason a suppressed foreign-card level is reported as.
 *
 * `no_device` is only honest when the selected card is genuinely absent. When
 * CeraUI's OWN device scan still lists it, the operator's device IS plugged in —
 * the meter is simply on a different card — and saying "No audio device" sent a
 * live investigation looking for an unplugged cable that was never unplugged.
 */
function foreignCardReason(
	deps: AudioMeterBridgeDeps,
): "no_device" | "not_selected_device" {
	return deps.meterPreferencePresent() ? "not_selected_device" : "no_device";
}

/**
 * A sustained foreign-card run means the engine is NOT honouring the preference,
 * and the engine will not correct itself: `set_preferred_device` early-returns on
 * an unchanged value, so a card demoted for not delivering during its probe
 * window stays demoted while any other candidate keeps delivering, and a
 * preference pushed while the card was missing from the engine's registry stays
 * inert. Either way the meter is dead for a device that is present, with no
 * recovery short of the operator re-picking. Re-asserting through `null` is what
 * makes the value change, so the engine clears its demotions and re-probes.
 *
 * Bounded on both sides (a grace window, then an interval floor) so a mismatch
 * that is simply permanent — a selected card with no capture PCM — costs one
 * cheap pair of reloads per interval and never a loop.
 */
function noteForeignCardLevel(deps: AudioMeterBridgeDeps): void {
	if (!state || state.stopped) return;
	const now = deps.now();
	if (state.mismatchSince === undefined) state.mismatchSince = now;
	if (!state.mismatchLogged) {
		state.mismatchLogged = true;
		deps.logger.warn(
			`audio-meter bridge: the engine is metering a different card than the selected ${deps.meterPreference() ?? "auto"} — suppressing its levels`,
		);
	}
	if (now - state.mismatchSince < AUDIO_METER_MISMATCH_GRACE_MS) return;
	if (
		state.lastReassertAt !== undefined &&
		now - state.lastReassertAt < AUDIO_METER_REASSERT_INTERVAL_MS
	) {
		return;
	}
	state.lastReassertAt = now;
	void reassertPreference();
}

function clearForeignCardRun(): void {
	if (!state) return;
	state.mismatchSince = undefined;
	state.mismatchLogged = false;
}

function projectLevel(
	event: Extract<EventParams, { type: "audio-level" }>,
	deps: AudioMeterBridgeDeps,
): AudioLevelMessage {
	const message = toAudioLevelMessage(event);
	// An explicit "No audio" pick outranks whatever the engine is metering,
	// including the engine's own gap reason: the operator asked for silence, so
	// that is the state — and the engine, told only `meter_device: null`, is
	// auto-picking a real card whose real levels would otherwise render.
	if (deps.meterSilenced()) {
		clearForeignCardRun();
		return { unavailable: true, reason: "mode_none" };
	}
	if (message.unavailable === true) {
		clearForeignCardRun();
		return message;
	}
	if (!isForeignCardLevel(deps.meterPreference(), message.source?.identity)) {
		clearForeignCardRun();
		return message;
	}
	noteForeignCardLevel(deps);
	return { unavailable: true, reason: foreignCardReason(deps) };
}

function handleEvent(event: EventParams): void {
	if (!state || state.stopped) return;
	if (event.type !== "audio-level") return;
	try {
		state.deps.broadcast(projectLevel(event, state.deps));
	} catch (err) {
		state.deps.logger.debug(
			`audio-meter bridge: broadcast threw: ${errMessage(err)}`,
		);
	}
}

/**
 * The selection every broadcast level is attributable to. Keyed on the PAIR,
 * because the two halves move independently: "Auto" and "No audio" both resolve
 * to a `null` preference yet mean opposite things, so the preference alone
 * cannot see that switch.
 */
function meterSelectionKey(deps: AudioMeterBridgeDeps): string {
	const pick = deps.meterSilenced() ? "silenced" : "device";
	return `${pick}:${deps.meterPreference() ?? "auto"}`;
}

/**
 * Retire the currently-rendered level the instant the operator's pick changes.
 *
 * Every gate below only ever acts on the NEXT level the engine sends, and the
 * engine itself needs a moment to re-point the sidecar — so between the config
 * write and that frame the meter keeps drawing the PREVIOUS device's bars. Wave
 * H QA caught exactly that: switching to "No audio" left active green bars up
 * for seconds. Publishing the gap immediately makes the transition window read
 * as a transition instead of as live audio, and the very next real level
 * replaces it (this is a re-evaluation, never a pin).
 */
function noteMeterSelection(deps: AudioMeterBridgeDeps): void {
	if (!state || state.stopped) return;
	const key = meterSelectionKey(deps);
	const previous = state.lastSelection;
	state.lastSelection = key;
	if (previous === undefined || previous === key) return;
	clearForeignCardRun();
	try {
		deps.broadcast(
			deps.meterSilenced()
				? { unavailable: true, reason: "mode_none" }
				: { unavailable: true, reason: "handoff" },
		);
	} catch (err) {
		deps.logger.debug(
			`audio-meter bridge: selection-change broadcast threw: ${errMessage(err)}`,
		);
	}
}

/**
 * Tell the engine which card the operator selected, so the idle meter follows the
 * "Audio source" picker instead of picking for itself. `null` restores the
 * engine's own delivery-based auto-pick ("Auto").
 *
 * Sent over the RAW `reload-config` primitive: the published `@ceralive/cerastream`
 * client Zod-STRIPS the additive `audio.meter_device` key, so the typed call would
 * silently drop it. Gated on the engine advertising schema ≥ 0.9.0 — an older
 * engine keeps auto-picking, which is exactly what it did before this existed.
 *
 * NEVER throws and never blocks the meter: a failed push leaves the previous
 * preference in place, and the next config change or reconnect re-pushes.
 */
async function pushPreference(client: CerastreamClient): Promise<void> {
	if (!state || state.stopped) return;
	const { deps } = state;
	noteMeterSelection(deps);
	if (!supportsMeterDevicePreference(client.hello.schema_version)) {
		deps.logger.debug(
			`audio-meter bridge: engine schema ${client.hello.schema_version} predates audio.meter_device — leaving idle-meter selection to the engine`,
		);
		return;
	}
	const meter_device = deps.meterPreference();
	try {
		await sendMeterDevice(client, meter_device);
		deps.logger.debug(
			`audio-meter bridge: idle-meter preference set to ${meter_device ?? "auto"}`,
		);
	} catch (err) {
		deps.logger.warn(
			`audio-meter bridge: could not set the idle-meter preference: ${errMessage(err)}`,
		);
	}
}

function sendMeterDevice(
	client: CerastreamClient,
	meter_device: string | null,
): Promise<unknown> {
	const raw = client as unknown as {
		rawRequest(method: string, params?: unknown): Promise<unknown>;
	};
	return raw.rawRequest("reload-config", { audio: { meter_device } });
}

/**
 * Clear the engine's preference, then re-apply it — see `noteForeignCardLevel`
 * for why the intermediate `null` is the whole point. Never throws, and a failed
 * half leaves the meter exactly where it already was.
 */
async function reassertPreference(): Promise<void> {
	const client = state?.stopped === false ? state.client : undefined;
	if (client === undefined || !state) return;
	const { deps } = state;
	if (!supportsMeterDevicePreference(client.hello.schema_version)) return;
	const meter_device = deps.meterPreference();
	if (meter_device === null) return;
	try {
		await sendMeterDevice(client, null);
		await sendMeterDevice(client, meter_device);
		deps.logger.info(
			`audio-meter bridge: re-asserted the idle-meter preference ${meter_device} after a sustained foreign-card reading`,
		);
	} catch (err) {
		deps.logger.warn(
			`audio-meter bridge: could not re-assert the idle-meter preference: ${errMessage(err)}`,
		);
	}
}

/**
 * Re-push the idle-meter preference after the operator changed the audio source
 * (or the card set was re-enumerated). Fire-and-forget: a no-op when the bridge
 * is not connected — the next connect pushes the current value anyway.
 *
 * Retiring the stale level is NOT gated on the connection, though: the level the
 * operator is looking at was already broadcast, so a changed pick must invalidate
 * it whether or not the engine can be told about the change yet.
 */
export function syncAudioMeterPreference(): void {
	const client = state?.stopped === false ? state.client : undefined;
	if (state && !state.stopped) noteMeterSelection(state.deps);
	if (client === undefined) return;
	void pushPreference(client);
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
		// The engine holds no preference across a restart, so every fresh
		// connection re-asserts the operator's current pick.
		await pushPreference(client);
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
		mismatchSince: undefined,
		mismatchLogged: false,
		lastReassertAt: undefined,
		lastSelection: undefined,
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
