import type { DeviceEvent } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { BOOT_IDS } from "./__fixtures__/boots";
import { EVENT_AT, event } from "./__fixtures__/events";
import { modemNames, timelineGroups } from "./timeline-groups";

const e = (seq: number, extra: Partial<DeviceEvent> = {}) =>
	event(seq, "internet_lost", {}, extra);

describe("timelineGroups", () => {
	it("groups consecutive events by boot, newest first, with keys unique even if a boot recurs", () => {
		const groups = timelineGroups([
			e(5),
			e(4),
			e(3, { bootId: BOOT_IDS.clean }),
			e(2, { bootId: BOOT_IDS.clean }),
			e(1),
		]);

		expect(
			groups.map((group) => [
				group.bootId,
				group.items.map((item) => item.kind),
			]),
		).toEqual([
			[BOOT_IDS.current, ["event", "event"]],
			[BOOT_IDS.clean, ["event", "event"]],
			[BOOT_IDS.current, ["event"]],
		]);
		expect(new Set(groups.map((group) => group.key)).size).toBe(3);
		expect(groups[0]?.key).toBe(`${BOOT_IDS.current}-${e(5).id}`);
	});

	it("marks where the device clock ran backwards between two records of one boot", () => {
		const groups = timelineGroups([
			e(4, { at: EVENT_AT + 10 }),
			e(3, { at: EVENT_AT + 50 }),
			e(2, { at: EVENT_AT + 50 }),
			e(1, { at: EVENT_AT + 900, bootId: BOOT_IDS.clean }),
		]);

		expect(groups[0]?.items).toEqual([
			{ kind: "event", key: e(4).id, event: e(4, { at: EVENT_AT + 10 }) },
			{ kind: "clock", key: `clock-${e(3).id}` },
			{ kind: "event", key: e(3).id, event: e(3, { at: EVENT_AT + 50 }) },
			{ kind: "event", key: e(2).id, event: e(2, { at: EVENT_AT + 50 }) },
		]);
		expect(groups[1]?.items.map((item) => item.kind)).toEqual(["event"]);
	});

	it("returns nothing for no events", () => {
		expect(timelineGroups([])).toEqual([]);
	});
});

describe("modemNames", () => {
	it("takes each modem's newest recorded name from its added and removed records", () => {
		const names = modemNames([
			event(4, "modem_connected", { modemKey: "k1", roaming: false }),
			event(3, "modem_removed", { modemKey: "k1", name: "EM12 (new)" }),
			event(2, "modem_added", { modemKey: "k1", name: "EM12 (old)" }),
			event(1, "modem_added", { modemKey: "k2", name: "RM520" }),
			event(0, "link_up", { modemKey: "k3", name: "not a modem record" }),
			event(0, "modem_added", { modemKey: 5, name: "bad key" }),
			event(0, "modem_added", { modemKey: "k4", name: 7 }),
		]);

		expect([...names]).toEqual([
			["k1", "EM12 (new)"],
			["k2", "RM520"],
		]);
	});
});
