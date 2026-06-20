/**
 * wifi-outcomes.ts — pure outcome predicates for the WiFi disconnect / forget
 * OS operations (T6, ceraui-os-interaction-ux).
 *
 * The WifiSelectorDialog routes disconnect + forget through the keyed
 * `osCommand` state machine, which stays `pending` until a per-surface `$effect`
 * confirms the operation against the live interface snapshot. These functions
 * are the *pure*, rune-free decision the effect makes: given the latest
 * snapshot, has the disconnect / forget actually taken effect yet?
 *
 * They are deliberately conservative — only return `"confirmed"` when the
 * snapshot UNAMBIGUOUSLY shows the operation succeeded — so a stale or in-flight
 * snapshot never clears the spinner early. The shared `wifi:<deviceId>` key is
 * also used by connect, so the dialog gates each predicate behind a local intent
 * flag; these functions never read that flag and only describe the snapshot.
 */

/** The two terminal-or-not states an in-flight OS op can be derived into. */
export type WifiOutcome = "pending" | "confirmed";

/** Minimal shape of a network row the disconnect predicate inspects. */
interface WifiActiveRow {
	active: boolean;
}

/** Minimal interface shape the disconnect predicate inspects. */
interface WifiDisconnectIface {
	/** The active connection's identifier (uuid). */
	conn?: string;
	/** The scanned networks; `active` flags the connected one. */
	available?: ReadonlyArray<WifiActiveRow>;
}

/**
 * Disconnect outcome: the device has dropped the connection when the interface
 * no longer reports the target connection as active.
 *
 *  - interface gone entirely → `confirmed` (nothing is connected).
 *  - the active connection is no longer `targetUuid` → `confirmed` (we left it).
 *  - the target is still the connection AND a network is still flagged active →
 *    `pending` (the drop has not landed yet).
 *  - the target is still the connection but nothing is active → `confirmed`.
 */
export function deriveWifiDisconnectOutcome(
	iface: WifiDisconnectIface | undefined,
	targetUuid: string,
): WifiOutcome {
	if (!iface) return "confirmed";
	if (iface.conn !== targetUuid) return "confirmed";
	const hasActive = iface.available?.some((n) => n.active) ?? false;
	return hasActive ? "pending" : "confirmed";
}

/**
 * Forget outcome: the saved-network map is the authority. The connection is
 * forgotten once its uuid is no longer present among the saved values.
 *
 *  - no saved map → `confirmed` (nothing is saved, so the uuid is gone).
 *  - the uuid still appears among saved values → `pending`.
 *  - the uuid is absent → `confirmed`.
 *
 * `savedMap` mirrors the `WifiInterface.saved` shape: a record whose VALUES are
 * the connection uuids (the keys are SSIDs).
 */
export function deriveWifiForgetOutcome(
	savedMap: Record<string, string> | undefined,
	targetUuid: string,
): WifiOutcome {
	if (!savedMap) return "confirmed";
	const stillSaved = Object.values(savedMap).includes(targetUuid);
	return stillSaved ? "pending" : "confirmed";
}
