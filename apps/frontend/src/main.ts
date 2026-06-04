import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./app.css";

import { registerSW } from "virtual:pwa-register";
import { mount } from "svelte";

import App from "./App.svelte";
import { initSubscriptions } from "./lib/rpc";
import { push } from "./lib/stores/notifications.svelte";
import { setStoredVersion } from "./lib/stores/version.svelte";

// Feeds the HUD's `subscriptions.svelte` getters from the same shared socket the
// legacy store drives (idempotent). Without this the live HUD never receives data.
initSubscriptions();

// Register Service Worker for PWA updates
registerSW({
	immediate: true,
	onNeedRefresh() {
		// Show update notification when new version is available
		push({
			name: "pwa-update-available",
			type: "info",
			msg: "Update Available",
			key: "notifications.updateAvailable",
			is_dismissable: true,
			is_persistent: true,
			duration: 0,
		});
	},
	onOfflineReady() {
		console.log("PWA: Ready for offline use");
	},
	onRegistered(registration) {
		if (registration) {
			console.log("PWA: Service worker registered", registration);
			// Update stored version when PWA registers successfully
			setStoredVersion(__APP_VERSION__);
		} else {
			// PWA disabled (e.g., dev mode)
			console.log("PWA: Disabled");
		}
	},
	onRegisterError(error: Error) {
		console.error("PWA: Service worker registration failed", error);
	},
});

// Mount the app
const app = mount(App, { target: document.getElementById("app") as Element });

// Signal successful bundle mount to the boot watchdog
window.__ceraAppMounted = true;

export default app;
