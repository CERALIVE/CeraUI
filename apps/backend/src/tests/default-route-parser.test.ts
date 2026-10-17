import { describe, expect, test } from "bun:test";
import { setDefaultRoute } from "../modules/network/default-route.ts";
import { readDefaultRoutes } from "../modules/network/default-route-model.ts";
import { DefaultRouteTable } from "./helpers/default-route-table.ts";

const OWNED = "default dev modem0 proto 242 metric 0";
const FOREIGN = "default dev eth0 proto 16 metric 0";
const MODEM = "default dev modem0 proto 16 metric 702";

describe("owned-route parsing boundary", () => {
	for (const suffix of [
		"realm -1",
		"realm 65536",
		"realms 5/bad",
		"classid 1",
		"mtu 1400",
		"metric 2",
		"pref high",
		"scope 200",
	]) {
		test(`owned-looking unwritten ${suffix} is refused without a broadened delete`, async () => {
			// Given: unknown or contradictory attributes cannot be safely projected.
			const row = `${OWNED} ${suffix}`;
			const table = new DefaultRouteTable([row, FOREIGN, MODEM], [], "host");
			// When: acquisition parses the owned-looking row.
			await expect(
				setDefaultRoute("modem0", { runner: table.runner }),
			).rejects.toMatchObject({ reason: "invalid-route" });
			// Then: no command could silently broaden its deletion identity.
			expect(table.mutations).toEqual([]);
			expect(() => readDefaultRoutes(row, 4)).toThrow();
		});
	}
});
