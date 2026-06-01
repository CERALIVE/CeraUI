// Layout-mode store using Svelte 5 runes with persistence.
// "touch" enables the touchscreen/kiosk foundation (larger hit targets, scaled spacing).
import "svelte-persistent-runes";

export type LayoutMode = "default" | "touch";

let layoutMode = $persist<LayoutMode>("default", "layout-mode");

export function getLayoutMode(): LayoutMode {
	return layoutMode;
}

export function setLayoutMode(mode: LayoutMode): void {
	layoutMode = mode;
}

// Legacy-compatible store-like object for easier migration
export const layoutModeStore = {
	get value() {
		return layoutMode;
	},
	set: setLayoutMode,
};
