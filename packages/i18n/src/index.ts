/**
 * `@ceraui/i18n` root — LOCALE CONSTANTS.
 *
 * Export map (full contract in README.md):
 *   `@ceraui/i18n`               locale constants (this file)
 *   `@ceraui/i18n/formatters`    standalone Intl formatters
 *   `@ceraui/i18n/svelte`        the Paraglide runes store + `m` facade
 */

import { LOCALES, RTL_LANGUAGES } from "./locale-lifecycle.js";

export {
	BASE_LOCALE,
	directionFor,
	isSupportedLocale,
	LOCALES,
	type LocaleCode,
	type LocaleDescriptor,
	RTL_LANGUAGES,
	resolveInitialLocale,
} from "./locale-lifecycle.js";

/** @deprecated Legacy alias for {@link LOCALES}. */
export const existingLocales = LOCALES;

/** @deprecated Legacy alias for {@link RTL_LANGUAGES}. */
export const rtlLanguages = RTL_LANGUAGES;
