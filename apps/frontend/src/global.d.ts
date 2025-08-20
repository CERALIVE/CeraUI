declare global {
	interface Window {
		startStreamingWithNotificationClear: (config: any) => void;
		stopStreamingWithNotificationClear: () => void;
	}

	// Build-time version injected by Vite
	const __APP_VERSION__: string;
}
