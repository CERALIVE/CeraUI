import type { Modem } from '@ceraui/rpc/schemas';

export type SignalCategory = 'excellent' | 'good' | 'fair' | 'weak';

/**
 * Canonical signal strength thresholds used across all signal/wifi components.
 * Single source of truth — do not duplicate these thresholds elsewhere.
 */
export function getSignalCategory(signal: number): SignalCategory {
	if (signal >= 75) return 'excellent';
	if (signal >= 50) return 'good';
	if (signal >= 25) return 'fair';
	return 'weak';
}

/**
 * Extract a usable signal percentage from a modem, or `null` when there is no
 * meaningful value (no-SIM, missing status, or a negative/sentinel reading).
 * Single source of truth — do not duplicate this logic elsewhere.
 */
export function modemSignal(modem: Modem | undefined | null): number | null {
	if (!modem || modem.no_sim) return null;
	const signal = modem.status?.signal;
	if (signal == null || !Number.isFinite(signal) || signal < 0) return null;
	return signal;
}

/**
 * Canonical Tailwind text-color token for a signal reading, matching the
 * SignalIndicator tiers. `null` (no data) → muted. Single source of truth —
 * every signal readout (WiFi, Cellular, …) renders the same colour ramp.
 */
export function signalTextClass(signal: number | null): string {
	if (signal == null) return 'text-muted-foreground';
	switch (getSignalCategory(signal)) {
		case 'excellent':
			return 'text-signal-excellent';
		case 'good':
			return 'text-signal-good';
		case 'fair':
			return 'text-signal-fair';
		default:
			return 'text-signal-weak';
	}
}
