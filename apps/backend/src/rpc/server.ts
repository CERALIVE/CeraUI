/**
 * Bun Native Server
 * HTTP and WebSocket server using Bun.serve()
 */

import fs from "node:fs";
import path from "node:path";
import { PREVIEW_TOKEN_PARAM, PREVIEW_WS_PATH } from "@ceraui/rpc/schemas";
import type { Server } from "bun";

import { logger } from "../helpers/logger.ts";
import { getIsStreaming } from "../modules/streaming/streaming.ts";
import { getLocalObservability } from "../modules/system/observability.ts";
import { getSystemdSocket } from "../modules/system/systemd.ts";
import {
	handleKioskTokenExchange,
	KIOSK_TOKEN_PARAM,
	mintKioskToken,
} from "../modules/ui/kiosk-token.ts";
import { initPreviewSocketData } from "../modules/ui/preview-proxy.ts";
import { createServerWebSocketHandler, initSocketData } from "./adapter.ts";
import { permitsE2eWorkerUpgrade } from "./e2e-worker-admission.ts";
import { issueKioskSessionToken } from "./procedures/auth.procedure.ts";
import type { ServerSocketData } from "./types.ts";

const isDevelopment =
	process.env.NODE_ENV === "development" && !fs.existsSync("public");
const RPC_WS_PATH = "/ws";
const e2eWorkerProxySecret = process.env.E2E_WORKER_PROXY_SECRET;

// MIME type mapping
const mimeTypes: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".webmanifest": "application/manifest+json",
};

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Serve static files from public directory
 */
async function serveStatic(pathname: string): Promise<Response | null> {
	// Normalize path and prevent directory traversal
	const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
	let filePath = path.join("public", safePath);

	// Default to index.html for root or non-file paths
	if (safePath === "/" || safePath === "") {
		filePath = path.join("public", "index.html");
	}

	try {
		const file = Bun.file(filePath);
		const exists = await file.exists();

		if (!exists) {
			// Try with index.html for SPA routing
			const indexPath = path.join("public", "index.html");
			const indexFile = Bun.file(indexPath);
			if (await indexFile.exists()) {
				return new Response(indexFile, {
					headers: { "Content-Type": "text/html" },
				});
			}
			return null;
		}

		return new Response(file, {
			headers: { "Content-Type": getMimeType(filePath) },
		});
	} catch (error) {
		logger.error(`Static file error: ${error}`);
		return null;
	}
}

/**
 * Proxy request to frontend dev server
 */
async function proxyToDevServer(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const targetUrl = `http://localhost:6173${url.pathname}${url.search}`;

	try {
		const proxyRes = await fetch(targetUrl, {
			method: req.method,
			headers: req.headers,
			body: req.body,
		});

		return new Response(proxyRes.body, {
			status: proxyRes.status,
			statusText: proxyRes.statusText,
			headers: proxyRes.headers,
		});
	} catch (error) {
		logger.error(`Proxy error: ${error}`);
		return new Response("Bad Gateway - Frontend dev server not running", {
			status: 502,
		});
	}
}

/**
 * HTTP request handler
 */
async function handleRequest(
	req: Request,
	server: Server<ServerSocketData>,
): Promise<Response> {
	const url = new URL(req.url);

	// Single-use loopback kiosk-token exchange (DC-3): swap the tmpfs token for a
	// session cookie, loopback-only. Returns null when no kiosk_token is present
	// so the request falls through to the normal flow.
	if (req.method === "GET" && url.searchParams.has(KIOSK_TOKEN_PARAM)) {
		const exchange = await handleKioskTokenExchange(
			req,
			server.requestIP(req)?.address,
			issueKioskSessionToken,
		);
		if (exchange) {
			return exchange;
		}
	}

	// Read-only probe for the dev-sync stream-active guard. Intentional exception
	// to the oRPC-only rule: a no-auth, side-effect-free status READ (not control).
	if (req.method === "GET" && url.pathname === "/status") {
		return Response.json({ is_streaming: getIsStreaming() });
	}

	// Local observability surface (Task 26): liveness + frame + SRT + bond rollup
	// reusing the Task 13 health source. LOCAL-ONLY, read-only, no auth — same
	// intentional oRPC-exception class as `/status`. No remote egress.
	if (req.method === "GET" && url.pathname === "/api/health") {
		return Response.json(getLocalObservability());
	}

	// In development, proxy to Vite dev server
	if (isDevelopment) {
		return proxyToDevServer(req);
	}

	// In production, serve static files
	const staticResponse = await serveStatic(url.pathname);
	if (staticResponse) {
		return staticResponse;
	}

	return new Response("Not Found", { status: 404 });
}

