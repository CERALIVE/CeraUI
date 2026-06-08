import type { Modem } from "@ceraui/rpc/schemas";

export type SignalCategory = "excellent" | "good" | "fair" | "weak";

/**
 * Canonical signal strength thresholds used across all signal/wifi components.
 * Single source of truth — do not duplicate these thresholds elsewhere.
 */
export function getSignalCategory(signal: number): SignalCategory {
	if (signal >= 75) return "excellent";
	if (signal >= 50) return "good";
	if (signal >= 25) return "fair";
	return "weak";
}

/**
 * Extract a usable signal percentage from a modem, or `null` when there is no
 * meaningful value (no-SIM, missing status, or a negative/sentinel reading).
 * Single source of truth — do not duplicate this logic elsewhere.
 */
export function modemSignal(modem: Modem | undefined | null): number | null {
	if (!modem || modem.no_sim) return null;
	const raw = modem.status?.signal;
	if (raw == null) return null;
	// Defense-in-depth: the backend can emit the signal as a string ("53") when
	// the mmcli `-K` parser leaves it uncoerced. `Number.isFinite("53")` is
	// false, which would silently drop every modem's signal, so coerce first.
	const signal = Number(raw);
	if (!Number.isFinite(signal) || signal < 0) return null;
	return signal;
}

/**
 * Canonical Tailwind text-color token for a signal reading, matching the
 * SignalIndicator tiers. `null` (no data) → muted. Single source of truth —
 * every signal readout (WiFi, Cellular, …) renders the same colour ramp.
 */
export function signalTextClass(signal: number | null): string {
	if (signal == null) return "text-muted-foreground";
	switch (getSignalCategory(signal)) {
		case "excellent":
			return "text-signal-excellent";
		case "good":
			return "text-signal-good";
		case "fair":
			return "text-signal-fair";
		default:
			return "text-signal-weak";
	}
}

/**
 * Convert a signal percentage (0–100) to a filled bar count (0–3).
 * Canonical thresholds for all signal bar visualizations.
 * Single source of truth — replaces both HudBar.filledBars and BondedLinks.signalBars.
 *
 * Thresholds:
 * - null → 0 bars
 * - 0 → 0 bars (behavior change from BondedLinks)
 * - >0 and <33 → 1 bar
 * - >=33 and <66 → 2 bars
 * - >=66 → 3 bars
 */
export function signalBarCount(signal: number | null): 0 | 1 | 2 | 3 {
	if (signal == null) return 0;
	if (signal >= 66) return 3;
	if (signal >= 33) return 2;
	if (signal > 0) return 1;
	return 0;
}

/**
 * Discriminated union representing the visual state of a link indicator.
 * Encodes all possible rendering modes: bars, ethernet, no-sim, scanning, acquiring, wifi-off, zero.
 */
export type LinkVisualState =
	| { kind: "bars"; filled: 0 | 1 | 2 | 3 }
	| { kind: "ethernet" }
	| { kind: "no-sim" }
	| { kind: "scanning" }
	| { kind: "acquiring" }
	| { kind: "wifi-off" }
	| { kind: "zero" };

/**
 * Determine the visual state of a link based on type, connection state, and signal.
 * Decision tree (order matters):
 * 1. ethernet type → {kind:'ethernet'} (always, regardless of signal)
 * 2. signal !== null → {kind:'bars', filled: signalBarCount(signal)}
 * 3. signal === null:
 *    - no_sim → {kind:'no-sim'}
 *    - scanning → {kind:'scanning'}
 *    - connected (any type) → {kind:'acquiring'} (bug fix: wifi+connected+null was wrongly wifi-off)
 *    - wifi + disconnected → {kind:'wifi-off'}
 *    - otherwise → {kind:'zero'}
 */
export function linkVisualState(input: {
	type: "modem" | "wifi" | "ethernet";
	connectionState: "connected" | "scanning" | "disconnected" | "no_sim";
	signal: number | null;
}): LinkVisualState {
	const { type, connectionState, signal } = input;

	// 1. Ethernet always wins
	if (type === "ethernet") {
		return { kind: "ethernet" };
	}

	// 2. Signal present → show bars
	if (signal !== null) {
		return { kind: "bars", filled: signalBarCount(signal) };
	}

	// 3. Signal absent → check connection state
	switch (connectionState) {
		case "no_sim":
			return { kind: "no-sim" };
		case "scanning":
			return { kind: "scanning" };
		case "connected":
			// Bug fix: both modem AND wifi connected with null signal → acquiring
			return { kind: "acquiring" };
		case "disconnected":
			// Only wifi shows wifi-off; modems show zero
			if (type === "wifi") {
				return { kind: "wifi-off" };
			}
			return { kind: "zero" };
	}
}
