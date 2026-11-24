const BOOT_RELOAD_KEY = "ceraui:boot-namespace-reload";
const MODULE_FETCH_FAILURE =
	/^(Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module)/i;

export function recoverBootNamespace(error: unknown): void {
	if (
		!(error instanceof TypeError) ||
		!MODULE_FETCH_FAILURE.test(error.message)
	)
		return;

	try {
		if (sessionStorage.getItem(BOOT_RELOAD_KEY) !== null) return;
		sessionStorage.setItem(BOOT_RELOAD_KEY, "1");
	} catch (storageError) {
		// Without a reservation that survives navigation, do not risk a loop.
		if (storageError instanceof DOMException) return;
		throw storageError;
	}

	// Let brief interface churn settle, then start with a fresh module map.
	setTimeout(() => location.reload(), 500);
}
