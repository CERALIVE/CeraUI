/**
 * Load state of the persistent credential stores, for consumers that redact the
 * credentials the backend holds (the log export). Kept free of imports so the
 * test preload can model a booted backend without loading the stores.
 *
 * `pending` until a store's init has classified its file, `ready` once it loaded
 * or there was no file, `failed` when the file existed but could not be read,
 * parsed or validated (the store then starts empty and its values are unknown).
 */
export type CredentialStoreState = "pending" | "ready" | "failed";
type CredentialStore = "hotspot" | "modem";

const states: Record<CredentialStore, CredentialStoreState> = {
	hotspot: "pending",
	modem: "pending",
};

export function setCredentialStoreState(
	store: CredentialStore,
	state: CredentialStoreState,
): void {
	states[store] = state;
}

/** `failed` if any store failed, else `pending` if any is still loading. */
export function credentialStoresState(): CredentialStoreState {
	const all = Object.values(states);
	if (all.includes("failed")) return "failed";
	if (all.includes("pending")) return "pending";
	return "ready";
}
