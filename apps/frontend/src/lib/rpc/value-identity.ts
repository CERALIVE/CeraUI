/**
 * value-identity — structural identity preservation for wire payloads.
 *
 * Every broadcast arrives `JSON.parse`d, so a modem or an interface whose
 * fields did not change still lands as a brand-new object graph. Reference
 * equality therefore answers "is this a different MESSAGE", never "is this
 * different DATA" — and a store that republishes the fresh object on every
 * tick invalidates every `$derived` beneath it five seconds at a time, on a
 * page where nothing happened. Comparing by VALUE and republishing the
 * PREVIOUS object is what turns an unchanged tick back into a no-op.
 *
 * Scope is deliberate and bounded: these values are Zod-parsed plain JSON, so
 * there are no cycles, no class instances and no functions to reason about.
 */

/** Value-equality over a plain-JSON graph (objects, arrays, primitives). */
export function isSameWireValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
			return false;
		}
		return a.every((item, index) => isSameWireValue(item, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every(
		(key) =>
			Object.hasOwn(right, key) && isSameWireValue(left[key], right[key]),
	);
}

/**
 * Return `previous` when `candidate` carries the same value, so an unchanged
 * entry keeps its object reference across ticks.
 */
export function preserveWireIdentity<T>(
	previous: T | undefined,
	candidate: T,
): T {
	return previous !== undefined && isSameWireValue(previous, candidate)
		? previous
		: candidate;
}
