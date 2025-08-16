import type { StreamingConfig } from '$lib/components/streaming/StreamingConfigService';

declare global {
  interface Window {
    startStreamingWithNotificationClear?: (config: StreamingConfig) => void;
    stopStreamingWithNotificationClear?: () => void;
  }
}

export {};