import type { Component } from "svelte";
import { Network as NetworkIcon, Radio, Settings as SettingsIcon } from "@lucide/svelte";
import { deviceName, siteName } from "$lib/config/branding";
import DevTools from "$main/tabs/DevTools.svelte";
import IdentityPreview from "$main/tabs/IdentityPreview.svelte";
import LiveView from "$main/LiveView.svelte";
import NetworkView from "$main/NetworkView.svelte";
import SettingsView from "$main/SettingsView.svelte";

// Must stay a direct import.meta.env.DEV literal: Vite inlines it to `false` in
// production, letting Rollup prune the gated branch and tree-shake the dev-only
// DevTools / IdentityPreview imports. A cross-module read like BUILD_INFO.IS_DEV
// is not const-folded and ships both surfaces in prod.
export const isDev: boolean = import.meta.env.DEV;

export type NavElement = {
	label: string;
	component: Component;
	/** Lucide icon component rendered in the nav rail / tab bar. */
	icon?: Component;
	isDev?: boolean;
	/** Plain-text label for dev-only routes that have no i18n key. */
	title?: string;
};

export type NavElements = {
	[key: string]: NavElement;
};

// Primary destinations (always visible) — 3-destination IA: Live / Network / Settings.
// Wired to Wave 1 views.
const baseNavElements: NavElements = {
	live: { label: "live", component: LiveView, icon: Radio },
	network: { label: "network", component: NetworkView, icon: NetworkIcon },
	settings: { label: "settings", component: SettingsView, icon: SettingsIcon },
};

// Add dev tools only in development mode
export const navElements: NavElements = {
	...baseNavElements,
	...(import.meta.env.DEV
		? {
				identity: {
					label: "_identity",
					title: "Identity",
					component: IdentityPreview,
					isDev: true,
				},
				devtools: { label: "devtools", component: DevTools, isDev: true },
			}
		: {}),
};

// No default-destination export lives here: this module sits in a cycle
// (config → DevTools → screenshot-utility → navigation store), so an eager
// navElements read at the store's init would observe navElements undefined.
// The store seeds its initial state from a direct LiveView import; the hash
// fallback in NavigationHelper reads navElements.live lazily inside the function.

// Re-export branding configuration for backward compatibility
export { deviceName, siteName };
