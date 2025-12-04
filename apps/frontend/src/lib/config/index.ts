import type { Component } from "svelte";
import { deviceName, siteName } from "$lib/config/branding";
import { BUILD_INFO } from "$lib/env";
import Advanced from "$main/tabs/Advanced.svelte";
import DevTools from "$main/tabs/DevTools.svelte";
import General from "$main/tabs/General.svelte";
import Network from "$main/tabs/Network.svelte";
import Streaming from "$main/tabs/Streaming.svelte";

export type NavElement = {
	label: string;
	component: Component;
	isDev?: boolean;
};

export type NavElements = {
	[key: string]: NavElement;
};

// Base navigation elements (always available - production tools)
const baseNavElements: NavElements = {
	general: { label: "general", component: General },
	network: { label: "network", component: Network },
	streaming: { label: "streaming", component: Streaming },
	advanced: { label: "advanced", component: Advanced },
};

// Add dev tools only in development mode
export const navElements: NavElements = {
	...baseNavElements,
	...(BUILD_INFO.IS_DEV
		? {
				devtools: { label: "devtools", component: DevTools, isDev: true },
			}
		: {}),
};

// Note: defaultNavElement removed to avoid circular dependencies
// Navigation store now initializes with direct General component import

// Re-export branding configuration for backward compatibility
export { deviceName, siteName };
