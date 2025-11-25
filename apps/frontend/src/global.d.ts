// Import $persist rune type declaration
import "@macfja/svelte-persistent-runes";

declare global {
	interface Window {
		startStreamingWithNotificationClear: (
			config: Record<string, string | number | boolean>,
		) => void;
		stopStreamingWithNotificationClear: () => void;
	}

	// Build-time version injected by Vite
	const __APP_VERSION__: string;
}
