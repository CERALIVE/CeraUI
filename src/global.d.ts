declare global {
  interface Window {
    startStreamingWithNotificationClear: (config: { [key: string]: string | number }) => void;
    stopStreamingWithNotificationClear: () => void;
  }
}
export {}; // This makes the file a module
