import { readSystemBootId } from "../streaming/armed-stream-marker.ts";

export function normalizeBootId(raw: string): string | undefined {
	const id = raw.replace(/-/g, "").toLowerCase();
	return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

export function currentBootId(read = readSystemBootId): string | undefined {
	const raw = read();
	return raw === undefined ? undefined : normalizeBootId(raw);
}
