/**
 * Paraglide safe-module-id mirror + the collision pre-flight built on it.
 *
 * Paraglide writes one `messages/<safeModuleId>.js` per bundle and has NO
 * collision detection — two dotted keys that map to the same module id make a
 * later bundle SILENTLY overwrite an earlier one, with no warning from the
 * compiler. So we mirror its id function byte-for-byte and refuse to compile a
 * key set that is not injective under it.
 *
 * A mirror is only trustworthy while it still matches the real thing:
 * `tests/paraglide-catalog-gate.test.ts` diffs `toSafeModuleId` against the
 * module names paraglide actually emitted.
 */

/** Byte-mirror of paraglide 2.23.2 `toSafeModuleId` (compiler/safe-module-id.js). */
export function toSafeModuleId(id: string): string {
	const result = id.toLowerCase().replace(/[^a-z0-9_]/g, "_");
	if (/[0-9]/.test(result[0] ?? "")) return `_${result}`;
	if (RESERVED_JS_KEYWORDS.has(result)) return `_${result}`;
	const uppercase = id.match(/[A-Z]/g)?.length ?? 0;
	return uppercase > 0 ? `${result}${uppercase}` : result;
}

const RESERVED_JS_KEYWORDS = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default",
	"delete", "do", "else", "export", "extends", "false", "finally", "for",
	"function", "if", "import", "in", "instanceof", "new", "null", "return",
	"super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
	"while", "with", "let", "static", "yield", "await", "enum", "implements",
	"interface", "package", "private", "protected", "public", "then",
]);

/**
 * SAFE-MODULE-ID PRE-FLIGHT. Runs before any compile; returns the
 * key -> module-id map.
 */
export function assertInjectiveModuleIds(keys: readonly string[]): Map<string, string> {
	const byModuleId = new Map<string, string>();
	const map = new Map<string, string>();
	for (const key of [...keys].sort()) {
		const moduleId = toSafeModuleId(key);
		const clash = byModuleId.get(moduleId);
		if (clash !== undefined) {
			throw new Error(
				`safe-module-id collision: "${clash}" and "${key}" both map to "${moduleId}". ` +
					"Paraglide would silently drop one of them. Disambiguate the inlang BUNDLE ID " +
					"(suffix) while keeping the dotted key as the registry/API key.",
			);
		}
		byModuleId.set(moduleId, key);
		map.set(key, moduleId);
	}
	return map;
}
