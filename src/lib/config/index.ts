import type { Component } from 'svelte';

import Advanced from '$main/tabs/Advanced.svelte';
import DevTools from '$main/tabs/DevTools.svelte';
import General from '$main/tabs/General.svelte';
import Network from '$main/tabs/Network.svelte';
import Streaming from '$main/tabs/Streaming.svelte';
import { BUILD_INFO } from '$lib/env';

export type NavElements = {
  [key: string]: {
    label: string;
    component: Component;
  };
};
// Base navigation elements (always available)
const baseNavElements: NavElements = {
  general: { label: 'general', component: General },
  wifi: { label: 'network', component: Network },
  settings: { label: 'streaming', component: Streaming },
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

const navElementsEntries = Object.entries(navElements);

export const defaultNavElement = {
  [navElementsEntries[0][0]]: {
    label: navElementsEntries[0][1].label,
    component: navElementsEntries[0][1].component,
  },
};

// Device branding configuration
export const deviceName = 'BELABOX';
export const siteName = 'CeraUI for BELABOX©';
