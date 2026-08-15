import { mkdir, readdir, rename } from "node:fs/promises";
import * as path from "node:path";

/**
 * Per-artifact sourcemap policy — the SPA half.
 *
 * The device SPA is built with `sourcemap: "hidden"`: maps ARE produced (so a
 * production stack trace from a device can still be symbolicated locally) but
 * carry no `//# sourceMappingURL` comment, and they are moved OUT of the build
 * output before packaging. `scripts/build/build-debian-package.sh` copies
 * `dist/public/*` verbatim into `/var/www/ceralive`, so anything left beside the
 * bundles ships to every device — a map is the original TypeScript/Svelte source
 * of the whole control plane, served unauthenticated by the same static handler.
 *
 * The relocation target is a SIBLING of the packaged tree (`dist/sourcemaps/`),
 * never a subdirectory of it, because the packaging copy is a recursive glob.
 */
export const SPA_SOURCEMAP_OUT_DIR = "sourcemaps";

/** Maps moved out of `outDir`, as paths relative to `outDir`. */
export async function relocateSourcemaps(
	outDir: string,
	mapDir: string,
): Promise<string[]> {
	const moved: string[] = [];

	const walk = async (relative: string): Promise<void> => {
		const entries = await readdir(path.join(outDir, relative), {
			withFileTypes: true,
		});
		for (const entry of entries) {
			const entryRelative = path.join(relative, entry.name);
			if (entry.isDirectory()) {
				await walk(entryRelative);
				continue;
			}
			if (!entry.name.endsWith(".map")) continue;

			const target = path.join(mapDir, entryRelative);
			await mkdir(path.dirname(target), { recursive: true });
			await rename(path.join(outDir, entryRelative), target);
			moved.push(entryRelative);
		}
	};

	await walk(".");
	return moved;
}

export interface SourcemapRelocationOptions {
	outDir: string;
	mapDir: string;
	enabled: boolean;
}

/**
 * Moves every emitted `.map` out of the SPA build output once the bundle is
 * closed.
 *
 * `order: "post"` is load-bearing, not decoration: `vite-plugin-pwa` writes
 * `sw.js` + `workbox-*.js` and THEIR maps from its own `closeBundle`, which is
 * already a post hook — so a normal-order hook runs first and misses them
 * (measured: 36 maps relocated, 2 left behind and packaged).
 */
export function spaSourcemapRelocationPlugin(
	options: SourcemapRelocationOptions,
): {
	name: string;
	closeBundle: { order: "post"; handler(): Promise<void> };
} {
	return {
		name: "ceraui:relocate-spa-sourcemaps",
		closeBundle: {
			order: "post",
			async handler(): Promise<void> {
				if (!options.enabled) return;
				const moved = await relocateSourcemaps(options.outDir, options.mapDir);
				if (moved.length > 0) {
					console.info(
						`[ceraui] moved ${moved.length} sourcemap(s) out of the packaged SPA into ${options.mapDir}`,
					);
				}
			},
		},
	};
}
