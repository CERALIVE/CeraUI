import { beforeEach, describe, expect, it } from "bun:test";
import {
	getNetifState,
	type NetifDiffEntry,
	onNetifChange,
	reconcileNetif,
	setNetifState,
} from "../modules/network/state/netif-state.ts";
import type { NetifState } from "../modules/network/state-types.ts";

function entry(
	overrides: Partial<NetifState[string]> = {},
): NetifState[string] {
	return {
		ip: "192.168.1.10",
		mac: "aa:bb:cc:dd:ee:ff",
		up: true,
		tp: 0,
		txb: 0,
		error: 0,
		...overrides,
	};
}

describe("netif-state", () => {
	beforeEach(() => {
		// Reset cache + callback between tests so they are independent.
		setNetifState({});
		onNetifChange(() => {});
	});

	it("IP change: same iface, ip field changes -> diff.changed contains iface; callback fired once", () => {
		setNetifState({ eth0: entry({ ip: "192.168.1.10" }) });

		let fireCount = 0;
		let received: NetifDiffEntry[] = [];
		onNetifChange((diff) => {
			fireCount++;
			received = diff.changed;
		});

		setNetifState({ eth0: entry({ ip: "192.168.1.99" }) });

		expect(fireCount).toBe(1);
		expect(received.map((e) => e.name)).toEqual(["eth0"]);
		expect(received[0]?.data.ip).toBe("192.168.1.99");
	});

	it("No spurious change: identical prev+next -> empty diff; callback NOT fired", () => {
		setNetifState({ eth0: entry() });

		let fireCount = 0;
		onNetifChange(() => {
			fireCount++;
		});

		// Set a fresh object with identical field values.
		setNetifState({ eth0: entry() });

		expect(fireCount).toBe(0);

		const diff = reconcileNetif(getNetifState(), { eth0: entry() });
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
	});

	it("Interface added: new iface in next -> diff.added=[newIface]; callback fired", () => {
		setNetifState({ eth0: entry() });

		let fireCount = 0;
		let added: NetifDiffEntry[] = [];
		onNetifChange((diff) => {
			fireCount++;
			added = diff.added;
		});

		setNetifState({ eth0: entry(), wlan0: entry({ ip: "10.0.0.5" }) });

		expect(fireCount).toBe(1);
		expect(added.map((e) => e.name)).toEqual(["wlan0"]);
		expect(added[0]?.data.ip).toBe("10.0.0.5");
	});

	it("Interface removed: iface absent in next -> diff.removed=[removedIface]; callback fired", () => {
		setNetifState({ eth0: entry(), wlan0: entry({ ip: "10.0.0.5" }) });

		let fireCount = 0;
		let removed: NetifDiffEntry[] = [];
		onNetifChange((diff) => {
			fireCount++;
			removed = diff.removed;
		});

		setNetifState({ eth0: entry() });

		expect(fireCount).toBe(1);
		expect(removed.map((e) => e.name)).toEqual(["wlan0"]);
	});

	it("Error flag change: error field changes -> diff.changed", () => {
		setNetifState({ eth0: entry({ error: 0 }) });

		let fireCount = 0;
		let changed: NetifDiffEntry[] = [];
		onNetifChange((diff) => {
			fireCount++;
			changed = diff.changed;
		});

		setNetifState({ eth0: entry({ error: 1 }) });

		expect(fireCount).toBe(1);
		expect(changed.map((e) => e.name)).toEqual(["eth0"]);
		expect(changed[0]?.data.error).toBe(1);
	});

	it("reconcileNetif is pure: does not fire callbacks", () => {
		let fireCount = 0;
		onNetifChange(() => {
			fireCount++;
		});

		const diff = reconcileNetif(
			{ eth0: entry({ ip: "1.1.1.1" }) },
			{ eth0: entry({ ip: "2.2.2.2" }) },
		);

		expect(fireCount).toBe(0);
		expect(diff.changed.map((e) => e.name)).toEqual(["eth0"]);
	});
});
