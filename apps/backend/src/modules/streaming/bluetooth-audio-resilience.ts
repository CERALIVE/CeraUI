/*
    CeraUI - web UI for the CeraLive project
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

/*
 * Bluetooth microphone loss/return, told to the OPERATOR — and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECOVERY IS ENGINE-OWNED. THIS MODULE ONLY SPEAKS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * cerastream already survives a microphone vanishing mid-stream, and it does so
 * WITHOUT being asked: `ProgramAudioBranch` is a device⇄silence `fallbackswitch`
 * whose actuator loop polls the device leg's `is-healthy` every 250 ms and
 * answers `SelectSilence` on a starve, `RebuildDevice` on the 3 s cadence while
 * failed, and `SelectDevice` the moment the leg is healthy again
 * (`cerastream/crates/cerastream/src/engine/audio.rs` `audio_actuator_loop` +
 * `crates/cerastream/src/audio.rs` `AudioActuator::poll`, whose failover /
 * rebuild / recovery matrix is table-tested there). The rebuild is opaque-spec
 * aware and its failure log is rate-limited to `OPAQUE_REBUILD_LOG_INTERVAL`
 * (30 s), so a BlueALSA PCM that is permanently gone costs one line per 30 s
 * rather than an `eprintln` per retry.
 *
 * So CeraUI must NOT add a second silence-on-disconnect mechanism, and there is
 * deliberately NO "re-promote the device leg" RPC — none exists on the engine,
 * none is added here, and adding one would race the actuator that already owns
 * the decision. On a reconnect this module does EXACTLY TWO things:
 *
 *   1. re-assert the idle-meter preference (the engine holds no preference
 *      across a device disappearing from its registry, and
 *      `set_preferred_device` early-returns on an unchanged value — see
 *      `audio-meter-bridge.ts`), and
 *   2. clear the notifications it raised.
 *
 * Everything else on the audio path — the program leg, the silence companion,
 * the ALSA rebuild — belongs to the engine.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A BOUNDED HYSTERESIS, MIRRORING `capture-presence.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A Bluetooth link flaps. The BlueZ registry publishes an edge per
 * `PropertiesChanged`, so an unguarded raise-on-disconnect / clear-on-reconnect
 * pair turns one bad radio minute into a stream of toasts, and an unguarded
 * re-assert turns it into a stream of `reload-config` pairs at the engine. Both
 * are therefore bounded, and neither bound is a debounce on the SAMPLING — the
 * registry is read exactly as often as before:
 *
 *   - `BLUETOOTH_SOURCE_LOSS_GRACE_MS` is hysteresis on the VERDICT. A device
 *     must be continuously degraded for the whole window before an operator is
 *     told anything, so a drop shorter than the window is silent — which is
 *     also the window the engine's own actuator spends failing over and
 *     rebuilding. The clock starts at the FIRST degraded observation, never at
 *     the last healthy one (`capture-presence.ts`'s rule, for its reason: our
 *     knowledge is refreshed on someone else's cadence).
 *   - `BLUETOOTH_REASSERT_INTERVAL_MS` is a leading-edge floor on the
 *     re-assert. A device that reconnects five times in two seconds costs ONE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DROPPED IS NOT GONE, AND NEITHER IS A CLAIM WE MAY MAKE UNPROVEN
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BlueZ retires a device row with `InterfacesRemoved(Device1)` and merely flips
 * `Connected` for a link that dropped, and the two are different operator facts:
 * a dropped headset is expected back (the engine is rebuilding for it), a device
 * the registry no longer lists needs a human. So `gone` gets its own TERMINAL
 * persistent notification and `dropped` a retractable warning.
 *
 * Both require that we have SEEN the device connected in this process. A trusted
 * microphone that is simply switched off at boot has never been ours to lose,
 * and claiming it was lost would put a standing error on a device that is merely
 * off — the same "absence is not evidence" rule the capture-presence grace and
 * the meter's foreign-card gate both follow.
 */

import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import { getConfig } from "../config.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { syncAudioMeterPreference } from "./audio-meter-bridge.ts";
import {
	BLUETOOTH_AUDIO_ID_PREFIX,
	type BluetoothAudioDevice,
	isBluetoothAudioSourceId,
} from "./bluetooth-audio.ts";
import { getStreamingProcesses } from "./streamloop/process-runner.ts";

