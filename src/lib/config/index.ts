import type { Component } from 'svelte';

import { BUILD_INFO } from '$lib/env';
import Advanced from '$main/tabs/Advanced.svelte';
import DevTools from '$main/tabs/DevTools.svelte';
import General from '$main/tabs/General.svelte';
import Network from '$main/tabs/Network.svelte';
import Streaming from '$main/tabs/Streaming.svelte';

export type NavElements = {
  [key: string]: {
    label: string;
    component: Component;
  };
};
// Base navigation elements (always available)
const baseNavElements: NavElements = {
  general: { label: 'general', component: General },
  network: { label: 'network', component: Network },
  streaming: { label: 'streaming', component: Streaming },
  advanced: { label: 'advanced', component: Advanced },
};

// Add dev tools only in development mode
export const navElements: NavElements = {
  ...baseNavElements,
  ...(BUILD_INFO.IS_DEV
    ? {
        devtools: { label: 'devtools', component: DevTools },
      }
    : {}),
};

// Note: defaultNavElement removed to avoid circular dependencies
// Navigation store now initializes with direct General component import

// Device branding configuration
export const deviceName = 'BELABOX';
export const siteName = 'CeraUI for BELABOX©';
