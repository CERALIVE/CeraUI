import "./app.css";

import { registerSW } from "virtual:pwa-register";
import { mount } from "svelte";

import App from "./App.svelte";
import {
	checkAndUpdateVersion,
	setStoredVersion,
} from "./lib/stores/version.svelte";

/**
 * Fallback version check for when PWA service worker is disabled or fails.
 * Used in development mode or as backup in production.
 */
function checkVersionFallback() {
	const versionChanged = checkAndUpdateVersion(__APP_VERSION__);

	if (versionChanged) {
		// Show update notification
		void import("svelte-sonner").then(({ toast }) => {
			const shortVersion = __APP_VERSION__.split("-")[0];
			toast.info("App Updated", {
				description: `Updated to version ${shortVersion}`,
				duration: 5000,
			});
		});
	}
}

// Track if PWA successfully registered
let pwaRegistered = false;

// Register Service Worker for PWA updates
const updateSW = registerSW({
	immediate: true,
	onNeedRefresh() {
		// Show update notification when new version is available
		void import("svelte-sonner").then(({ toast }) => {
			toast.info("Update Available", {
				description: "A new version is available. Refresh to update.",
				duration: 0, // Persistent until action
				action: {
					label: "Update Now",
					onClick: () => updateSW(true),
				},
			});
		});
	},
	onOfflineReady() {
		console.log("PWA: Ready for offline use");
	},
	onRegistered(registration) {
		if (registration) {
			pwaRegistered = true;
			console.log("PWA: Service worker registered", registration);
			// Update stored version when PWA registers successfully
			setStoredVersion(__APP_VERSION__);
		} else {
			// PWA disabled (e.g., dev mode) - use fallback
			console.log("PWA: Disabled, using version fallback");
			checkVersionFallback();
		}
	},
	onRegisterError(error: Error) {
		console.error("PWA: Service worker registration failed", error);
		// PWA failed - use fallback version check
		checkVersionFallback();
	},
});

// Mount the app
const app = mount(App, { target: document.getElementById("app") as Element });

// Additional fallback: if PWA hasn't registered after a delay, check version
// This handles edge cases where onRegistered never fires
setTimeout(() => {
	if (!pwaRegistered) {
		checkVersionFallback();
	}
}, 2000);

export default app;