/**
 * How long the selected microphone must be continuously degraded before the
 * operator is told.
 *
 * Sized against the ENGINE's own failover cadence rather than a taste: the
 * actuator polls at 250 ms and re-tries the ALSA rebuild on a 3 s cadence, so a
 * link that drops and returns inside this window is one the engine absorbs on
 * its own and an operator has nothing to act on. Deliberately short — a
 * microphone that is really gone must not stay unreported for longer than the
 * transient it exists to absorb.
 */
export const BLUETOOTH_SOURCE_LOSS_GRACE_MS = 3_000;

/**
 * Leading-edge floor between two meter-preference re-assertions.
 *
 * The re-assert exists so a device the engine's registry dropped is preferred
 * again once it returns; repeating it while a radio flaps buys nothing (the
 * engine's own actuator owns re-promotion) and costs a `reload-config` pair each
 * time. One per window is the whole guarantee.
 */
export const BLUETOOTH_REASSERT_INTERVAL_MS = 5_000;

/** TERMINAL: the registry no longer lists the selected microphone. */
export const BLUETOOTH_SOURCE_LOST_NOTIFICATION = "bluetooth-source-lost";
/** Retractable: the link dropped, the row is still there. */
export const BLUETOOTH_SOURCE_DROPPED_NOTIFICATION = "bluetooth-source-dropped";
/** One-shot success toast on return. */
export const BLUETOOTH_SOURCE_RECOVERED_NOTIFICATION =
	"bluetooth-source-recovered";

const LOST_KEY = "notifications.bluetoothSourceLost";
const DROPPED_KEY = "notifications.bluetoothSourceDropped";
const RECOVERED_KEY = "notifications.bluetoothSourceRecovered";

const lostMsg = (name: string) =>
	`${name} is no longer available. Your stream keeps running in silence — reconnect the microphone or pick another audio source.`;
const droppedMsg = (name: string) =>
	`${name} disconnected. Your stream keeps running in silence until it reconnects.`;
const recoveredMsg = (name: string) => `${name} reconnected. Sound is back.`;

/**
 * What the registry says about the selected microphone RIGHT NOW.
 *
 * `dropped` and `gone` are different facts and are never collapsed: BlueZ flips
 * `Connected` for the first and retires the whole `Device1` row for the second.
 */
export type BluetoothSourcePresence = "present" | "dropped" | "gone";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BluetoothAudioResilienceDeps {
	/** The operator's persisted audio pick (`config.asrc`). */
	selectedAsrc: () => string | undefined;
	/** Whether a stream is live — gates the DROPPED band, never the GONE one. */
	isStreaming: () => boolean;
	/**
	 * Re-state the operator's meter pick to the engine. The ONLY engine call
	 * this module is allowed to cause, and it is a `reload-config`.
	 */
	reassertMeterPreference: () => void;
	notify: typeof notificationBroadcast;
	removeNotification: typeof notificationRemove;
	now: () => number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	log: (message: string) => void;
}

function defaultDeps(): BluetoothAudioResilienceDeps {
	return {
		selectedAsrc: () => getConfig().asrc,
		isStreaming: () => getStreamingProcesses().length > 0,
		reassertMeterPreference: syncAudioMeterPreference,
		notify: notificationBroadcast,
		removeNotification: notificationRemove,
		now: getms,
		setTimer: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			// A radio's grace window must never hold the event loop open.
			timer.unref?.();
			return timer;
		},
		clearTimer: (timer) => clearTimeout(timer),
		log: (message) => logger.info(message),
	};
}

let deps: BluetoothAudioResilienceDeps = defaultDeps();

/** Test seam: swap the whole surface (`null` restores the production default). */
export function setBluetoothAudioResilienceDepsForTest(
	next: BluetoothAudioResilienceDeps | null,
): void {
	resetBluetoothAudioResilience();
	deps = next ?? defaultDeps();
}

/** The remembered view of the ONE selected microphone. */
interface ResilienceState {
	/** Colon-separated upper-case MAC — the identity, never the object path. */
	address: string;
	displayName: string;
	/** We have observed this device CONNECTED; only then can it be "lost". */
	everPresent: boolean;
	/** Start of the current uninterrupted degraded run. */
	degradedSince: number | undefined;
	/** Which band, if any, is currently standing. */
	standing: "none" | "dropped" | "gone";
	lastReassertAt: number | undefined;
	timer: TimerHandle | undefined;
	/** The last registry projection, so the grace timer can re-decide on it. */
	lastDevices: readonly BluetoothAudioDevice[];
}

