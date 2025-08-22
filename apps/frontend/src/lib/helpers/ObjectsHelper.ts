import type { ModemList } from "$lib/types/socket-messages";

function isObject(item: unknown) {
	return item && typeof item === "object" && !Array.isArray(item);
}

export function mergeModems(
	target: ModemList,
	...sources: ModemList[]
): ModemList {
	if (!sources.length) return target;
	const source = sources.shift();

	if (isObject(target) && isObject(source)) {
		// Remove keys from target that don't exist in source
		if (source) {
			for (const key in target) {
				if (!(key in source)) {
					delete target[key];
				}
			}
		}

		// Merge remaining keys
		for (const key in source) {
			if (isObject(source[key])) {
				if (!target[key]) Object.assign(target, { [key]: {} });
				deepMerge(target[key], source[key]);
			} else {
				Object.assign(target, { [key]: source[key] });
			}
		}
	}

	return deepMerge(target, ...sources);
}

export function deepMerge(
	target: Record<string, unknown>,
	...sources: Record<string, unknown>[]
): Record<string, unknown> {
	if (!sources.length) return target;
	const source = sources.shift();

	if (isObject(target) && isObject(source)) {
		for (const key in source) {
			if (isObject(source[key])) {
				if (!target[key]) Object.assign(target, { [key]: {} });
				deepMerge(target[key], source[key]);
			} else {
				Object.assign(target, { [key]: source[key] });
			}
		}
	}
	return deepMerge(target, ...sources);
}
