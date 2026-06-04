import { describe, expect, it } from "vitest";

import { navElements } from "$lib/config";
import LiveView from "$main/LiveView.svelte";

import { getNavFromHash } from "./NavigationHelper";

// The Live destination must resolve to LiveView on every entry path:
// explicit hash, no hash (fallback), and unmatched hash. Historically the
// fallback and initial state pointed at the legacy Streaming tab, which stuck
// on first paint at #live because of the same-key guard in navigateTo.
describe("getNavFromHash", () => {
	it("resolves #live to the LiveView component", () => {
		const nav = getNavFromHash({ customHash: "#live" });
		const [identifier] = Object.keys(nav);

		expect(identifier).toBe("live");
		expect(nav.live.component).toBe(LiveView);
		expect(nav.live.component).toBe(navElements.live.component);
	});

	it("falls back to LiveView when no hash is present", () => {
		const nav = getNavFromHash({ customHash: "" });
		const [identifier] = Object.keys(nav);

		expect(identifier).toBe("live");
		expect(nav.live.component).toBe(LiveView);
		expect(nav.live.component).toBe(navElements.live.component);
	});

	it("falls back to LiveView for an unmatched hash", () => {
		const nav = getNavFromHash({ customHash: "#bogus" });
		const [identifier] = Object.keys(nav);

		expect(identifier).toBe("live");
		expect(nav.live.component).toBe(LiveView);
		expect(nav.live.component).toBe(navElements.live.component);
	});
});
