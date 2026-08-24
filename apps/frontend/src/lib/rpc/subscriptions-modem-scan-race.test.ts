import type { ModemList } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { mergeModemList } from "./subscriptions.svelte";

function row(generation: number, operator: string): ModemList {
	return {
		"7": {
			ifname: "wwan0",
			name: "modem",
			network_type: { supported: ["4g"], active: "4g" },
			available_networks: { [operator]: { name: operator } },
			network_scan: { generation, phase: "completed" },
		},
	};
}

describe("modem scan generation fencing", () => {
	it("keeps newer networks when an older scan result arrives later", () => {
		const newer = mergeModemList(undefined, row(20, "new"));
		const afterLateOlder = mergeModemList(newer, row(19, "old"));

		expect(afterLateOlder["7"]?.available_networks).toEqual({
			new: { name: "new" },
		});
		expect(afterLateOlder["7"]?.network_scan?.generation).toBe(20);
	});
});

describe("full modem descriptor retractions", () => {
	it("clears a stale SIM lock when the next full descriptor omits it", () => {
		// Given a full modem descriptor that reports a blocking SIM lock.
		const locked = mergeModemList(undefined, {
			"7": {
				ifname: "wwan0",
				name: "modem",
				network_type: { supported: ["4g"], active: "4g" },
				sim_lock: { required: "sim-pin", remainingAttempts: 3 },
			},
		});

		// When the authoritative full descriptor no longer carries that field.
		const unlocked = mergeModemList(locked, {
			"7": {
				ifname: "wwan0",
				name: "modem",
				network_type: { supported: ["4g"], active: "4g" },
			},
		});

		// Then omission retracts the previous optional lock state.
		expect(unlocked["7"]?.sim_lock).toBeUndefined();
	});
});