let state: ResilienceState | undefined;

/** Drop every band and timer — test isolation and an explicit re-arm only. */
export function resetBluetoothAudioResilience(): void {
	if (state?.timer !== undefined) deps.clearTimer(state.timer);
	state = undefined;
}

/** Which bands are standing right now (assertions + diagnostics). */
export function standingBluetoothAudioBand(): "none" | "dropped" | "gone" {
	return state?.standing ?? "none";
}

/** The MAC a Bluetooth source id encodes, or `undefined` for any other pick. */
export function addressOfBluetoothSourceId(
	id: string | undefined,
): string | undefined {
	if (id === undefined || !isBluetoothAudioSourceId(id)) return undefined;
	const raw = id.slice(BLUETOOTH_AUDIO_ID_PREFIX.length);
	if (raw === "") return undefined;
	return raw.toUpperCase().replaceAll("_", ":");
}

/**
 * The registry's verdict on one address.
 *
 * PURE, and the whole point of the split: `gone` means the row is not there at
 * all (BlueZ retired `Device1`), `dropped` means the row is there and says the
 * link is down. A caller that folded them together would tell an operator their
 * microphone was destroyed every time it went briefly out of range.
 */
export function classifyBluetoothSourcePresence(
	address: string,
	devices: readonly BluetoothAudioDevice[],
): BluetoothSourcePresence {
	const wanted = address.toUpperCase();
	const row = devices.find(
		(device) => device.address?.toUpperCase() === wanted,
	);
	if (row === undefined) return "gone";
	return row.connected ? "present" : "dropped";
}

function displayNameFor(
	address: string,
	devices: readonly BluetoothAudioDevice[],
	fallback: string,
): string {
	const wanted = address.toUpperCase();
	const row = devices.find(
		(device) => device.address?.toUpperCase() === wanted,
	);
	const name = row?.alias ?? row?.name;
	return name === undefined || name === "" ? fallback : name;
}

function disarm(): void {
	if (state?.timer === undefined) return;
	deps.clearTimer(state.timer);
	state.timer = undefined;
}

/** Retract whichever band is standing. Never emits a recovery toast itself. */
function retractStanding(): void {
	if (state === undefined || state.standing === "none") return;
	deps.removeNotification(
		state.standing === "gone"
			? BLUETOOTH_SOURCE_LOST_NOTIFICATION
			: BLUETOOTH_SOURCE_DROPPED_NOTIFICATION,
	);
	state.standing = "none";
}

function raiseDropped(): void {
	if (state === undefined || state.standing === "dropped") return;
	// An escalation the other way (gone → dropped) must not silently downgrade a
	// terminal claim; only a genuine return clears `gone`.
	if (state.standing === "gone") return;
	state.standing = "dropped";
	deps.notify(
		BLUETOOTH_SOURCE_DROPPED_NOTIFICATION,
		"warning",
		droppedMsg(state.displayName),
		0, // persistent: `duration` does not expire one anyway
		true, // isPersistent — it stands until the device says otherwise
		true, // isDismissable — the documented safety net, never the mechanism
		true, // authedOnly
		DROPPED_KEY,
		{ name: state.displayName },
	);
	deps.log(
		`bluetooth-audio: ${state.displayName} dropped for more than ${BLUETOOTH_SOURCE_LOSS_GRACE_MS} ms — the engine is running the silence companion`,
	);
}

function raiseGone(): void {
	if (state === undefined || state.standing === "gone") return;
	// The terminal band REPLACES a standing drop band: one operator-visible
	// claim per device, escalated in place rather than stacked.
	if (state.standing === "dropped") {
		deps.removeNotification(BLUETOOTH_SOURCE_DROPPED_NOTIFICATION);
	}
	state.standing = "gone";
	deps.notify(
		BLUETOOTH_SOURCE_LOST_NOTIFICATION,
		"error",
		lostMsg(state.displayName),
		0,
		true,
		true,
		true,
		LOST_KEY,
		{ name: state.displayName },
	);
	deps.log(
		`bluetooth-audio: ${state.displayName} is no longer in the Bluetooth registry — reporting it lost`,
	);
}

