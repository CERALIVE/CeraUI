// Theme store using Svelte 5 runes with persistence
import "@macfja/svelte-persistent-runes";

export type ThemeMode = "system" | "dark" | "light";

let theme = $persist<ThemeMode>("dark", "theme");

export function getTheme(): ThemeMode {
	return theme;
}

export function setTheme(mode: ThemeMode): void {
	theme = mode;
}

// Legacy-compatible store-like object for easier migration
export const themeStore = {
	get value() {
		return theme;
	},
	set: setTheme,
};
