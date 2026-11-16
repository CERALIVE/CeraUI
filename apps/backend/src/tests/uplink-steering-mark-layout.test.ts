import { expect, test } from "bun:test";
import {
	markForSlot,
	slotForManagedTable,
} from "../modules/network/uplink-steering/mark-layout.ts";
import { isManagedUplinkTable } from "../modules/network/uplink-steering/route-manager.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

test.each([
	["cellular-a", 3401409536],
	["wifi-image-table", 3390952960],
	["wwan-managed-table", 3404882944],
	["zero-slot-45713", 3388997888],
] as const)("preserves deployed mark for %s", (identity, mark) => {
	expect(stableUplinkMark(identity)).toBe(mark);
});

test.each([
	["29999", false],
	["30000", true],
	["30001", true],
	["95535", true],
	["95536", false],
	["main", false],
] as const)(
	"preserves inclusive managed ownership boundary %s",
	(table, managed) => {
		expect(isManagedUplinkTable(table)).toBe(managed);
	},
);

test.each([
	["29999", undefined],
	["30000", undefined],
	["30001", 1],
	["95535", 65535],
	["95536", undefined],
	["main", undefined],
] as const)("allocates only nonzero managed slot for %s", (table, slot) => {
	expect(slotForManagedTable(table)).toBe(slot);
});

test("slot zero remaps to the first usable mark", () => {
	expect(markForSlot(0)).toBe(3388997888);
	expect(markForSlot(1)).toBe(3388997888);
	expect(markForSlot(65535)).toBe(3405774592);
});
