// Main exports for the i18n package

// Export Node.js-specific integration
export * from './i18n-node.js';
export { getTranslationKeys, hasTranslationKey } from './i18n-node.js';
export type { Svelte5Translation, Svelte5TranslationFunction } from './i18n-svelte5.js';
// Export our Svelte 5 integration (now the default)
export * from './i18n-svelte5.js';
// Export types
export type { BaseTranslation, Locales } from './i18n-types.js';
// Export async loading utilities
export { loadLocaleAsync } from './i18n-util.async.js';
// Export the core typesafe-i18n functions
export { detectLocale, i18n, isLocale, loadedLocales, locales } from './i18n-util.js';

// Available locales configuration
export const existingLocales = [
	{ name: 'English', code: 'en' as const, flag: '🇺🇸' },
	{ name: 'Español', code: 'es' as const, flag: '🇪🇸' },
	{ name: 'Português', code: 'pt-BR' as const, flag: '🇧🇷' },
	{ name: 'Français', code: 'fr' as const, flag: '🇫🇷' },
	{ name: 'Deutsch', code: 'de' as const, flag: '🇩🇪' },
	{ name: '中文', code: 'zh' as const, flag: '🇨🇳' },
	{ name: 'العربية', code: 'ar' as const, flag: '🇸🇦' },
	{ name: '日本語', code: 'ja' as const, flag: '🇯🇵' },
	{ name: '한국어', code: 'ko' as const, flag: '🇰🇷' },
	{ name: 'हिन्दी', code: 'hi' as const, flag: '🇮🇳' },
];

export const rtlLanguages = [
	'ar', // Arabic - most common RTL
	'he', // Hebrew
	'fa', // Persian/Farsi
	'ur', // Urdu
] as const;