// Bun.serve cannot adopt a systemd-inherited fd: it has no `fd` option and
// `unix` is a filesystem path (`unix: "3"` creates a file, not an fd bind). So
// we always bind a real TCP port; the LISTEN_FDS handoff is logged in
// initServer() only. Do NOT re-introduce a `{ fd }` listen target here.
const getListenPorts = (): number[] => {
	const ports: number[] =
		process.env.NODE_ENV === "development"
			? [3002, 8080, 8081]
			: [80, 8080, 81];

	if (process.env.PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		ports.unshift(port);
	}

	return ports;
};

// Server instance
let server: ReturnType<typeof Bun.serve<ServerSocketData>> | null = null;
const listenPorts = getListenPorts();
let currentPortIndex = 0;

/**
 * Start the server on the next available port
 */
function startServer(): void {
	if (currentPortIndex >= listenPorts.length) {
		logger.error("HTTP server: no more ports left to try. Exiting...");
		process.exit(1);
	}

	const port = listenPorts[currentPortIndex];

	logger.info(`HTTP server: trying to start on port ${port}...`);

	try {
		server = Bun.serve<ServerSocketData>({
			...(port !== undefined ? { port } : {}),

			fetch(req, server) {
				// Handle WebSocket upgrade
				const upgradeHeader = req.headers.get("upgrade");
				if (upgradeHeader?.toLowerCase() === "websocket") {
					const requestUrl = new URL(req.url);
					const pathname = requestUrl.pathname;
					if (pathname !== RPC_WS_PATH && pathname !== PREVIEW_WS_PATH) {
						return new Response("WebSocket path not found", { status: 404 });
					}
					if (!permitsE2eWorkerUpgrade(req, e2eWorkerProxySecret)) {
						return new Response("Worker proxy admission required", {
							status: 403,
						});
					}
					// Preview proxy fork — MUST branch on pathname BEFORE the oRPC
					// upgrade, so `/preview` sockets carry a token (validated on open)
					// instead of the RPC auth flags. The route ALWAYS upgrades on a
					// pathname match; the proxy closes with 4401 after the upgrade when
					// the token is invalid — never a pre-upgrade HTTP refusal.
					if (pathname === PREVIEW_WS_PATH) {
						const token =
							requestUrl.searchParams.get(PREVIEW_TOKEN_PARAM) ?? "";
						const previewOk = server.upgrade(req, {
							data: initPreviewSocketData(token),
						});
						if (previewOk) {
							return undefined as unknown as Response;
						}
						return new Response("WebSocket upgrade failed", { status: 500 });
					}

					const success = server.upgrade(req, {
						data: initSocketData(),
					});
					if (success) {
						// Bun automatically returns a 101 Switching Protocols response
						return undefined as unknown as Response;
					}
					return new Response("WebSocket upgrade failed", { status: 500 });
				}

				// Handle HTTP requests
				return handleRequest(req, server);
			},

			websocket: createServerWebSocketHandler(),

			error(error) {
				logger.error(`Server error: ${error}`);
				return new Response("Internal Server Error", { status: 500 });
			},
		});

		const addr = server.url;
		logger.info(`🚀 HTTP server running on ${addr.href}`);

		if (isDevelopment) {
			logger.info(
				"Development mode: Proxying frontend requests to http://localhost:6173",
			);
		} else {
			logger.info("Production mode: Serving static files from ./public");
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("EADDRINUSE")) {
			logger.warn("HTTP server: port already in use, trying the next one...");
			currentPortIndex++;
			startServer();
		} else {
			logger.error(`HTTP server error: ${error}`);
			process.exit(1);
		}
	}
}

/**
 * Initialize and start the HTTP/WebSocket server
 */
export function initServer(): void {
	const systemdSocket = getSystemdSocket();
	if (systemdSocket) {
		logger.warn(
			`systemd socket activation detected (LISTEN_FDS, fd=${systemdSocket.fd}); ` +
				"Bun.serve cannot adopt an inherited socket — binding the listen port directly.",
		);
	}

	// Mint the single-use loopback kiosk token (DC-3) at startup so the image
	// kiosk.service can read it at Chromium launch. tmpfs-only and non-fatal when
	// /run is not writable (e.g. unprivileged dev); skipped in development.
	if (!isDevelopment) {
		void mintKioskToken().catch((error) => {
			logger.warn(`Kiosk: could not mint loopback token: ${error}`);
		});
	}

	startServer();
}

/**
 * Get the current server instance
 */
export function getServer(): typeof server {
	return server;
}

/**
 * Stop the server
 */
export function stopServer(): void {
	if (server) {
		server.stop();
		server = null;
	}
}
