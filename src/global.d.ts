import type { ConfigMessage } from '$lib/types/socket-messages';

declare global {
  interface Window {
    startStreamingWithNotificationClear: (config: ConfigMessage) => void;
    stopStreamingWithNotificationClear: () => void;
  }
}
export {}; // This makes the file a module
