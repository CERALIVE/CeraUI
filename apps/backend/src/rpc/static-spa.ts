import path from "node:path";

import { logger } from "../helpers/logger.ts";

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

export async function serveStatic(pathname: string): Promise<Response | null> {
	const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
	const indexPath = path.join("public", "index.html");
	const filePath =
		safePath === "/" || safePath === ""
			? indexPath
			: path.join("public", safePath);

	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			const indexFile = Bun.file(indexPath);
			if (await indexFile.exists()) {
				return new Response(indexFile, {
					headers: { "Content-Type": "text/html" },
				});
			}
			return null;
		}

		return new Response(file, {
			headers: {
				"Content-Type":
					mimeTypes[path.extname(filePath).toLowerCase()] ||
					"application/octet-stream",
			},
		});
	} catch (error) {
		logger.error(`Static file error: ${error}`);
		return null;
	}
}
