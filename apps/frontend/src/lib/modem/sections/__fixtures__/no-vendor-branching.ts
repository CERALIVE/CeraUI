/**
 * Test-only scanner vocabulary; excluded from the shipped-source sweep.
 * Matching is case-insensitive and substring-based on purpose.
 */
const BANNED = [
	"huawei",
	"zte",
	"himi",
	"ufi",
	"hilink",
	"quectel",
	"simcom",
	"fibocom",
	"mm-managed",
	"router-ethernet",
	"unrecognized",
	"unrecognised",
	"unmanaged",
] as const;

export interface ScannedFile {
	readonly path: string;
	readonly source: string;
}

interface Violation {
	readonly path: string;
	readonly token: string;
}

/**
 * Remove `//` line comments, `/* *\/` block comments and `<!-- -->` HTML
 * comments. Deliberately simple: it can over-strip a `//` inside a string
 * literal, which makes the gate MORE permissive about prose and no less strict
 * about code — a family branch cannot hide inside a URL.
 */
export function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function scanForFamilyBranching(
	files: readonly ScannedFile[],
): Violation[] {
	const violations: Violation[] = [];
	for (const file of files) {
		const code = stripComments(file.source).toLowerCase();
		for (const token of BANNED) {
			if (code.includes(token)) violations.push({ path: file.path, token });
		}
	}
	return violations;
}
