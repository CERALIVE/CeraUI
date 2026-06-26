/**
 * Unit tests for the origin-derived WebSocket URL resolver.
 *
 * The production device serves the static frontend AND the WebSocket RPC from a
 * single backend binary on the same host:port, so the socket URL must be derived
 * purely from the page origin (`window.location`) — never from a hardcoded host,
 * port, or protocol, and never from a `VITE_SOCKET_*` override baked into the
 * build. These tests pin that contract against the pure `resolveSocketUrl` core
 * (real `window.location` / `import.meta.env` are injected by the thin
 * `getSocketUrl` wrapper in the module).
 */

import { describe, expect, it } from "vitest";

import {
	NON_BROWSER_SOCKET_URL,
	resolveRuntimePortOverride,
	resolveSocketUrl,
	type SocketLocation,
} from "./index";

// `window.location` exposes `host` (host:port, port present only on non-default
// ports) and `hostname` (no port). The resolver consumes both shapes.
function loc(href: string): SocketLocation {
	const u = new URL(href);
	return { protocol: u.protocol, host: u.host, hostname: u.hostname };
}

describe("resolveSocketUrl — production (origin-derived)", () => {
	it("derives ws://host with no port suffix on a default HTTP port", () => {
		expect(
			resolveSocketUrl({
				location: loc("http://192.168.1.100/"),
				isProd: true,
				endpointOverride: undefined,
				portOverride: undefined,
			}),
		).toBe("ws://192.168.1.100");
	});

	it("derives ws://hostname for an mDNS .local name", () => {
		expect(
			resolveSocketUrl({
				location: loc("http://ceralive.local/"),
				isProd: true,
				endpointOverride: undefined,
				portOverride: undefined,
			}),
		).toBe("ws://ceralive.local");
	});

	it("preserves a non-default port via location.host (never reconstructed)", () => {
		expect(
			resolveSocketUrl({
				location: loc("http://192.168.1.100:8080/"),
				isProd: true,
				endpointOverride: undefined,
				portOverride: undefined,
			}),
		).toBe("ws://192.168.1.100:8080");
	});

	it("maps https: to the wss: scheme", () => {
		expect(
			resolveSocketUrl({
				location: loc("https://ceralive.local/"),
				isProd: true,
				endpointOverride: undefined,
				portOverride: undefined,
			}),
		).toBe("wss://ceralive.local");
	});

	it("ignores VITE_SOCKET_* overrides in production", () => {
		expect(
			resolveSocketUrl({
				location: loc("http://192.168.1.100/"),
				isProd: true,
				endpointOverride: "ws://leaked.example",
				portOverride: "9999",
			}),
		).toBe("ws://192.168.1.100");
	});
});

describe("resolveSocketUrl — development (overrides honored)", () => {
	it("honors VITE_SOCKET_ENDPOINT / VITE_SOCKET_PORT overrides", () => {
		expect(
			resolveSocketUrl({
				location: loc("http://localhost:6173/"),
				isProd: false,
				endpointOverride: "ws://customhost",
				portOverride: "1234",
			}),
		).toBe("ws://customhost:1234");
	});
});

describe("resolveRuntimePortOverride — dev-only per-worker routing seam", () => {
	it("returns the port string for a positive integer", () => {
		expect(resolveRuntimePortOverride({ __ceraSocketPort: 3105 })).toBe("3105");
	});

	it("accepts an all-digit string", () => {
		expect(resolveRuntimePortOverride({ __ceraSocketPort: "3107" })).toBe(
			"3107",
		);
	});

	it("ignores an unset, non-numeric, or non-positive value", () => {
		expect(resolveRuntimePortOverride(undefined)).toBeUndefined();
		expect(resolveRuntimePortOverride({})).toBeUndefined();
		expect(
			resolveRuntimePortOverride({ __ceraSocketPort: "ws://evil" }),
		).toBeUndefined();
		expect(resolveRuntimePortOverride({ __ceraSocketPort: 0 })).toBeUndefined();
		expect(
			resolveRuntimePortOverride({ __ceraSocketPort: -5 }),
		).toBeUndefined();
		expect(
			resolveRuntimePortOverride({ __ceraSocketPort: 1.5 }),
		).toBeUndefined();
	});

	it("takes precedence over VITE_SOCKET_PORT when resolved as the dev portOverride", () => {
		const port = resolveRuntimePortOverride({ __ceraSocketPort: 3110 });
		expect(
			resolveSocketUrl({
				location: loc("http://localhost:6173/"),
				isProd: false,
				endpointOverride: undefined,
				portOverride: port ?? "3002",
			}),
		).toBe("ws://localhost:3110");
	});
});

describe("resolveSocketUrl — non-browser / SSR guard", () => {
	it("falls back to a non-localhost sentinel when there is no location", () => {
		expect(NON_BROWSER_SOCKET_URL).not.toContain("localhost");
		expect(
			resolveSocketUrl({
				location: undefined,
				isProd: true,
				endpointOverride: undefined,
				portOverride: undefined,
			}),
		).toBe(NON_BROWSER_SOCKET_URL);
	});
});
