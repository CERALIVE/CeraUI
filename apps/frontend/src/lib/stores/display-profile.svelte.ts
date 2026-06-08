// Display-profile store using Svelte 5 runes with persistence.
// Mirrors layout-mode.svelte.ts. Drives the DC-4 URL contract
// (?display=lcd|eink|mono): App.svelte parses the param, persists it here, and
// reflects it onto <html> as data-display (always) plus data-theme="eink" for
// the e-ink/mono profiles. CSS tokens for those themes are authored in Task 10.
import "svelte-persistent-runes";

export type DisplayProfile = "lcd" | "eink" | "mono";

// Known profiles, in canonical order. Source of truth for both the URL-param
// allow-list and the union above — keeps the contract free of inline literals.
export const DISPLAY_PROFILES = [
	"lcd",
	"eink",
	"mono",
] as const satisfies readonly DisplayProfile[];

export const DEFAULT_DISPLAY_PROFILE: DisplayProfile = "lcd";

let displayProfile = $persist<DisplayProfile>(
	DEFAULT_DISPLAY_PROFILE,
	"display-profile",
);

export function getDisplayProfile(): DisplayProfile {
	return displayProfile;
}

export function setDisplayProfile(profile: DisplayProfile): void {
	displayProfile = profile;
}

/**
 * Normalize a raw `?display=` URL value to a known profile. Anything absent or
 * unrecognized falls back to {@link DEFAULT_DISPLAY_PROFILE} (`lcd`), so a bogus
 * param can never leave the app in an undefined visual state.
 */
export function parseDisplayProfile(
	value: string | null | undefined,
): DisplayProfile {
	return (DISPLAY_PROFILES as readonly string[]).includes(value ?? "")
		? (value as DisplayProfile)
		: DEFAULT_DISPLAY_PROFILE;
}

/**
 * Whether the profile should activate the e-ink theme (`data-theme="eink"`):
 * true for the `eink` and `mono` profiles, false for `lcd`.
 */
export function prefersEinkTheme(profile: DisplayProfile): boolean {
	return profile === "eink" || profile === "mono";
}

// Re-exported from the dedicated `display-refresh` module so the manual e-ink
// refresh hook (Task 12) is reachable from the display-profile store.
export {
	getDisplayRefreshNonce,
	onDisplayRefresh,
	requestDisplayRefresh,
} from "./display-refresh.svelte";

// Legacy-compatible store-like object for easier migration
export const displayProfileStore = {
	get value() {
		return displayProfile;
	},
	set: setDisplayProfile,
};
