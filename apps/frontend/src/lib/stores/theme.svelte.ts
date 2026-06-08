// Theme store using Svelte 5 runes with persistence
import "svelte-persistent-runes";

// "system" | "dark" | "light" are the user-selectable color modes (the
// mode-toggle surfaces these three). "mono" is the e-ink/mono display-profile
// counterpart: selected by the display profile, not the toggle, and rendered via
// the grayscale data-theme="eink" token set rather than a light/dark color mode.
export type ThemeMode = "system" | "dark" | "light" | "mono";

let theme = $persist<ThemeMode>("dark", "theme");

export function getTheme(): ThemeMode {
	return theme;
}

export function setTheme(mode: ThemeMode): void {
	theme = mode;
}

// On headless devices with no prefers-color-scheme, system defaults to dark.
// A `prefers-color-scheme: light` miss covers both OS-prefers-dark and no-preference,
// so this resolves both to dark deterministically (matches mode-watcher + the FOUC script).
export function resolveSystemMode(): "dark" | "light" {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return "dark";
	}
	return window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

// Legacy-compatible store-like object for easier migration
export const themeStore = {
	get value() {
		return theme;
	},
	set: setTheme,
};
