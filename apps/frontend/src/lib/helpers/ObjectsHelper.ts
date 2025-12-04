import type { Modem, ModemList } from "@ceraui/rpc/schemas";

function isObject(item: unknown): item is Record<string, unknown> {
	return item !== null && typeof item === "object" && !Array.isArray(item);
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
				deepMergeModem(target[key] as Modem, source[key] as Modem);
			} else {
				Object.assign(target, { [key]: source[key] });
			}
		}
	}

	return mergeModems(target, ...sources);
}

function deepMergeModem(target: Modem, source: Modem): Modem {
	for (const key in source) {
		const sourceValue = source[key as keyof Modem];
		if (sourceValue !== undefined && isObject(sourceValue)) {
			const targetValue = target[key as keyof Modem];
			if (!targetValue) {
				Object.assign(target, { [key]: {} });
			}
			Object.assign(target[key as keyof Modem] as object, sourceValue);
		} else if (sourceValue !== undefined) {
			Object.assign(target, { [key]: sourceValue });
		}
	}
	return target;
}

export function deepMerge<T extends Record<string, unknown>>(
	target: T,
	...sources: T[]
): T {
	if (!sources.length) return target;
	const source = sources.shift();

	if (isObject(target) && isObject(source)) {
		for (const key in source) {
			if (isObject(source[key])) {
				if (!target[key]) Object.assign(target, { [key]: {} });
				deepMerge(
					target[key] as Record<string, unknown>,
					source[key] as Record<string, unknown>,
				);
			} else {
				Object.assign(target, { [key]: source[key] });
			}
		}
	}
	return deepMerge(target, ...sources);
}
