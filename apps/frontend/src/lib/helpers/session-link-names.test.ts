import { describe, expect, it } from "vitest";

import { createSessionLinkNames } from "./session-link-names";

describe("createSessionLinkNames", () => {
	it("keeps each link's names in order and drops repeats of the last one", () => {
		const names = createSessionLinkNames();
		names.record("wwan0", "SIM 1 · Northwind");
		names.record("wwan0", "SIM 1 · Northwind");
		names.record("wwan0", "SIM 1 · Harbor Cell");
		names.record("wwan0", "SIM 1 · Northwind");
		expect(names.snapshot().get("wwan0")).toEqual([
			"SIM 1 · Northwind",
			"SIM 1 · Harbor Cell",
			"SIM 1 · Northwind",
		]);
	});

	it("treats interfaces named like object properties as plain keys", () => {
		const names = createSessionLinkNames();
		for (const iface of [
			"constructor",
			"__proto__",
			"toString",
			"hasOwnProperty",
		]) {
			expect(() => names.record(iface, `${iface} link`)).not.toThrow();
			names.record(iface, `${iface} link`);
		}
		const snapshot = names.snapshot();
		expect([...snapshot.keys()]).toEqual([
			"constructor",
			"__proto__",
			"toString",
			"hasOwnProperty",
		]);
		expect(snapshot.get("constructor")).toEqual(["constructor link"]);
		expect(snapshot.get("__proto__")).toEqual(["__proto__ link"]);
	});

	it("hands out a copy that later records do not change", () => {
		const names = createSessionLinkNames();
		names.record("usb0", "USB tether");
		const before = names.snapshot();
		names.record("usb0", "SIM 2");
		names.record("eth0", "Ethernet");
		expect(before.get("usb0")).toEqual(["USB tether"]);
		expect(before.has("eth0")).toBe(false);
	});
});
