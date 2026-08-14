// @vitest-environment jsdom
import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import {
	getProbe,
	PERSIST_PROBE_KEY,
	PROBE_AT_MODULE_LOAD,
	setProbe,
	UNWRITTEN,
} from "./__fixtures__/persist-isolation-store.svelte";
import {
	BLEED_SETTLE_MS,
	markerKey,
	settle,
} from "./persist-isolation-contract";

const OWN = "spec-a";
const SIBLING = "spec-b";

describe("$persist storage isolation — spec A", () => {
	it("loads its key at the declared default, never a sibling spec's write", () => {
		expect(PROBE_AT_MODULE_LOAD).toBe(UNWRITTEN);
		expect(getProbe()).toBe(UNWRITTEN);
	});

	it("keeps its own write while spec B writes the same key concurrently", async () => {
		localStorage.setItem(markerKey(OWN), "1");
		setProbe(OWN);
		flushSync();

		expect(localStorage.getItem(PERSIST_PROBE_KEY)).toBe(JSON.stringify(OWN));

		await settle(BLEED_SETTLE_MS);

		expect(localStorage.getItem(markerKey(SIBLING))).toBeNull();
		expect(localStorage.getItem(PERSIST_PROBE_KEY)).toBe(JSON.stringify(OWN));
		expect(getProbe()).toBe(OWN);
	});

	it("still hydrates from a key already present in storage", async () => {
		localStorage.setItem(PERSIST_PROBE_KEY, JSON.stringify("seeded"));
		vi.resetModules();

		const reloaded = await import(
			"./__fixtures__/persist-isolation-store.svelte"
		);

		expect(reloaded.PROBE_AT_MODULE_LOAD).toBe("seeded");
	});
});
