import "./app.css";

import { registerSW } from "virtual:pwa-register";
import { mount } from "svelte";

import App from "./App.svelte";
import { checkFrontendVersionChange } from "./lib/stores/frontend-version";

// Register Service Worker (only frontend update mechanism)
const updateSW = registerSW({
	immediate: true, // Register immediately
	onNeedRefresh() {
		// Show update available notification for frontend builds
		// Import toast dynamically to avoid circular dependencies
		void import("svelte-sonner").then(({ toast }) => {
			toast.info("Update Available", {
				description: "A new frontend version is available. Refresh to update.",
				duration: 0, // Persistent
				action: {
					label: "Refresh",
					onClick: () => {
						updateSW(true);
					},
				},
			});
		});
	},
	onOfflineReady() {
		console.log("PWA: Service worker is ready for offline use");
		// Import toast dynamically
		void import("svelte-sonner").then(({ toast }) => {
			toast.success("Offline Ready", {
				description: "App is ready to work offline!",
				duration: 3000,
			});
		});
	},
	onRegistered(registration: ServiceWorkerRegistration) {
		console.log("PWA: Service worker registered", registration);
	},
	onRegisterError(error: Error) {
		console.error("PWA: Service worker registration failed", error);
	},
});

const app = mount(App, { target: document.getElementById("app") as Element });

// Secondary frontend version checking (backup to PWA service worker)
// This runs after app mount to ensure stores are initialized
setTimeout(() => {
	checkFrontendVersionChange();
}, 1000);

export default app;
