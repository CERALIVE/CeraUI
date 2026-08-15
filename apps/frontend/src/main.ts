import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./app.css";

import { registerSW } from "virtual:pwa-register";
import { mount } from "svelte";

import App from "./App.svelte";
import {
	ensureBootNamespaces,
	prefetchDeferredNamespaces,
} from "./lib/i18n/namespace-activation";
import { initSubscriptions } from "./lib/rpc";
import { initAsyncOperations } from "./lib/rpc/async-operation.svelte";
import { initFieldSyncState } from "./lib/rpc/field-sync-state.svelte";
import { initDeviceHealthHistory } from "./lib/stores/device-health-history.svelte";
import { setStoredVersion } from "./lib/stores/version.svelte";

// Feeds the HUD's `subscriptions.svelte` getters from the same shared socket the
// legacy store drives (idempotent). Without this the live HUD never receives data.
initSubscriptions();

// Create the per-field sync-state store before any component mounts, so its
// reactive root is never first built mid-render (which would break getFieldState).
initFieldSyncState();

// Eagerly create the keyed async-operation store before mount, for the same
// reason: its reactive root must not be first instantiated mid-render, or
// later external transitions (begin/confirm/reconcile) never reach the surface.
initAsyncOperations();

// Start filling the Device Health rings at app start, NOT on dialog open: a ring
// that only began filling when the panel opened would present a blank instrument
// at the exact moment the operator needs history. Costs ~400 numbers.
initDeviceHealthHistory();

// Register the Service Worker for PWA auto-update. There is deliberately NO
// onNeedRefresh notification (Todo 24): the SW is registerType:"autoUpdate" with
// skipWaiting+clientsClaim (pwa.config.ts), so a new bundle is applied
// automatically — a manual "Update Available" toast never actually fired under
// autoUpdate and was a SECOND, frontend-only "update available" source of truth
// that bypassed the durable dismissal/action system. Device (apt) updates are the
// ONE unified update state machine now; the browser-bundle refresh is silent.
registerSW({
	immediate: true,
	onOfflineReady() {
		/* no-op: offline readiness is surfaced via the PWA UI, not logged */
	},
	onRegistered(registration) {
		if (registration) {
			setStoredVersion(__APP_VERSION__);
		}
	},
	onRegisterError(error: Error) {
		console.error("PWA: Service worker registration failed", error);
	},
});

// Every i18n namespace is a lazily-imported chunk. Only the SHELL set is awaited
// here — the destinations resolve their own namespaces at the navigation
// activation point (see lib/i18n/namespace-activation.ts), so first paint no
// longer waits on the whole catalog while still never rendering a dotted key.
await ensureBootNamespaces();

// Mount the app
const app = mount(App, { target: document.getElementById("app") as Element });

// Warm the deferred namespaces now that the shell is on screen. Non-blocking:
// the destination activation gate is what guarantees correctness, this only
// keeps the first navigation off the fetch path.
prefetchDeferredNamespaces();

// Signal successful bundle mount to the boot watchdog
window.__ceraAppMounted = true;

export default app;
