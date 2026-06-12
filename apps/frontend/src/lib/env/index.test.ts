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
