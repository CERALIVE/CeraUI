/**
 * WebSocket URL resolution for the CeraUI frontend.
 *
 * PRODUCTION TOPOLOGY: a single backend binary serves the static frontend AND
 * the WebSocket RPC on the SAME host:port (device port 80). The browser already
 * knows that origin — it is `window.location` — so the production socket URL is
 * derived purely from it. No host, port, or protocol is hardcoded, and the
 * `VITE_SOCKET_*` overrides (which leak in from the monorepo-root `.env` via
 * Vite's `envDir`) are deliberately ignored in production builds.
 *
 * DEV TOPOLOGY: Vite serves the app on :6173 while the backend listens on :3002,
 * so the page origin is NOT the backend. Development therefore keeps honoring the
 * `VITE_SOCKET_ENDPOINT` / `VITE_SOCKET_PORT` overrides, falling back to the page
 * hostname + the backend dev port.
 */

interface BuildInfo {
	MODE: string;
	NODE_ENV: string;
	IS_DEV: boolean;
	IS_PROD: boolean;
	IS_SSR: boolean;
}

/** Loopback/LAN port where the cerastream engine serves the preview WebSocket
 * directly (ADR-0002 preview-ws addendum) — NOT the CeraUI backend port. */
interface EnvVariables {
	PREVIEW_PORT: string;
}

/**
 * The subset of `window.location` the socket resolver needs. `host` carries the
 * `:port` suffix ONLY on non-default ports; `hostname` never does. Keeping this
 * as an explicit input (rather than reaching for the global) makes the resolver
 * a pure function that is trivial to test across origins.
 */
export interface SocketLocation {
	protocol: string;
	host: string;
	hostname: string;
}

export interface SocketUrlInputs {
	location: SocketLocation | undefined;
	isProd: boolean;
	endpointOverride: string | undefined;
	portOverride: string | undefined;
}

/**
 * Non-browser / SSR fallback. Deliberately NOT "localhost": an empty string is
 * an invalid WebSocket URL, so any accidental use outside the browser fails
 * loudly instead of silently dialing the developer's own machine.
 */
export const NON_BROWSER_SOCKET_URL = "";

/** CeraUI backend dev port — see `apps/backend/src/rpc/server.ts` getListenPorts. */
const DEV_DEFAULT_SOCKET_PORT = "3002";

const DEFAULT_PREVIEW_PORT = "9997";

function wsScheme(protocol: string): "ws" | "wss" {
	return protocol === "https:" ? "wss" : "ws";
}

/**
 * Pure resolver for the RPC WebSocket URL. See the module header for the prod vs
 * dev split. Exported for unit testing; production code calls `getSocketUrl()`.
 */
export function resolveSocketUrl(inputs: SocketUrlInputs): string {
	const { location, isProd, endpointOverride, portOverride } = inputs;

	// PRODUCTION: derive entirely from the page origin. `location.host` is
	// authoritative — it already includes `:port` iff the port is non-default, so
	// we never reconstruct host+port by hand (which would double a port or drop a
	// non-default one). Overrides are intentionally ignored here.
	if (isProd) {
		if (!location) {
			return NON_BROWSER_SOCKET_URL;
		}
		return `${wsScheme(location.protocol)}://${location.host}`;
	}

	// DEVELOPMENT: the origin host points at Vite, not the backend, so honor the
	// explicit overrides and fall back to hostname + the backend dev port.
	const port = portOverride ?? DEV_DEFAULT_SOCKET_PORT;
	const endpoint =
		endpointOverride ??
		(location
			? `${wsScheme(location.protocol)}://${location.hostname}`
			: undefined);

	if (!endpoint) {
		return NON_BROWSER_SOCKET_URL;
	}
	return `${endpoint}:${port}`;
}

function browserLocation(): SocketLocation | undefined {
	if (typeof window === "undefined" || typeof window.location === "undefined") {
		return undefined;
	}
	const { protocol, host, hostname } = window.location;
	return { protocol, host, hostname };
}

/**
 * E2E per-worker backend routing seam (dev-only). The Playwright harness spawns
 * ONE mock backend per worker on a unique port and sets `window.__ceraSocketPort`
 * via an `addInitScript` BEFORE the app boots, so each worker's browser dials its
 * OWN isolated backend instead of a single shared instance. Returns the port as
 * the string shape `resolveSocketUrl` expects, or `undefined` when unset/invalid.
 *
 * This is consulted ONLY inside the `import.meta.env.DEV` branch of
 * `getSocketUrl`, so a production build folds it out entirely — the global is
 * never read on a device. Pure (window-like injected) so it is unit-testable.
 */
export function resolveRuntimePortOverride(
	win: { __ceraSocketPort?: unknown } | undefined,
): string | undefined {
	const raw = win?.__ceraSocketPort;
	if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
		return String(raw);
	}
	if (typeof raw === "string" && /^\d+$/.test(raw)) {
		return raw;
	}
	return undefined;
}

function runtimePortOverride(): string | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}
	return resolveRuntimePortOverride(window as { __ceraSocketPort?: unknown });
}

/**
 * The RPC WebSocket URL for the current environment. Single source of truth —
 * every WebSocket consumer (rpc/client) routes through this.
 */
export function getSocketUrl(): string {
	// DEV-gate the override reads so prod statically folds them to `undefined`: a
	// poisoned `VITE_SOCKET_ENDPOINT` in the root `.env` must never bake as a
	// literal into the bundle (incl. the non-tree-shaken DevTools chunk).
	return resolveSocketUrl({
		location: browserLocation(),
		isProd: import.meta.env.PROD,
		endpointOverride: import.meta.env.DEV
			? import.meta.env.VITE_SOCKET_ENDPOINT
			: undefined,
		portOverride: import.meta.env.DEV
			? (runtimePortOverride() ?? import.meta.env.VITE_SOCKET_PORT)
			: undefined,
	});
}

export const ENV_VARIABLES: EnvVariables = {
	PREVIEW_PORT: import.meta.env.VITE_PREVIEW_PORT || DEFAULT_PREVIEW_PORT,
};

export function getPreviewSocketUrl(): string {
	const location = browserLocation();
	if (!location) {
		return NON_BROWSER_SOCKET_URL;
	}
	return `${wsScheme(location.protocol)}://${location.hostname}:${ENV_VARIABLES.PREVIEW_PORT}`;
}

export const BUILD_INFO: BuildInfo = {
	MODE: import.meta.env.MODE,
	NODE_ENV: import.meta.env.NODE_ENV || import.meta.env.MODE || "development",
	IS_DEV: import.meta.env.DEV,
	IS_PROD: import.meta.env.PROD,
	IS_SSR: import.meta.env.SSR,
};
