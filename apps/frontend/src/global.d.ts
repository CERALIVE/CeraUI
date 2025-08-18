import type { ConfigMessage } from '$lib/types/socket-messages';

declare global {
  interface Window {
    startStreamingWithNotificationClear: (config: ConfigMessage) => void;
    stopStreamingWithNotificationClear: () => void;
  }

  // Build-time version injected by Vite
  const __APP_VERSION__: string;
}

export {}; // This makes the file a module
