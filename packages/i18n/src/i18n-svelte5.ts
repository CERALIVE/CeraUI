/**
 * 🚀 Svelte 5 Optimized i18n Adapter
 *
 * Features:
 * - 🎯 Built specifically for Svelte 5 runes mode
 * - 🔑 Translation key access ($key, $path)
 * - ⚡ Performance optimized with caching
 * - 🎨 Enhanced developer experience
 * - 📦 Minimal bundle impact
 * - 🔄 Reactive locale switching
 */

// @ts-nocheck
import { derived, type Readable, writable } from "svelte/store";
// Import English translations synchronously as fallback
import en from "./en/index.js";
import type { Locales, Translation } from "./i18n-types.js";
import { loadLocaleAsync } from "./i18n-util.async.js";
import { isLocale, loadedLocales } from "./i18n-util.js";

// 🎯 Enhanced translation function with key access
export interface Svelte5TranslationFunction {
	(params?: Record<string, string | number | boolean>): string;
	readonly $key: string;
	readonly $path: readonly string[];
	readonly $locale: Locales;
}

// 🔧 Recursive type that transforms Translation structure to use Svelte5TranslationFunction
type TranslationProxy<T> = {
	[K in keyof T]: T[K] extends string
		? Svelte5TranslationFunction
		: T[K] extends Record<string, unknown>
			? TranslationProxy<T[K]>
			: T[K];
};

// 🎯 Properly typed translation proxy
export type Svelte5Translation = TranslationProxy<Translation>;

// 🏪 Cache for translation proxies to improve performance
const translationCache = new Map<string, Svelte5Translation>();

// 📊 Core reactive stores
// Initialize with English as the default locale (synchronous)
export const locale = writable<Locales>("en");
export const isLoading = writable(false);
export const loadingError = writable<string | null>(null);

// 🎯 Performance optimized string interpolation
function interpolateString(
	template: string,
	params: Record<string, string | number | boolean>,
): string {
	if (!params || Object.keys(params).length === 0) return template;

	return template.replace(/\{(\w+)(?::\w+)?\}/g, (match, key) => {
		const value = params[key];
		return value !== undefined ? String(value) : match;
	});
}

// 🚀 Svelte 5 optimized translation proxy factory
function createSvelte5Proxy(
	obj: Translation,
	currentLocale: Locales,
	path: readonly string[] = [],
): Svelte5Translation {
	const cacheKey = `${currentLocale}:${path.join(".")}`;

	// 📦 Return cached proxy for performance
	if (translationCache.has(cacheKey)) {
		const cachedResult = translationCache.get(cacheKey);
		if (cachedResult) {
			return cachedResult;
		}
	}

	const proxy = new Proxy(obj, {
		get(target, prop: string | symbol) {
			// Handle symbol properties (like Symbol.iterator)
			if (typeof prop === "symbol") {
				return target[prop];
			}

			const value = target[prop];
			const currentPath = [...path, prop] as const;

			// 🔗 Nested objects: create child proxy
			if (typeof value === "object" && value !== null) {
				return createSvelte5Proxy(value, currentLocale, currentPath);
			}

			// 🎯 Translation strings: create enhanced function
			if (typeof value === "string") {
				const translationFunction = ((
					params: Record<string, string | number | boolean> = {},
				) => {
					return interpolateString(value, params);
				}) as Svelte5TranslationFunction;

				// 🔑 Add readonly key access properties
				Object.defineProperties(translationFunction, {
					$key: {
						value: currentPath.join("."),
						enumerable: false,
						writable: false,
						configurable: false,
					},
					$path: {
						value: Object.freeze([...currentPath]),
						enumerable: false,
						writable: false,
						configurable: false,
					},
					$locale: {
						value: currentLocale,
						enumerable: false,
						writable: false,
						configurable: false,
					},
				});

				return translationFunction;
			}

			// 🚨 Fallback: Create a function that returns the key path for missing translations
			if (value === undefined) {
				const fallbackKey = currentPath.join(".");
				const fallbackFunction = ((
					_params: Record<string, string | number | boolean> = {},
				) => {
					console.warn(`⚠️ Missing translation: ${fallbackKey}`);
					return fallbackKey; // Return the key as fallback
				}) as Svelte5TranslationFunction;

				// 🔑 Add readonly key access properties
				Object.defineProperties(fallbackFunction, {
					$key: {
						value: fallbackKey,
						enumerable: false,
						writable: false,
						configurable: false,
					},
					$path: {
						value: Object.freeze([...currentPath]),
						enumerable: false,
						writable: false,
						configurable: false,
					},
					$locale: {
						value: currentLocale,
						enumerable: false,
						writable: false,
						configurable: false,
					},
				});

				return fallbackFunction;
			}

			// Handle other values
			return value;
		},

		// 🔍 Enable enumeration for Object.keys() and bracket notation
		has(target, prop: string | symbol) {
			return typeof prop === "string" ? prop in target : false;
		},

		// 🗂️ Support for Object.keys() and iteration
		ownKeys(target) {
			return Object.keys(target);
		},

		// 📄 Property descriptor support
		getOwnPropertyDescriptor(target, prop: string | symbol) {
			if (typeof prop === "string" && prop in target) {
				return {
					enumerable: true,
					configurable: true,
					value: this.get?.(target, prop, proxy),
				};
			}
			return undefined;
		},
	});

	// 📦 Cache the proxy for reuse
	translationCache.set(cacheKey, proxy);
	return proxy;
}

