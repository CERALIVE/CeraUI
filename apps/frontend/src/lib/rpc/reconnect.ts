/**
 * Reconnect re-authentication + safety hydrate (Task 7).
 *
 * When the RPC WebSocket transitions back to `connected` after the operator has
 * already authenticated this page-load, the *new* socket is unauthenticated: the
 * backend only pushes device state after a successful `auth.login`
 * (see apps/backend/src/rpc/adapter.ts:83-88). Without re-auth the UI keeps
 * showing the authenticated shell while every view is blank — the live-reload
 * blank-state bug.
 *
 * This module re-establishes the session using the stored credential, then fires
 * a safety hydrate (`streaming.getConfig` + `status.getStatus`, both authed
 * procedures) and routes the results through the existing `handleMessage` path so
 * the HUD and destination views repopulate even if the backend's post-login push
 * is incomplete.
 *
 * The logic here is intentionally *pure* and dependency-injected so it runs under
 * the plain (non-Svelte) vitest environment — the `.svelte.ts` reactive layer
 * that owns the runes is never imported by the unit test (which would throw).
 *
 * NOTE on the "token": the remember-me credential persisted under localStorage
 * `auth` is the *password* (see `Auth.svelte`), and the backend `auth.login`
 * verifies it via `input.password`. We therefore re-authenticate by passing the
 * stored credential as the password, not as a server-issued `token`.
 */

/** Outcome of a single reconnect re-auth attempt. */
export type ReauthOutcome =
	/** Nothing stored — first-time/initial-load login owns the first auth. */
	| "no-token"
	/** Re-auth succeeded and the safety hydrate ran. */
	| "hydrated"
	/** Stored credential rejected — cleared and routed to the login screen. */
	| "expired";

export interface ReauthDeps {
	/** Read the stored credential (localStorage `auth`); null when absent. */
	getStoredToken: () => string | null;
	/** Remove the stored credential after a rejection (natural loop break). */
	clearStoredToken: () => void;
	/** Re-authenticate with the stored credential. */
	login: (token: string) => Promise<{ success: boolean }>;
	/** Safety-hydrate source: current streaming config (authed procedure). */
	getConfig: () => Promise<unknown>;
	/** Safety-hydrate source: aggregated device status (authed procedure). */
	getStatus: () => Promise<unknown>;
	/** Route a message through the existing `handleMessage` path. */
	dispatch: (type: string, data: unknown) => void;
	/** Route to the login screen (session expired). Called at most once. */
	routeToLogin: () => void;
	/** Optional diagnostics sink for transport/hydrate errors. */
	onError?: (error: unknown) => void;
}

/**
 * Re-authenticate on a reconnect, then safety-hydrate the view state.
 *
 * Guarantees no auth loop: on rejection (or a transport error) the stored
 * credential is cleared, so a subsequent invocation short-circuits at
 * {@link ReauthDeps.getStoredToken} returning `null` (→ `"no-token"`) and never
 * calls {@link ReauthDeps.login} again.
 */
export async function reauthenticateAndHydrate(
	deps: ReauthDeps,
): Promise<ReauthOutcome> {
	const token = deps.getStoredToken();
	if (!token) return "no-token";

	let result: { success: boolean };
	try {
		result = await deps.login(token);
	} catch (error) {
		// A transport/RPC error during re-auth is treated as a dead session:
		// clear the credential and route to login (no retry → no loop).
		deps.onError?.(error);
		deps.clearStoredToken();
		deps.dispatch("auth", { success: false });
		deps.routeToLogin();
		return "expired";
	}

	// Feed the auth result through the canonical handleMessage path.
	deps.dispatch("auth", result);

	if (!result.success) {
		// Stored credential expired/invalid: clear it so the next reconnect finds
		// no token (loop break) and route to the login screen.
		deps.clearStoredToken();
		deps.routeToLogin();
		return "expired";
	}

	// Safety hydrate: pull config + status and route both through handleMessage so
	// the HUD and destination views repopulate after the socket swap. This is
	// defense-in-depth on top of the backend's post-login push.
	try {
		const [config, status] = await Promise.all([
			deps.getConfig(),
			deps.getStatus(),
		]);
		deps.dispatch("config", config);
		deps.dispatch("status", status);
	} catch (error) {
		// A hydrate failure is non-fatal: the backend's post-login push still feeds
		// the stores. Surface it for diagnostics but keep the authed session.
		deps.onError?.(error);
	}

	return "hydrated";
}
