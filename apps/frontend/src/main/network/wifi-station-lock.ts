/**
 * wifi-station-lock.ts — a radio in the middle of a MODE transition cannot also
 * be asked to join a network (F-09).
 *
 * A hotspot start/stop, and todo 7's explicit per-adapter mode change, both take
 * the adapter's permanent-MAC lock for the whole NetworkManager activation
 * (`wifi-adapter-lock.ts`). Any station mutation dispatched into that window is
 * refused by the device with `DEVICE_BUSY` — so offering a live Connect button
 * there is an affordance that provably cannot act, and the operator's only
 * feedback is a failure toast for something the UI already knew was impossible.
 *
 * The house rule is NEVER HIDE, ALWAYS REASON: the control stays exactly where
 * it was, disabled, carrying the reason on screen. It is not enough to put that
 * reason in a `title` — the shipped kiosk touchscreen cannot hover.
 *
 * The lock is also GUARANTEED TO LIFT. It is derived from the keyed async-op
 * phases, and every one of those has a terminal state: `confirmed` / `failed`
 * from the device's own terminal frame (todo 2's F-07 guarantee, extended to
 * `adapter_mode` by todo 7), or `timed_out` from the store's absolute TTL valve
 * when the device never answers at all. There is no phase that stays `pending`
 * forever, so there is no eternal disable.
 *
 * Two operations, TWO keys, one lock:
 *   `hotspot:<device>`    the hotspot start/stop op (`WifiSection`, `HotspotDialog`)
 *   `wifi-mode:<device>`  todo 7's station|hotspot|hybrid transition
 *
 * The `wifi-mode` key is read here BEFORE its control exists. That is
 * deliberate: `getOperationPhase` answers `idle` for a key nothing has begun, so
 * this is inert until todo 14 wires the selector, and the gate cannot be
 * forgotten at the moment it starts mattering.
 *
 * Pure and rune-free — it takes phases, not the store.
 */

import type { AsyncOpPhase } from "$lib/rpc/async-operation.svelte";

/** The op-key prefix the hotspot start/stop transition is registered under. */
export const WIFI_HOTSPOT_OP_PREFIX = "hotspot";
/** The op-key prefix todo 7's per-adapter mode transition is registered under. */
export const WIFI_MODE_OP_PREFIX = "wifi-mode";

/** The hotspot start/stop op key for a wire device id. */
export function wifiHotspotOpKey(device: string): string {
	return `${WIFI_HOTSPOT_OP_PREFIX}:${device}`;
}

/** The per-adapter mode-change op key for a wire device id. */
export function wifiModeOpKey(device: string): string {
	return `${WIFI_MODE_OP_PREFIX}:${device}`;
}

/**
 * Which transition is (or was last) holding the adapter. They are kept apart
 * because they name different operator actions and therefore need different
 * sentences — a hotspot toggle and a three-way mode change are not the same
 * thing to someone reading the row.
 */
export type WifiStationLockKind = "hotspot" | "mode";

/** The phases this rule reads, one per op. */
export interface WifiStationLockPhases {
	hotspot: AsyncOpPhase;
	mode: AsyncOpPhase;
}

/**
 * The station-control verdict for one adapter.
 *
 * `locked` and `failure` are mutually exclusive by construction: a lock is a
 * `pending` op, and a failure is a TERMINAL one. So a row can never
 * simultaneously say "wait" and "it did not work".
 */
export interface WifiStationLock {
	/** True while a mode transition holds this adapter. */
	locked: boolean;
	/** Which transition holds it. Absent when nothing does. */
	kind?: WifiStationLockKind;
	/** i18n dot-path for the disabled reason. Present iff `locked`. */
	reasonKey?: string;
	/** Which transition failed. Absent unless a terminal failure is showing. */
	failureKind?: WifiStationLockKind;
	/** i18n dot-path naming what did not complete. */
	failureTitleKey?: string;
	/**
	 * i18n dot-path for the failure body. Distinguishes an explicit refusal from
	 * a result that never arrived — the operator's next step differs.
	 */
	failureBodyKey?: string;
}

const PENDING_REASON_KEY: Record<WifiStationLockKind, string> = {
	hotspot: "network.wifiStationLock.hotspotPending",
	mode: "network.wifiStationLock.modePending",
};

const FAILURE_TITLE_KEY: Record<WifiStationLockKind, string> = {
	hotspot: "network.wifiStationLock.hotspotFailed",
	mode: "network.wifiStationLock.modeFailed",
};

/** Nothing to say: no lock, no failure. */
const UNLOCKED: WifiStationLock = { locked: false };

/**
 * Derive the station-control verdict from the two op phases.
 *
 * `mode` outranks `hotspot` in BOTH arms, and that ordering is load-bearing
 * rather than arbitrary: todo 7's `setWifiAdapterMode` DELEGATES to
 * `wifiHotspotStart`/`Stop`, so a single operator action legitimately shows both
 * keys at once. Naming the hotspot leg there would report the mechanism instead
 * of the action the operator actually took.
 */
export function deriveWifiStationLock(
	phases: WifiStationLockPhases,
): WifiStationLock {
	if (phases.mode === "pending") return locked("mode");
	if (phases.hotspot === "pending") return locked("hotspot");

	const modeFailure = failureFor("mode", phases.mode);
	if (modeFailure) return modeFailure;
	const hotspotFailure = failureFor("hotspot", phases.hotspot);
	if (hotspotFailure) return hotspotFailure;

	return UNLOCKED;
}

function locked(kind: WifiStationLockKind): WifiStationLock {
	return { locked: true, kind, reasonKey: PENDING_REASON_KEY[kind] };
}

/**
 * A terminal phase that is NOT a success. `failed` is the device's own refusal
 * (or a thrown RPC); `timed_out` is the TTL valve firing because no terminal
 * frame ever arrived. Both leave the adapter usable again, and both are worth
 * saying out loud — but they are different facts, so they get different bodies.
 */
function failureFor(
	kind: WifiStationLockKind,
	phase: AsyncOpPhase,
): WifiStationLock | undefined {
	if (phase !== "failed" && phase !== "timed_out") return undefined;
	return {
		locked: false,
		failureKind: kind,
		failureTitleKey: FAILURE_TITLE_KEY[kind],
		failureBodyKey:
			phase === "failed"
				? "network.wifiStationLock.failedBody"
				: "network.wifiStationLock.unconfirmedBody",
	};
}
