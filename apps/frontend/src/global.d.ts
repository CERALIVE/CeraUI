// Import $persist rune type declaration
import "svelte-persistent-runes";

// Build-time constants injected by Vite
declare global {
	const __APP_VERSION__: string;
	const __BRAND_CONFIG__: {
		siteName: string;
		description: string;
		deviceName: string;
	};
}
