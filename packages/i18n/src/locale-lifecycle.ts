/**
 * Locale constants and the PURE half of the locale lifecycle.
 *
 * Rune-free on purpose: the startup priority and the text-direction rule are the
 * two things worth unit-testing, and neither needs a reactive runtime. The runes
 * store in `svelte.svelte.ts` is a thin wrapper over these.
 */

export type LocaleCode =
	| "en"
	| "es"
	| "pt-BR"
	| "fr"
	| "de"
	| "zh"
	| "ar"
	| "ja"
	| "ko"
	| "hi";

export interface LocaleDescriptor {
	readonly name: string;
	readonly code: LocaleCode;
	readonly flag: string;
}

/** The shipped locales, in the order the selector lists them. */
export const LOCALES: readonly LocaleDescriptor[] = [
	{ name: "English", code: "en", flag: "🇺🇸" },
	{ name: "Español", code: "es", flag: "🇪🇸" },
	{ name: "Português", code: "pt-BR", flag: "🇧🇷" },
	{ name: "Français", code: "fr", flag: "🇫🇷" },
	{ name: "Deutsch", code: "de", flag: "🇩🇪" },
	{ name: "中文", code: "zh", flag: "🇨🇳" },
	{ name: "العربية", code: "ar", flag: "🇸🇦" },
	{ name: "日本語", code: "ja", flag: "🇯🇵" },
	{ name: "한국어", code: "ko", flag: "🇰🇷" },
	{ name: "हिन्दी", code: "hi", flag: "🇮🇳" },
];

/**
 * Right-to-left languages. This list — NOT paraglide's `getTextDirection()` — is
 * the source of truth for `<html dir>`. It predates the migration, the e2e
 * locale-parity spec asserts `<html dir="rtl" lang="ar">` against it, and it
 * deliberately carries languages CeraUI does not ship yet (he/fa/ur) so adding
 * one of them needs no second edit here.
 */
export const RTL_LANGUAGES: readonly string[] = [
	"ar", // Arabic — the only RTL locale currently shipped
	"he", // Hebrew
	"fa", // Persian/Farsi
	"ur", // Urdu
];

/** The default when nothing else resolves. */
export const BASE_LOCALE: LocaleCode = "en";

const LOCALE_CODES: ReadonlySet<string> = new Set(
	LOCALES.map((entry) => entry.code),
);

export function isSupportedLocale(
	value: string | undefined,
): value is LocaleCode {
	return value !== undefined && LOCALE_CODES.has(value);
}

/** `"rtl"` for a right-to-left locale, `"ltr"` otherwise. */
export function directionFor(locale: string): "rtl" | "ltr" {
	return RTL_LANGUAGES.includes(locale) ? "rtl" : "ltr";
}

export interface InitialLocaleResolution {
	locale: LocaleCode;
	/** Which input won — surfaced so callers can log or test the priority. */
	source: "saved" | "navigator" | "base";
	/** A saved value that named no shipped locale; the caller warns about it. */
	rejectedSaved?: string;
}

/**
 * Startup priority: saved preference -> `navigator.language` -> en.
 *
 * A saved value that is not a shipped locale is REPORTED rather than silently
 * dropped — the store turns it into a `console.warn` so a corrupted preference
 * is visible instead of looking like a first run.
 */
export function resolveInitialLocale(
	saved: string | undefined,
	navigatorLanguage: string | undefined,
): InitialLocaleResolution {
	if (isSupportedLocale(saved)) {
		return { locale: saved, source: "saved" };
	}
	const rejectedSaved =
		saved !== undefined && saved.length > 0 ? saved : undefined;

	// `pt-BR` is shipped whole, so try the full tag before its base subtag.
	const candidates =
		navigatorLanguage === undefined
			? []
			: [navigatorLanguage, navigatorLanguage.split("-")[0]];
	for (const candidate of candidates) {
		if (isSupportedLocale(candidate)) {
			return rejectedSaved === undefined
				? { locale: candidate, source: "navigator" }
				: { locale: candidate, source: "navigator", rejectedSaved };
		}
	}

	return rejectedSaved === undefined
		? { locale: BASE_LOCALE, source: "base" }
		: { locale: BASE_LOCALE, source: "base", rejectedSaved };
}