// 🔄 Clear cache when locale changes
function clearTranslationCache(): void {
	translationCache.clear();
}

// 🎨 Initialize translations store with English as default (synchronous)
// This prevents undefined errors when components render before async loading completes
loadedLocales.en = en; // Ensure English is in loadedLocales
const initialTranslations = createSvelte5Proxy(en, "en", []);
const translationsStore = writable<Svelte5Translation>(initialTranslations);

// 🔄 Function to update translations for a locale
async function updateTranslations(newLocale: Locales): Promise<void> {
	try {
		isLoading.set(true);
		loadingError.set(null);

		// 🗑️ Clear cache for new locale
		clearTranslationCache();

		// 📥 Ensure locale is loaded
		if (!loadedLocales[newLocale]) {
			await loadLocaleAsync(newLocale);
		}

		const translations = loadedLocales[newLocale];
		if (translations) {
			const svelte5Translations = createSvelte5Proxy(
				translations,
				newLocale,
				[],
			);
			translationsStore.set(svelte5Translations);
		} else {
			throw new Error(`Failed to load translations for locale: ${newLocale}`);
		}
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("❌ Translation loading failed:", errorMessage);
		loadingError.set(errorMessage);

		// 🔄 Fallback to English
		try {
			if (newLocale !== "en") {
				if (!loadedLocales.en) {
					await loadLocaleAsync("en");
				}
				const fallbackTranslations = loadedLocales.en;
				if (fallbackTranslations) {
					const svelte5Translations = createSvelte5Proxy(
						fallbackTranslations,
						"en",
						[],
					);
					translationsStore.set(svelte5Translations);
					console.log("✅ Fallback to English successful");
				}
			}
		} catch (fallbackError) {
			console.error("❌ Even English fallback failed:", fallbackError);
			loadingError.set("Critical: Cannot load any translations");
		}
	} finally {
		isLoading.set(false);
	}
}

// 🎯 Reactive LL store that updates when locale changes
export const LL: Readable<Svelte5Translation> = translationsStore;

// 🎯 Enhanced setLocale with better error handling
export async function setLocale(newLocale: Locales): Promise<boolean> {
	if (!isLocale(newLocale)) {
		console.warn(`⚠️ Invalid locale: ${newLocale}`);
		return false;
	}

	try {
		// Update translations first
		await updateTranslations(newLocale);

		// Then update the locale store
		locale.set(newLocale);
		console.log(`✅ Locale changed to: ${newLocale}`);
		return true;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(`❌ Failed to set locale to ${newLocale}:`, errorMessage);
		return false;
	}
}

// 🔄 Subscribe to locale changes to automatically update translations
locale.subscribe((newLocale) => {
	updateTranslations(newLocale);
});

// 🔍 Utility: Get translation by key string (useful for dynamic access)
export function getTranslationByKey(
	LL: Svelte5Translation,
	key: string,
	params?: Record<string, string | number | boolean>,
): string {
	const keys = key.split(".");
	let current = LL;

	for (const k of keys) {
		if (current && typeof current === "object" && k in current) {
			current = current[k];
		} else {
			console.warn(`⚠️ Translation key not found: ${key}`);
			return key; // Return key as fallback
		}
	}

	if (typeof current === "function") {
		return current(params);
	}

	return String(current);
}

// 🗂️ Utility: Get all available translation keys
export function getAllTranslationKeys(
	LL: Svelte5Translation,
	prefix = "",
): string[] {
	const keys: string[] = [];

	if (!LL || typeof LL !== "object") return keys;

	for (const [key, value] of Object.entries(LL)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;

		if (typeof value === "object" && value !== null) {
			keys.push(...getAllTranslationKeys(value, fullKey));
		} else if (typeof value === "function") {
			keys.push(fullKey);
		}
	}

	return keys;
}

// 🔍 Utility: Check if translation key exists
export function hasTranslationKey(
	LL: Svelte5Translation,
	key: string,
): boolean {
	const keys = key.split(".");
	let current = LL;

	for (const k of keys) {
		if (current && typeof current === "object" && k in current) {
			current = current[k];
		} else {
			return false;
		}
	}

	return typeof current === "function";
}

// 🎯 Utility: Create reactive translation function for component props
export function createReactiveTranslation(keyPath: string) {
	return derived(LL, ($LL) => {
		return (params?: Record<string, string | number | boolean>) =>
			getTranslationByKey($LL, keyPath, params);
	});
}

// 🧪 Debug utilities (development only)
export const debug = {
	// 📊 Get cache statistics
	getCacheStats: () => ({
		cacheSize: translationCache.size,
		cacheKeys: Array.from(translationCache.keys()),
	}),

	// 🗑️ Clear cache manually
	clearCache: clearTranslationCache,

	// 🔍 Get current locale info
	getLocaleInfo: () =>
		derived(
			[locale, isLoading, loadingError],
			([$locale, $isLoading, $error]) => ({
				currentLocale: $locale,
				isLoading: $isLoading,
				error: $error,
				availableLocales: Object.keys(loadedLocales),
				cacheSize: translationCache.size,
			}),
		),
};

// 🚀 Export default for convenience
export default LL;

// 📝 Types are exported directly from their definitions above
