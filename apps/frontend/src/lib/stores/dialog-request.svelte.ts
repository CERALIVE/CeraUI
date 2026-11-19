import type { NotificationActionTarget } from "@ceraui/rpc/schemas";

import type { ShellTab } from "$lib/device-logs/shell-layout";

// A single-slot request bus so an allowlisted notification action, or a "View
// logs" action, can deep-link into a Settings dialog. The producer calls
// requestDialog(); SettingsView consumes it via an effect and clears it. `logs`
// is a frontend-only target: it never travels on the notification wire. Held on
// globalThis for the same dev dual-URL reason as the notification store. The
// toast host and SettingsView must share ONE slot.
export type DialogTarget = NotificationActionTarget | "logs";

/** Where System Logs opens: a tab, and the boot and moment its raw entries surround. */
export interface LogsDialogContext {
	tab?: ShellTab;
	bootId?: string;
	at?: number;
}

interface DialogRequest {
	target: DialogTarget;
	context?: LogsDialogContext;
}

interface DialogRequestStore {
	get requested(): DialogRequest | undefined;
	set(request: DialogRequest | undefined): void;
}

function createStore(): DialogRequestStore {
	let requested = $state<DialogRequest | undefined>(undefined);
	return {
		get requested() {
			return requested;
		},
		set(request) {
			requested = request;
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

// Every target is a Settings dialog, so every request switches there.
export function requestDialog(
	target: DialogTarget,
	context?: LogsDialogContext,
): void {
	singleton.set({ target, context });
	void import("$lib/stores/navigation-lazy").then(({ navigateToDestination }) =>
		navigateToDestination("settings"),
	);
}

export function getRequestedDialog(): DialogTarget | undefined {
	return singleton.requested?.target;
}

export function getRequestedDialogContext(): LogsDialogContext | undefined {
	return singleton.requested?.context;
}

export function clearRequestedDialog(): void {
	singleton.set(undefined);
}
