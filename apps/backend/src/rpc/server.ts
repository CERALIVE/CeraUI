/**
 * Bun Native Server
 * HTTP and WebSocket server using Bun.serve()
 */
import fs from "node:fs";
import path from "node:path";

import { logger } from "../helpers/logger.ts";
import { getSystemdSocket } from "../modules/system/systemd.ts";
import { createWebSocketHandler, initSocketData } from "./adapter.ts";
import type { SocketData } from "./types.ts";

const isDevelopment =
	process.env.NODE_ENV === "development" && !fs.existsSync("public");

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
async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

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

// Port configuration
const getListenPorts = (): Array<number | { fd: number }> => {
	const ports: Array<number | { fd: number }> =
		process.env.NODE_ENV === "development"
			? [3002, 8080, 8081]
			: [80, 8080, 81];

	if (process.env.PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		ports.unshift(port);
	}

	const systemdSock = getSystemdSocket();
	if (systemdSock) {
		ports.unshift(systemdSock);
	}

	return ports;
};

// Server instance
let server: ReturnType<typeof Bun.serve<SocketData>> | null = null;
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

	const portOrHandle = listenPorts[currentPortIndex];
	const isPort = typeof portOrHandle === "number";
	const desc = isPort ? `port ${portOrHandle}` : "the systemd socket";

	logger.info(`HTTP server: trying to start on ${desc}...`);

	try {
		server = Bun.serve<SocketData>({
			port: isPort ? portOrHandle : undefined,
			unix: !isPort
				? (portOrHandle as { fd: number }).fd.toString()
				: undefined,

			fetch(req, server) {
				// Handle WebSocket upgrade
				const upgradeHeader = req.headers.get("upgrade");
				if (upgradeHeader?.toLowerCase() === "websocket") {
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
				return handleRequest(req);
			},

			websocket: createWebSocketHandler(),

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
