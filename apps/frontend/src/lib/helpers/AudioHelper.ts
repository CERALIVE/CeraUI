/**
 * AudioHelper — pure functions for audio source label readability
 * No store/rune access. Preserves existing UX semantics for notAvailableAudioSource.
 */

export interface AudioSourceLabelOptions {
	/** List of available audio source IDs */
	available: string[];
	/** The sentinel value representing "not available" audio source */
	notAvailableSentinel: string;
	/** Placeholder text for falsy/unselected source */
	selectPlaceholder: string;
	/** Optional translation function for i18n keys */
	t?: (key: string) => string;
}

/**
 * Get a human-readable label for an audio source ID.
 *
 * Behavior:
 * - Falsy source → returns selectPlaceholder
 * - source === notAvailableSentinel → returns "${source} (${t('settings.notAvailableAudioSource')})"
 * - Short readable id (≤20 chars) → returns unchanged
 * - Long/hash-like id (>20 chars) → returns t('general.unknownSource') or truncated to 20 chars
 *
 * This guards against absurdly long or hash-like audio source IDs while preserving
 * the intentional raw-id UX for normal sources.
 */
export function getAudioSourceLabel(
	source: string | null | undefined,
	options: AudioSourceLabelOptions,
): string {
	const { available, notAvailableSentinel, selectPlaceholder, t } = options;

	// Falsy source → return placeholder
	if (!source) {
		return selectPlaceholder;
	}

	// notAvailableSentinel → return with (Not Available) suffix
	if (source === notAvailableSentinel) {
		const notAvailableLabel = t?.('settings.notAvailableAudioSource') ?? 'Not Available';
		return `${source} (${notAvailableLabel})`;
	}

	// Guard against absurdly long/hash-like IDs (length > 20)
	if (source.length > 20) {
		// If translation function provided, use general.unknownSource
		if (t) {
			return t('general.unknownSource');
		}
		// Otherwise truncate to first 20 chars
		return source.substring(0, 20);
	}

	// Short readable id → return unchanged
	return source;
}
