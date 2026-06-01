import type { Component } from "svelte";
import { Network as NetworkIcon, Radio, Settings as SettingsIcon } from "@lucide/svelte";
import { deviceName, siteName } from "$lib/config/branding";
import { BUILD_INFO } from "$lib/env";
import Advanced from "$main/tabs/Advanced.svelte";
import DevTools from "$main/tabs/DevTools.svelte";
import IdentityPreview from "$main/tabs/IdentityPreview.svelte";
import Network from "$main/tabs/Network.svelte";
import Streaming from "$main/tabs/Streaming.svelte";

// Development-only flag (mirrors Vite's import.meta.env.DEV via BUILD_INFO).
// Dev-only surfaces (DevTools, the identity preview) gate on this.
export const isDev: boolean = BUILD_INFO.IS_DEV;

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
// Temporarily wired to existing tab content; Wave 1 views replace these.
const baseNavElements: NavElements = {
	live: { label: "live", component: Streaming, icon: Radio },
	network: { label: "network", component: Network, icon: NetworkIcon },
	settings: { label: "settings", component: Advanced, icon: SettingsIcon },
};

// Add dev tools only in development mode
export const navElements: NavElements = {
	...baseNavElements,
	...(isDev
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

// Note: defaultNavElement removed to avoid circular dependencies
// Navigation store now initializes with a direct Streaming component import (label "live")

// Re-export branding configuration for backward compatibility
export { deviceName, siteName };
