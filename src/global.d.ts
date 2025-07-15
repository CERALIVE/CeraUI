import type { ConfigMessage } from '$lib/types/socket-messages';

declare global {
  interface Window {
    startStreamingWithNotificationClear: (config: ConfigMessage) => void;
    stopStreamingWithNotificationClear: () => void;
  }
}

declare module '*.svelte' {
  export { SvelteComponent as default } from 'svelte';
}

export {}; // This makes the file a module
