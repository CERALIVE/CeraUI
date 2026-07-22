import type { NotificationActionTarget } from "@ceraui/rpc/schemas";

// A single-slot request bus so an allowlisted notification action can deep-link
// into a config dialog. The producer (a notification tap) calls requestDialog();
// the owning view (SettingsView for `updates-dialog`) consumes it via an effect
// and clears it. Held on globalThis for the same dev dual-URL reason as the
// notification store — the toast host and SettingsView must share ONE slot.
interface DialogRequestStore {
	get requested(): NotificationActionTarget | undefined;
	set(target: NotificationActionTarget | undefined): void;
}

function createStore(): DialogRequestStore {
	let requested = $state<NotificationActionTarget | undefined>(undefined);
	return {
		get requested() {
			return requested;
		},
		set(target) {
			requested = target;
		},
	};
}

const STORE_KEY = Symbol.for("ceraui.dialogRequest");
type GlobalWithStore = typeof globalThis & {
	[STORE_KEY]?: DialogRequestStore;
};

const singleton: DialogRequestStore = ((): DialogRequestStore => {
	const g = globalThis as GlobalWithStore;
	const existing = g[STORE_KEY] ?? createStore();
	g[STORE_KEY] = existing;
	return existing;
})();

export function requestDialog(target: NotificationActionTarget): void {
	singleton.set(target);
	if (target === "updates-dialog") {
		// Lazy import so `$lib/config` (which statically pulls the dev-only DevTools
		// → pwa → window.matchMedia chain) stays OUT of this module's static graph.
		// It only resolves when a notification is actually tapped at runtime, where
		// the browser has matchMedia — so importers like SettingsView never drag it
		// into a jsdom test that doesn't stub matchMedia.
		void (async () => {
			const { navElements } = await import("$lib/config");
			const { navigateTo } = await import("$lib/stores/navigation.svelte");
			if (navElements.settings) navigateTo({ settings: navElements.settings });
		})();
	}
}

export function getRequestedDialog(): NotificationActionTarget | undefined {
	return singleton.requested;
}

export function clearRequestedDialog(): void {
	singleton.set(undefined);
}