/**
 * The reconnect duties, and there are exactly two.
 *
 * NOTE what is absent: no engine re-promote, no `switch-audio`, no leg rebuild.
 * The engine's actuator re-selects the device leg on its own the moment the PCM
 * reopens; anything issued from here would race it.
 */
function onReconnect(now: number): void {
	if (state === undefined) return;
	const wasDegraded = state.degradedSince !== undefined;
	const hadBand = state.standing !== "none";
	retractStanding();
	state.degradedSince = undefined;
	disarm();
	if (!wasDegraded) return;

	if (hadBand) {
		deps.notify(
			BLUETOOTH_SOURCE_RECOVERED_NOTIFICATION,
			"success",
			recoveredMsg(state.displayName),
			5,
			false,
			true,
			true,
			RECOVERED_KEY,
			{ name: state.displayName },
		);
	}

	// (2) of the two duties, bounded so a flapping radio cannot storm the engine.
	if (
		state.lastReassertAt !== undefined &&
		now - state.lastReassertAt < BLUETOOTH_REASSERT_INTERVAL_MS
	) {
		return;
	}
	state.lastReassertAt = now;
	try {
		deps.reassertMeterPreference();
	} catch (err) {
		logger.debug(
			`bluetooth-audio: meter-preference re-assert threw: ${String(err)}`,
		);
	}
}

/** The grace timer fired: re-decide on the LAST observation, nothing newer. */
function onGraceElapsed(): void {
	if (state === undefined) return;
	state.timer = undefined;
	evaluate(state.lastDevices);
}

function evaluate(devices: readonly BluetoothAudioDevice[]): void {
	if (state === undefined) return;
	state.lastDevices = devices;
	const presence = classifyBluetoothSourcePresence(state.address, devices);

	if (presence === "present") {
		state.everPresent = true;
		state.displayName = displayNameFor(
			state.address,
			devices,
			state.displayName,
		);
		onReconnect(deps.now());
		return;
	}

	// Never seen working ⇒ nothing of ours was lost. A paired-but-switched-off
	// microphone at boot is exactly this case, and it must stay silent.
	if (!state.everPresent) return;

	const now = deps.now();
	if (state.degradedSince === undefined) {
		state.degradedSince = now;
	}
	if (now - state.degradedSince < BLUETOOTH_SOURCE_LOSS_GRACE_MS) {
		// Arm ONCE per degraded run: the window is measured from the first
		// degraded observation, so a later edge inside it must not extend it.
		if (state.timer === undefined) {
			state.timer = deps.setTimer(
				onGraceElapsed,
				BLUETOOTH_SOURCE_LOSS_GRACE_MS,
			);
		}
		return;
	}

	disarm();
	if (presence === "gone") {
		raiseGone();
		return;
	}
	// A drop is a claim about the LIVE program leg, so it is stream-gated; a
	// device the registry retired is a standing fact either way.
	if (deps.isStreaming()) raiseDropped();
}

/**
 * Reconcile the operator's Bluetooth audio pick against ONE registry
 * projection — the same list `bluetooth-audio.ts` folds into the picker.
 *
 * `devices` must be the COMPLETE projection: absence from it is the evidence
 * that the row was retired, so a partial list would report a live microphone
 * lost. Never throws — it runs inside the Bluetooth broadcast path.
 */
export function noteBluetoothAudioPresence(
	devices: readonly BluetoothAudioDevice[],
): void {
	let selected: string | undefined;
	try {
		selected = deps.selectedAsrc();
	} catch {
		selected = undefined;
	}
	const address = addressOfBluetoothSourceId(selected);

	if (address === undefined) {
		// The operator is not on a Bluetooth microphone (any more). Retract
		// whatever we said about the previous one — a band about a device nobody
		// is listening to is the latch this file exists to avoid.
		retractStanding();
		resetBluetoothAudioResilience();
		return;
	}

	if (state !== undefined && state.address !== address) {
		retractStanding();
		resetBluetoothAudioResilience();
	}

	if (state === undefined) {
		state = {
			address,
			displayName: displayNameFor(address, devices, address),
			everPresent: false,
			degradedSince: undefined,
			standing: "none",
			lastReassertAt: undefined,
			timer: undefined,
			lastDevices: devices,
		};
	}

	try {
		evaluate(devices);
	} catch (err) {
		logger.debug(`bluetooth-audio: presence reconcile threw: ${String(err)}`);
	}
}
