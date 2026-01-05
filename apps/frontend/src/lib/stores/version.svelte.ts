// Version tracking store using persistent runes

// Persisted version state
let storedVersion = $persist<string>("", "ceraui_version");

/**
 * Get the stored version
 */
export function getStoredVersion(): string {
	return storedVersion;
}

/**
 * Set the stored version
 */
export function setStoredVersion(version: string): void {
	storedVersion = version;
}

/**
 * Check if version has changed and update storage
 * Returns true if version changed, false otherwise
 */
export function checkAndUpdateVersion(currentVersion: string): boolean {
	const previousVersion = storedVersion;

	// First visit - just store version
	if (!previousVersion) {
		storedVersion = currentVersion;
		return false;
	}

	// Check if version changed
	if (previousVersion !== currentVersion) {
		storedVersion = currentVersion;
		return true;
	}

	return false;
}
