import { getLL } from "@ceraui/i18n/svelte";

import { toast } from "svelte-sonner";

import { CLIENT_VERSION } from "./version-manager";

// State for tracking frontend version changes using Svelte 5 runes
let frontendVersionState = $state<string>(CLIENT_VERSION);
let hasVersionChangedState = $state(false);

const FRONTEND_VERSION_KEY = "ceraui_frontend_version";
const LAST_CHECK_KEY = "ceraui_last_version_check";
const MIN_CHECK_INTERVAL = 5000; // 5 seconds

// Getters
export function getFrontendVersion(): string {
	return frontendVersionState;
}

export function getHasVersionChanged(): boolean {
	return hasVersionChangedState;
}

// Setters
export function setHasVersionChanged(value: boolean): void {
	hasVersionChangedState = value;
}

/**
 * Check if frontend version has changed since last visit
 * This works as a secondary detection mechanism alongside PWA service worker
 */
export function checkFrontendVersionChange(): boolean {
	const currentVersion = CLIENT_VERSION;
	const storedVersion = localStorage.getItem(FRONTEND_VERSION_KEY);

	// Check if another tab recently handled the version change
	const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
	const now = Date.now();
	if (lastCheck && now - Number.parseInt(lastCheck) < MIN_CHECK_INTERVAL) {
		return false;
	}

	// First visit - just store the version
	if (!storedVersion) {
		localStorage.setItem(FRONTEND_VERSION_KEY, currentVersion);
		localStorage.setItem(LAST_CHECK_KEY, now.toString());
		return false;
	}

	// Check if version changed
	const versionChanged = storedVersion !== currentVersion;
	hasVersionChangedState = versionChanged;

	if (versionChanged) {
		// Update stored version immediately to prevent repeated notifications
		localStorage.setItem(FRONTEND_VERSION_KEY, currentVersion);
		localStorage.setItem(LAST_CHECK_KEY, now.toString());

		// Show secondary update notification
		showVersionChangeNotification(storedVersion, currentVersion);
		return true;
	}

	return false;
}

/**
 * Show version change notification (secondary to PWA updates)
 */
function showVersionChangeNotification(oldVersion: string, newVersion: string) {
	// Parse versions to understand what changed
	const oldParts = oldVersion.split("-");
	const newParts = newVersion.split("-");

	const commitChanged = oldParts[0] !== newParts[0];
	const buildChanged = oldParts[1] !== newParts[1];

	let changeTypeKey = "version.newVersionAvailable";
	if (commitChanged && buildChanged) {
		changeTypeKey = "version.newCodeAndBuild";
	} else if (commitChanged) {
		changeTypeKey = "version.newCodeVersion";
	} else if (buildChanged) {
		changeTypeKey = "version.newBuildVersion";
	}

	const translations = getLL();
	toast.info(translations.version.newVersionAvailable(), {
		description: `${translations.version[changeTypeKey.split(".")[1] as keyof typeof translations.version]()}. ${translations.version.refreshToUpdate()}.`,
		duration: 8000,
		action: {
			label: translations.version.refreshNow(),
			onClick: () => {
				window.location.reload();
			},
		},
	});
}

/**
 * Reset version tracking (useful for testing)
 */
export function resetFrontendVersionTracking(): void {
	localStorage.removeItem(FRONTEND_VERSION_KEY);
	hasVersionChangedState = false;
}

/**
 * Get version info for debugging
 */
export function getFrontendVersionInfo() {
	return {
		current: CLIENT_VERSION,
		stored: localStorage.getItem(FRONTEND_VERSION_KEY),
		hasChanged: hasVersionChangedState,
	};
}

/**
 * Force version change notification (for testing)
 */
export function forceVersionChangeNotification(): void {
	const storedVersion =
		localStorage.getItem(FRONTEND_VERSION_KEY) || "test-old-version";
	showVersionChangeNotification(storedVersion, CLIENT_VERSION);
}

// Legacy-compatible store-like objects
export const frontendVersion = {
	get value() {
		return frontendVersionState;
	},
};

export const hasVersionChanged = {
	get value() {
		return hasVersionChangedState;
	},
	set: setHasVersionChanged,
};
