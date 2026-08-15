/**
 * `@ceraui/i18n` root — LOCALE CONSTANTS.
 *
 * Export map (full contract in README.md):
 *   `@ceraui/i18n`               locale constants (this file)
 *   `@ceraui/i18n/formatters`    standalone Intl formatters
 *   `@ceraui/i18n/svelte`        the Paraglide runes store + `m` facade
 *   `@ceraui/i18n/i18n-svelte5`  the legacy typesafe-i18n adapter (retires with plan todo 24)
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

/** @deprecated Legacy alias for {@link LOCALES}; call sites migrate in plan todo 22. */
export const existingLocales = LOCALES;

/** @deprecated Legacy alias for {@link RTL_LANGUAGES}; call sites migrate in plan todo 22. */
export const rtlLanguages = RTL_LANGUAGES;

// LEGACY typesafe-i18n surface. Retires wholesale with the generator in plan
// todo 24; kept here only so the not-yet-codemodded call sites keep resolving.
// The `/node` SUBPATH is gone (nothing imported it), but `loadLocale` stays
// reachable from the root as a catalog-reading test helper.
export { loadLocale } from "./i18n-node.js";
export type {
	Svelte5Translation,
	Svelte5TranslationFunction,
} from "./i18n-svelte5.svelte.js";
export * from "./i18n-svelte5.svelte.js";
export type {
	BaseTranslation,
	Locales,
	TranslationFunctions,
} from "./i18n-types.js";
export { loadLocaleAsync } from "./i18n-util.async.js";
export {
	detectLocale,
	i18n,
	isLocale,
	loadedLocales,
	locales,
} from "./i18n-util.js";
