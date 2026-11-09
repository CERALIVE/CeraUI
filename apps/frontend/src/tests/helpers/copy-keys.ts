/** Return missing string leaves from a re-nested catalog. */
export function missingCopyKeys(
	catalog: unknown,
	keys: readonly string[],
): string[] {
	return keys.filter((key) => typeof lookup(catalog, key) !== "string");
}

/** Resolve a dotted key against the re-nested catalog tree. */
export function lookup(catalog: unknown, key: string): unknown {
	let cursor: unknown = catalog;
	for (const segment of key.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}
