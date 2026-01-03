// Locale store using Svelte 5 runes with persistence
import "svelte-persistent-runes";

import { existingLocales } from "@ceraui/i18n";

export type LocaleInfo = (typeof existingLocales)[number];

// Default to English
const defaultLocale = existingLocales[0];

let locale = $persist<LocaleInfo>(defaultLocale, "locale");

export function getLocale(): LocaleInfo {
	return locale;
}

export function setLocale(newLocale: LocaleInfo): void {
	locale = newLocale;
}

// Legacy-compatible store-like object for easier migration
export const localeStore = {
	get value() {
		return locale;
	},
	set: setLocale,
};
