import "svelte-persistent-runes";

/**
 * A real `$persist` store (compiled by the `persistPlugin` in vitest.config.ts,
 * exactly like `display-profile.svelte.ts`) shared by the two
 * `persist-isolation-*.test.ts` spec files. Both import THIS key, so any storage
 * shared between spec files — a `--localstorage-file` path, a hoisted singleton —
 * shows up as one spec reading the other's value.
 */
export const PERSIST_PROBE_KEY = "persist-isolation-probe";

export const UNWRITTEN = "unwritten";

let probe = $persist<string>(UNWRITTEN, PERSIST_PROBE_KEY);

export function getProbe(): string {
	return probe;
}

export const PROBE_AT_MODULE_LOAD = getProbe();

export function setProbe(next: string): void {
	probe = next;
}
