import { describe, expect, it } from "vitest";

import { activeTab, downloadsPlacement, shellTabs } from "./shell-layout";

describe("shellTabs", () => {
	it("has Events and Raw logs when the side column holds Storage", () => {
		expect(shellTabs(true)).toEqual(["events", "raw"]);
	});

	it("adds a Storage tab when there is no side column", () => {
		expect(shellTabs(false)).toEqual(["events", "raw", "storage"]);
	});
});

describe("activeTab", () => {
	it.each(["events", "raw"])("keeps %s on every layout", (tab) => {
		expect(activeTab(tab, shellTabs(true))).toBe(tab);
		expect(activeTab(tab, shellTabs(false))).toBe(tab);
	});

	it("keeps Storage while it is a tab", () => {
		expect(activeTab("storage", shellTabs(false))).toBe("storage");
	});

	it("opens on Events before any tab was chosen", () => {
		expect(activeTab(undefined, shellTabs(true))).toBe("events");
		expect(activeTab(undefined, shellTabs(false))).toBe("events");
	});

	it("falls back to Events when Storage moves into the side column", () => {
		expect(activeTab("storage", shellTabs(true))).toBe("events");
	});

	it.each(["", "Events", "timeline", " raw"])(
		"falls back to Events for a value that is not a tab: %j",
		(value) => {
			expect(activeTab(value, shellTabs(false))).toBe("events");
		},
	);
});

describe("downloadsPlacement", () => {
	it.each(["loading", "ready", "failed"] as const)(
		"puts Downloads in the side column on a wide screen (%s)",
		(status) => {
			expect(downloadsPlacement(status, true)).toBe("side");
		},
	);

	it.each([true, false])(
		"puts Downloads below the not-available notice, as its copy says (wide=%s)",
		(wide) => {
			expect(downloadsPlacement("unavailable", wide)).toBe("main");
		},
	);

	it("puts Downloads in the Storage tab once the tabs render", () => {
		expect(downloadsPlacement("ready", false)).toBe("storage");
	});

	it.each(["loading", "unavailable", "failed"] as const)(
		"keeps Downloads in the main column while the tabs are absent (%s)",
		(status) => {
			expect(downloadsPlacement(status, false)).toBe("main");
		},
	);
});
