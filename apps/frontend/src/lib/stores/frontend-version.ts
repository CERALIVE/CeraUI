import { LL } from "@ceraui/i18n/svelte";
import { get, writable } from "svelte/store";
import { toast } from "svelte-sonner";

import { CLIENT_VERSION } from "./version-manager";

// Store for tracking frontend version changes
export const frontendVersion = writable<string>(CLIENT_VERSION);
export const hasVersionChanged = writable<boolean>(false);

const FRONTEND_VERSION_KEY = "ceraui_frontend_version";
const LAST_CHECK_KEY = "ceraui_last_version_check";
const MIN_CHECK_INTERVAL = 5000; // 5 seconds

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
	if (lastCheck && now - parseInt(lastCheck) < MIN_CHECK_INTERVAL) {
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
	hasVersionChanged.set(versionChanged);

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

	const $LL = get(LL);
	toast.info($LL.version.newVersionAvailable(), {
		description: `${$LL.version[changeTypeKey.split(".")[1] as keyof typeof $LL.version]()}. ${$LL.version.refreshToUpdate()}.`,
		duration: 8000,
		action: {
			label: $LL.version.refreshNow(),
			onClick: () => {
				window.location.reload();
			},
		},
	});
}

/**
 * Reset version tracking (useful for testing)
 */
export function resetFrontendVersionTracking() {
	localStorage.removeItem(FRONTEND_VERSION_KEY);
	hasVersionChanged.set(false);
}

/**
 * Get version info for debugging
 */
export function getFrontendVersionInfo() {
	return {
		current: CLIENT_VERSION,
		stored: localStorage.getItem(FRONTEND_VERSION_KEY),
		hasChanged: hasVersionChanged,
	};
}

/**
 * Force version change notification (for testing)
 */
export function forceVersionChangeNotification() {
	const storedVersion =
		localStorage.getItem(FRONTEND_VERSION_KEY) || "test-old-version";
	showVersionChangeNotification(storedVersion, CLIENT_VERSION);
}
