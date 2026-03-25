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
