export interface ScannedFile {
	readonly path: string;
	readonly source: string;
}

/** The module that is ALLOWED to express the collapse — the one authority. */
export const AUTHORITY = "lib/modem/sections/derive.ts";

/**
 * A hand-rolled `boolean -> {mode}` adapter, in either quote style and with
 * either arm first. Whitespace-insensitive so a formatter cannot disarm it.
 */
const ADAPTER_RE =
	/\{\s*mode\s*:\s*['"](?:available|absent)['"]\s*\}\s*:\s*\{\s*mode\s*:\s*['"](?:available|absent)['"]\s*\}/;

export function scanForReadingViewCopies(
	files: readonly ScannedFile[],
): string[] {
	return files
		.filter(
			(file) =>
				file.path !== AUTHORITY && ADAPTER_RE.test(stripComments(file.source)),
		)
		.map((file) => file.path);
}

/**
 * Remove `//`, block and HTML comments so the modules above can keep explaining
 * the rule in prose without tripping the gate that enforces it.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
