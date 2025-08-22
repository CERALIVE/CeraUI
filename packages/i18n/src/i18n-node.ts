import type { BaseTranslation } from './i18n-types.js';

// Available locales
export type Locales = 'en' | 'es' | 'pt-BR' | 'fr' | 'de' | 'zh' | 'ar' | 'ja' | 'ko' | 'hi';

// Load a locale's translations
export async function loadLocale(locale: Locales): Promise<BaseTranslation> {
	try {
		const translations = await import(`./${locale}/index.js`);
		return translations.default;
	} catch (error) {
		console.warn(`Failed to load locale ${locale}, falling back to English:`, error);
		// Fallback to English
		const fallback = await import('./en/index.js');
		return fallback.default;
	}
}

// Create translation functions for a specific locale
export async function createI18nFunctions(locale: Locales = 'en') {
	const translations = await loadLocale(locale);
	return createTranslationFunctions(translations);
}

// Create a proxy that handles nested objects and parameter interpolation
function createTranslationFunctions(translations: BaseTranslation): Record<string, unknown> {
	return createProxy(translations as Record<string, unknown>, []);
}

function createProxy(obj: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
	return new Proxy(obj, {
		get(target, prop: string) {
			const value = target[prop];
			const currentPath = [...path, prop];

			if (typeof value === 'object' && value !== null) {
				return createProxy(value as Record<string, unknown>, currentPath);
			}

			if (typeof value === 'string') {
				const translationFunction = (params: Record<string, string | number | boolean> = {}) => {
					return interpolateString(value, params);
				};

				// Add key access properties
				Object.defineProperty(translationFunction, '$key', {
					value: currentPath.join('.'),
					enumerable: false,
					writable: false,
				});

				Object.defineProperty(translationFunction, '$path', {
					value: currentPath,
					enumerable: false,
					writable: false,
				});

				return translationFunction;
			}

			return value;
		},
	});
}

// Simple string interpolation for parameters like {name:string} or {count:number}
function interpolateString(
	template: string,
	params: Record<string, string | number | boolean>,
): string {
	return template.replace(/\{(\w+)(?::\w+)?\}/g, (match, key) => {
		return params[key] !== undefined ? String(params[key]) : match;
	});
}

// Utility function to get all available keys from a translation object
export function getTranslationKeys(obj: Record<string, unknown>, prefix = ''): string[] {
	const keys: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;

		if (typeof value === 'object' && value !== null) {
			keys.push(...getTranslationKeys(value as Record<string, unknown>, fullKey));
		} else if (typeof value === 'string') {
			keys.push(fullKey);
		}
	}

	return keys;
}

// Utility function to check if a key exists
export async function hasTranslationKey(locale: Locales, key: string): Promise<boolean> {
	try {
		const translations = await loadLocale(locale);
		const keys = key.split('.');
		let current = translations;

		for (const k of keys) {
			if (typeof current !== 'object' || current === null || !(k in current)) {
				return false;
			}
			current = (current as Record<string, unknown>)[k];
		}

		return typeof current === 'string';
	} catch {
		return false;
	}
}

// Default export for Node.js usage
export default createI18nFunctions;
