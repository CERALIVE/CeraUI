/**
 * 🚀 Svelte 5 Runes i18n Adapter
 *
 * Features:
 * - 🎯 Built specifically for Svelte 5 runes mode ($state, $derived)
 * - 🔑 Translation key access ($key, $path)
 * - ⚡ Performance optimized with caching
 * - 🎨 Enhanced developer experience
 * - 📦 Minimal bundle impact
 * - 🔄 Reactive locale switching
 */

// @ts-nocheck
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

// 📊 Core reactive state using Svelte 5 runes
let localeState = $state<Locales>("en");
let isLoadingState = $state(false);
let loadingErrorState = $state<string | null>(null);

// 🎯 Getters for reactive access
export function getLocale(): Locales {
	return localeState;
}

export function getIsLoading(): boolean {
	return isLoadingState;
}

export function getLoadingError(): string | null {
	return loadingErrorState;
}

// 🔄 Legacy store-like interface for backward compatibility
type Subscriber<T> = (value: T) => void;
const localeSubscribers = new Set<Subscriber<Locales>>();

// Guard to prevent infinite loops
let isUpdatingLocale = false;

function notifyLocaleSubscribers(): void {
	for (const callback of localeSubscribers) {
		callback(localeState);
	}
}

// Legacy-compatible locale store
export const locale = {
	get value() {
		return localeState;
	},
	subscribe(callback: Subscriber<Locales>): () => void {
		localeSubscribers.add(callback);
		callback(localeState);
		return () => localeSubscribers.delete(callback);
	},
	set(value: Locales) {
		// Prevent infinite loops - use setLocale() for full locale changes
		if (isUpdatingLocale || value === localeState) return;
		// Only update state, don't trigger translations (use setLocale for that)
		localeState = value;
		notifyLocaleSubscribers();
	},
};

// Legacy-compatible isLoading store
export const isLoading = {
	get value() {
		return isLoadingState;
	},
	subscribe(callback: Subscriber<boolean>): () => void {
		const subscribers = new Set<Subscriber<boolean>>();
		subscribers.add(callback);
		callback(isLoadingState);
		return () => subscribers.delete(callback);
	},
};

// Legacy-compatible loadingError store
export const loadingError = {
	get value() {
		return loadingErrorState;
	},
	subscribe(callback: Subscriber<string | null>): () => void {
		const subscribers = new Set<Subscriber<string | null>>();
		subscribers.add(callback);
		callback(loadingErrorState);
		return () => subscribers.delete(callback);
	},
};

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

// 🎨 Initialize translations with English as default (synchronous)
loadedLocales.en = en;
let translationsState = $state<Svelte5Translation>(
	createSvelte5Proxy(en, "en", []),
);

// LL subscribers for backward compatibility
const llSubscribers = new Set<Subscriber<Svelte5Translation>>();

function notifyLLSubscribers(): void {
	for (const callback of llSubscribers) {
		callback(translationsState);
	}
}

// 🔄 Function to update translations for a locale
async function updateTranslations(newLocale: Locales): Promise<void> {
	try {
		isLoadingState = true;
		loadingErrorState = null;

		// 🗑️ Clear cache for new locale
		clearTranslationCache();

		// 📥 Ensure locale is loaded
		if (!loadedLocales[newLocale]) {
			await loadLocaleAsync(newLocale);
		}

		const translations = loadedLocales[newLocale];
		if (translations) {
			translationsState = createSvelte5Proxy(translations, newLocale, []);
			notifyLLSubscribers();
		} else {
			throw new Error(`Failed to load translations for locale: ${newLocale}`);
		}
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("❌ Translation loading failed:", errorMessage);
		loadingErrorState = errorMessage;

		// 🔄 Fallback to English
		try {
			if (newLocale !== "en") {
				if (!loadedLocales.en) {
					await loadLocaleAsync("en");
				}
				const fallbackTranslations = loadedLocales.en;
				if (fallbackTranslations) {
					translationsState = createSvelte5Proxy(
						fallbackTranslations,
						"en",
						[],
					);
					notifyLLSubscribers();
					console.log("✅ Fallback to English successful");
				}
			}
		} catch (fallbackError) {
			console.error("❌ Even English fallback failed:", fallbackError);
			loadingErrorState = "Critical: Cannot load any translations";
		}
	} finally {
		isLoadingState = false;
	}
}

// 🎯 Getter for translations (Svelte 5 pattern)
export function getLL(): Svelte5Translation {
	return translationsState;
}

// 🎯 LL export with backward-compatible subscribe
export const LL = {
	get value() {
		return translationsState;
	},
	subscribe(callback: Subscriber<Svelte5Translation>): () => void {
		llSubscribers.add(callback);
		callback(translationsState);
		return () => llSubscribers.delete(callback);
	},
};

// 🎯 Enhanced setLocale with better error handling
export async function setLocale(newLocale: Locales): Promise<boolean> {
	if (!isLocale(newLocale)) {
		console.warn(`⚠️ Invalid locale: ${newLocale}`);
		return false;
	}

	// Prevent re-entry and skip if same locale
	if (isUpdatingLocale || newLocale === localeState) {
		return true;
	}

	isUpdatingLocale = true;

	try {
		// Update locale state
		localeState = newLocale;
		notifyLocaleSubscribers();

		// Update translations
		await updateTranslations(newLocale);
		console.log(`✅ Locale changed to: ${newLocale}`);
		return true;
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error(`❌ Failed to set locale to ${newLocale}:`, errorMessage);
		return false;
	} finally {
		isUpdatingLocale = false;
	}
}

// 🔍 Utility: Get translation by key string (useful for dynamic access)
export function getTranslationByKey(
	translations: Svelte5Translation,
	key: string,
	params?: Record<string, string | number | boolean>,
): string {
	const keys = key.split(".");
	let current: unknown = translations;

	for (const k of keys) {
		if (current && typeof current === "object" && k in current) {
			current = (current as Record<string, unknown>)[k];
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
	translations: Svelte5Translation,
	prefix = "",
): string[] {
	const keys: string[] = [];

	if (!translations || typeof translations !== "object") return keys;

	for (const [key, value] of Object.entries(translations)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;

		if (typeof value === "object" && value !== null) {
			keys.push(...getAllTranslationKeys(value as Svelte5Translation, fullKey));
		} else if (typeof value === "function") {
			keys.push(fullKey);
		}
	}

	return keys;
}

// 🔍 Utility: Check if translation key exists
export function hasTranslationKey(
	translations: Svelte5Translation,
	key: string,
): boolean {
	const keys = key.split(".");
	let current: unknown = translations;

	for (const k of keys) {
		if (current && typeof current === "object" && k in current) {
			current = (current as Record<string, unknown>)[k];
		} else {
			return false;
		}
	}

	return typeof current === "function";
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
	getLocaleInfo: () => ({
		currentLocale: localeState,
		isLoading: isLoadingState,
		error: loadingErrorState,
		availableLocales: Object.keys(loadedLocales),
		cacheSize: translationCache.size,
	}),
};

// 🚀 Export default for convenience
export default LL;
